package upload

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// A server that answers every ingest batch with the same outcome list, relative
// to the posted rows, and /check unsupported so every row is posted.
func outcomeServer(t *testing.T, outcomes []map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"upserted": len(body.Snapshots) - len(outcomes),
			"outcomes": outcomes,
		})
	}))
}

func TestUploadTreatsSameAndProtectedAsDelivered(t *testing.T) {
	server := outcomeServer(t, []map[string]any{
		{"index": 0, "status": "same"},
		{"index": 1, "status": "protected"},
	})
	defer server.Close()

	rows := []contract.Snapshot{baseSnapshot("a", 1), baseSnapshot("b", 2), baseSnapshot("c", 3)}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), rows, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Withheld) != 0 {
		t.Fatalf("withheld = %+v, want none", result.Withheld)
	}
	if len(result.Delivered) != 3 {
		t.Fatalf("delivered = %d, want 3", len(result.Delivered))
	}
}

func TestUploadWithholdsStaleAndUnknownRows(t *testing.T) {
	server := outcomeServer(t, []map[string]any{
		{"index": 0, "status": "stale"},
		{"index": 2, "status": "unknown"},
	})
	defer server.Close()

	rows := []contract.Snapshot{baseSnapshot("a", 1), baseSnapshot("b", 2), baseSnapshot("c", 3)}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), rows, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 1 {
		t.Errorf("upserted = %d, want 1", result.Upserted)
	}
	if len(result.Withheld) != 2 || result.Withheld[0].Snapshot.Model != "a" || result.Withheld[0].Status != "stale" ||
		result.Withheld[1].Snapshot.Model != "c" || result.Withheld[1].Status != "unknown" {
		t.Fatalf("withheld = %+v", result.Withheld)
	}
	// A withheld row must not be acknowledged: the cursor would retire it.
	if len(result.Delivered) != 1 || result.Delivered[0].Model != "b" {
		t.Fatalf("delivered = %+v, want only b", result.Delivered)
	}
}

// A status a newer server adds is unknown to this client; acknowledging the row
// would discard its measurement for good, so it withholds (fail closed).
func TestUploadWithholdsUnrecognizedOutcomeStatuses(t *testing.T) {
	server := outcomeServer(t, []map[string]any{{"index": 1, "status": "quarantined"}})
	defer server.Close()

	rows := []contract.Snapshot{baseSnapshot("a", 1), baseSnapshot("b", 2)}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), rows, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Withheld) != 1 || result.Withheld[0].Snapshot.Model != "b" || result.Withheld[0].Status != "quarantined" {
		t.Fatalf("withheld = %+v", result.Withheld)
	}
	if len(result.Delivered) != 1 || result.Delivered[0].Model != "a" {
		t.Fatalf("delivered = %+v, want only a", result.Delivered)
	}
}

// Isolation rounds re-send a narrowed array; the outcome indexes address the
// array of that round, so the withheld row must be found in the send list, not
// the original batch.
func TestUploadOutcomeIndexesAddressTheNarrowedResend(t *testing.T) {
	var ingestCalls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		call := atomic.AddInt32(&ingestCalls, 1)
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if call == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"details": []map[string]any{{
					"index": 0, "path": "snapshots.0.model", "code": "invalid-value",
				}}},
			})
			return
		}
		// The resend posted [b, c]; the server left b unwritten.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"upserted": 1,
			"outcomes": []map[string]any{{"index": 0, "status": "stale"}},
		})
	}))
	defer server.Close()

	rows := []contract.Snapshot{baseSnapshot("bad", 9), baseSnapshot("b", 2), baseSnapshot("c", 3)}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), rows, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Blocked) != 1 || result.Blocked[0].Snapshot.Model != "bad" {
		t.Fatalf("blocked = %+v", result.Blocked)
	}
	if len(result.Withheld) != 1 || result.Withheld[0].Snapshot.Model != "b" || result.Withheld[0].Status != "stale" {
		t.Fatalf("withheld = %+v", result.Withheld)
	}
	if len(result.Delivered) != 1 || result.Delivered[0].Model != "c" {
		t.Fatalf("delivered = %+v, want only c", result.Delivered)
	}
}

func TestUploadRejectsOutcomeIndexOutsideTheBatch(t *testing.T) {
	server := outcomeServer(t, []map[string]any{{"index": 5, "status": "stale"}})
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL),
		[]contract.Snapshot{baseSnapshot("a", 1)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "Upload returned invalid response") {
		t.Fatalf("err = %v", err)
	}
}

// A response that names one row twice, or accounts for rows it never posted, is
// contradictory: one in-range name plus one bogus index must not let the in-range
// row be acknowledged while the bogus one is ignored.
func TestUploadRejectsContradictoryOutcomeSets(t *testing.T) {
	for name, body := range map[string]string{
		// Written 1 + named 1 for a single posted row: the row cannot be both.
		"written and named": `{"upserted":1,"outcomes":[{"index":0,"status":"stale"}]}`,
		// Two named rows for two posted rows, but both names address the same row.
		"duplicate index":             `{"upserted":0,"outcomes":[{"index":0,"status":"stale"},{"index":0,"status":"stale"}]}`,
		"out-of-range delivered name": `{"upserted":0,"outcomes":[{"index":1,"status":"same"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/check") {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()

			_, err := UploadSnapshots(t.Context(), testConfig(server.URL),
				[]contract.Snapshot{baseSnapshot("a", 1)}, server.Client())
			if err == nil || !strings.Contains(err.Error(), "Upload returned invalid response") {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestUploadRejectsMalformedOutcomes(t *testing.T) {
	for name, outcomes := range map[string]string{
		"string index":   `[{"index":"x","status":"stale"}]`,
		"empty status":   `[{"index":0,"status":""}]`,
		"numeric status": `[{"index":0,"status":7}]`,
		"not objects":    `["stale"]`,
		"not an array":   `"stale"`,
		// `null` must not masquerade as the absent field: absent means "old server,
		// deliver everything", while `null` is a response the server never produced —
		// rows must not be acknowledged on its authority.
		"explicit null": `null`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/check") {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				_, _ = w.Write([]byte(`{"upserted":1,"outcomes":` + outcomes + `}`))
			}))
			defer server.Close()

			_, err := UploadSnapshots(t.Context(), testConfig(server.URL),
				[]contract.Snapshot{baseSnapshot("a", 1)}, server.Client())
			if err == nil || !strings.Contains(err.Error(), "Upload returned invalid response") {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

// Old servers omit `outcomes`; everything posted is delivered, as before the
// feature existed. The batch used by the other tests already exercises this
// path implicitly, but the contract deserves an explicit case.
func TestUploadWithoutOutcomesDeliversEverything(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
	defer server.Close()

	rows := []contract.Snapshot{baseSnapshot("a", 1), baseSnapshot("b", 2)}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), rows, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Withheld) != 0 || len(result.Delivered) != 2 {
		t.Fatalf("withheld = %+v, delivered = %d", result.Withheld, len(result.Delivered))
	}
}

// The client's delivered-status mirror must track the server's classifier: if
// the server renames `same`/`protected`, every unchanged row would be withheld
// forever (which is at least safe) — but if it *repurposes* one of them as a
// not-written status, the client would acknowledge undelivered rows. The union
// is parsed, not substring-matched, so adding a fifth status fails here too
// (the TS mirror in packages/collector/src/upload-batches.test.ts parses the
// same line); an unwritten status the client has not classified is withheld at
// runtime, so a fifth status is safe until this test forces a decision.
func TestOutcomeStatusesMirrorTheServer(t *testing.T) {
	source := readServerOutcomesSource(t)
	declared := parseIngestRowStatusUnion(t, source)
	want := []string{"protected", "same", "stale", "unknown"}
	if strings.Join(declared, ",") != strings.Join(want, ",") {
		t.Fatalf("server IngestRowStatus = %v, want %v; update deliveredOutcomeStatuses and this mirror", declared, want)
	}
	if !deliveredOutcomeStatuses["same"] || !deliveredOutcomeStatuses["protected"] {
		t.Fatal("same and protected must count as delivered")
	}
	if deliveredOutcomeStatuses["stale"] || deliveredOutcomeStatuses["unknown"] {
		t.Fatal("stale and unknown must stay unacknowledged")
	}
}

// parseIngestRowStatusUnion extracts the single-quoted members of the server's
// `export type IngestRowStatus = ...` declaration, sorted, the same way the TS
// mirror does.
func parseIngestRowStatusUnion(t *testing.T, source string) []string {
	t.Helper()
	declaration := regexp.MustCompile(`(?s)export type IngestRowStatus =([^
]+)`).FindStringSubmatch(source)
	if declaration == nil {
		t.Fatal("server outcomes.ts no longer declares `export type IngestRowStatus = ...` on one line")
	}
	var statuses []string
	for _, match := range regexp.MustCompile(`'([a-z]+)'`).FindAllStringSubmatch(declaration[1], -1) {
		statuses = append(statuses, match[1])
	}
	sort.Strings(statuses)
	return statuses
}

func readServerOutcomesSource(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for depth := 0; depth < 8; depth++ {
		candidate := filepath.Join(directory, "apps", "web", "app", "features", "ingest", "repository", "outcomes.ts")
		if content, err := os.ReadFile(candidate); err == nil {
			return string(content)
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	t.Fatal("could not find apps/web/app/features/ingest/repository/outcomes.ts above the test working directory")
	return ""
}
