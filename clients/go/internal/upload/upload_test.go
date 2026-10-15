package upload

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func testConfig(endpoint string) Config {
	return Config{Endpoint: endpoint, UploadToken: "tb_test_token", RetryDelayMs: 1}
}

func baseSnapshot(model string, total int64) contract.Snapshot {
	return contract.Snapshot{
		Source:      contract.SourceCodex,
		UsageDate:   "2026-05-09",
		Timezone:    "Asia/Shanghai",
		Model:       model,
		InputTokens: 10, OutputTokens: 2, TotalTokens: total, CacheRead: 5,
		CostUSD: 0.01, SessionCount: 1,
		CollectedAt: "2026-05-09T10:00:00.000Z",
	}
}

func TestSnapshotHashIsSHA256OfHashPayload(t *testing.T) {
	// Known-answer cross-checked against the TypeScript implementation:
	// sha256 of the exact golden "base" payload.
	snapshot := baseSnapshot("gpt-5", 17)
	const want = "de8928257c1bb02860b1f57925ebd7de1c9a2b500554c06ec6e1834c5c3fc30e"
	if got := SnapshotHash(snapshot); got != want {
		t.Errorf("hash = %s, want %s", got, want)
	}
}

func TestUploadEmptySnapshotsPostsOneEmptyBatch(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), nil, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 0 || result.Skipped != 0 {
		t.Errorf("result %+v", result)
	}
	if len(bodies) != 1 {
		t.Fatalf("requests = %d, want 1", len(bodies))
	}
	snapshots, ok := bodies[0]["snapshots"].([]any)
	if !ok || len(snapshots) != 0 {
		t.Errorf("empty batch shape wrong: %v", bodies[0])
	}
}

func TestUploadSkipsUnchangedViaCheck(t *testing.T) {
	var upserts int
	var checkedKeys int
	unchanged := baseSnapshot("gpt-5", 17)
	changed := baseSnapshot("gpt-5.6-sol", 42)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/check"):
			var body struct {
				Keys []struct{ Source, UsageDate, Model string } `json:"keys"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			checkedKeys += len(body.Keys)
			// Report the unchanged snapshot as already stored with the
			// current hash; the changed one is absent (or stale).
			_ = json.NewEncoder(w).Encode(map[string]any{
				"existing": []map[string]any{{
					"source": unchanged.Source, "usageDate": unchanged.UsageDate,
					"model": unchanged.Model, "snapshotHash": SnapshotHash(unchanged),
				}},
			})
		default:
			var body struct {
				Snapshots []contract.Snapshot `json:"snapshots"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			upserts += len(body.Snapshots)
			_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
		}
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{unchanged, changed}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 || result.Upserted != 1 {
		t.Errorf("result %+v, want upserted 1 skipped 1", result)
	}
	if upserts != 1 || checkedKeys != 2 {
		t.Errorf("upserts=%d checked=%d", upserts, checkedKeys)
	}
}

func TestUploadTreatsUnsupportedCheckAsAllChanged(t *testing.T) {
	var upserts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		upserts += len(body.Snapshots)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 1 || result.Skipped != 0 {
		t.Errorf("result %+v", result)
	}
	if upserts != 1 {
		t.Errorf("upserts %d", upserts)
	}
}

func TestUploadRetriesTransientStatusThenSucceeds(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		if attempts.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 1 || attempts.Load() != 2 {
		t.Errorf("upserted=%d attempts=%d", result.Upserted, attempts.Load())
	}
}

func TestUploadFailsAfterExhaustingRetries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("want 502 failure, got %v", err)
	}
}

func TestUploadDoesNotRetryNonTransient4xx(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		attempts.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401 failure, got %v", err)
	}
	if attempts.Load() != 1 {
		t.Errorf("401 must not be retried, attempts=%d", attempts.Load())
	}
}

func TestUploadRejectsMalformedResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		_, _ = io.WriteString(w, `{"upserted":"many"}`)
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err == nil {
		t.Fatal("malformed response must fail")
	}
}

func TestUploadChunksAtThirty(t *testing.T) {
	var batchSizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		batchSizes = append(batchSizes, len(body.Snapshots))
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
	defer server.Close()

	snapshots := make([]contract.Snapshot, 65)
	for i := range snapshots {
		snapshots[i] = baseSnapshot("model-"+string(rune('a'+i%26)), int64(10+i))
	}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), snapshots, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 65 {
		t.Errorf("upserted %d", result.Upserted)
	}
	want := []int{30, 30, 5}
	if len(batchSizes) != len(want) {
		t.Fatalf("batches %v, want %v", batchSizes, want)
	}
	for i := range want {
		if batchSizes[i] != want[i] {
			t.Errorf("batch %d size %d, want %d", i, batchSizes[i], want[i])
		}
	}
}

func TestBackoffPausesAfterFiveConsecutiveFailures(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		state := RecordFailure(dir, os.ErrPermission, now)
		if state.ConsecutiveFailures != i+1 {
			t.Fatalf("failure %d recorded as %d", i+1, state.ConsecutiveFailures)
		}
		if _, paused := IsPaused(dir, now); paused {
			t.Fatalf("paused early at failure %d", i+1)
		}
	}
	state := RecordFailure(dir, os.ErrPermission, now)
	if state.ConsecutiveFailures != 5 {
		t.Fatalf("5th failure = %d", state.ConsecutiveFailures)
	}
	pausedUntil, paused := IsPaused(dir, now)
	if !paused {
		t.Fatal("must pause after 5 consecutive failures")
	}
	if until, _ := time.Parse(time.RFC3339, pausedUntil); until.Sub(now) != 24*time.Hour {
		t.Errorf("pause window %v", until.Sub(now))
	}
	// Pause expires on its own.
	if _, paused := IsPaused(dir, now.Add(25*time.Hour)); paused {
		t.Error("pause must expire")
	}
}

func TestBackoffSuccessClearsState(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	RecordFailure(dir, os.ErrPermission, now)
	RecordSuccess(dir)
	if _, err := os.Stat(filepath.Join(dir, "upload-backoff.json")); !os.IsNotExist(err) {
		t.Error("success must remove the state file")
	}
	if _, paused := IsPaused(dir, now); paused {
		t.Error("cleared state must not pause")
	}
}

func TestBackoffSummarizesLongErrors(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("x", 500)
	state := RecordFailure(dir, errString(long), time.Now().UTC())
	if len(state.LastErrorSummary) > 200 {
		t.Errorf("summary not truncated: %d", len(state.LastErrorSummary))
	}
}

type errString string

func (e errString) Error() string { return string(e) }
