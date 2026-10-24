package codex

// Port of codex-subagent-usage-worker-pool.test.ts. The TS pool runs a worker
// thread; this port runs the same read functions on goroutines, so the tests
// drive the same observable behavior: a real parse, a task-level error, an
// unexpected worker termination, and close rejecting in-flight work.

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func subagentWorkerUsageRecord() map[string]any {
	usage := map[string]any{
		"input_tokens":                float64(10),
		"output_tokens":               float64(2),
		"cached_input_tokens":         float64(4),
		"cache_creation_input_tokens": float64(3),
		"total_tokens":                float64(19),
	}
	return map[string]any{
		"timestamp": "2026-07-25T01:00:00.000Z",
		"payload":   map[string]any{"info": map[string]any{"total_token_usage": usage, "last_token_usage": usage}},
	}
}

func TestCodexSubagentWorkerPoolParsesUsageAndPreservesErrors(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	writeJSONL(t, filePath, []map[string]any{subagentWorkerUsageRecord()})
	pool, err := NewCodexSubagentUsageWorkerPool(1, nil)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	defer pool.Close()

	usages, err := pool.Read(filePath, "2026-07-25T00:00:00.000Z", "UTC", nil)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	want := DatedUsage{
		UsageDate: "2026-07-25", InputTokens: 10, OutputTokens: 2,
		CacheCreationTokens: 3, CacheReadTokens: 4, TotalTokens: 19,
	}
	if len(usages) != 1 || usages[0] != want {
		t.Fatalf("usages = %+v, want %+v", usages, want)
	}
	if _, err := pool.Read(filePath, "2026-07-25T00:00:00.000Z", "Invalid/Timezone", nil); err == nil ||
		!strings.Contains(err.Error(), "Invalid timezone for Codex subagent usage date") {
		t.Fatalf("err = %v", err)
	}
}

// subagentPanickingReader models a worker thread that dies before answering.
type subagentPanickingReader struct{}

func (subagentPanickingReader) Read(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]DatedUsage, error) {
	panic("worker thread exited")
}

func (subagentPanickingReader) ReadEvents(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]ChildUsageEvent, error) {
	panic("worker thread exited")
}

func TestCodexSubagentWorkerPoolRejectsWorkWhenAWorkerExitsUnexpectedly(t *testing.T) {
	pool, err := NewCodexSubagentUsageWorkerPool(1, func() SubagentUsageReader {
		return subagentPanickingReader{}
	})
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	_, err = pool.Read("/unused", "2026-07-25T00:00:00.000Z", "UTC", nil)
	if err == nil || !strings.Contains(err.Error(), "exited unexpectedly with code 1") {
		t.Fatalf("err = %v", err)
	}
	if err := pool.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestCodexSubagentWorkerPoolRejectsAnOversizedWarning(t *testing.T) {
	pool, err := NewCodexSubagentUsageWorkerPool(1, func() SubagentUsageReader {
		return subagentWarningReader{}
	})
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	_, err = pool.Read("/unused", "2026-07-25T00:00:00.000Z", "UTC", func(string) {})
	if err == nil || !strings.Contains(err.Error(), "returned an oversized warning") {
		t.Fatalf("err = %v", err)
	}
	_ = pool.Close()
}

type subagentWarningReader struct{}

func (subagentWarningReader) Read(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]DatedUsage, error) {
	stderr(strings.Repeat("x", maxCodexSubagentWorkerWarningLength+1))
	return nil, nil
}

func (subagentWarningReader) ReadEvents(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]ChildUsageEvent, error) {
	stderr(strings.Repeat("x", maxCodexSubagentWorkerWarningLength+1))
	return nil, nil
}

// subagentBlockingReader blocks until the test releases it, the way a worker
// thread that never replies keeps its task in flight.
type subagentBlockingReader struct {
	started chan struct{}
	release chan struct{}
}

func (r subagentBlockingReader) Read(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]DatedUsage, error) {
	select {
	case r.started <- struct{}{}:
	default:
	}
	<-r.release
	return nil, nil
}

func (r subagentBlockingReader) ReadEvents(
	filePath, timestamp, timezone string,
	stderr func(string),
) ([]ChildUsageEvent, error) {
	usages, err := r.Read(filePath, timestamp, timezone, stderr)
	if err != nil {
		return nil, err
	}
	events := make([]ChildUsageEvent, 0, len(usages))
	for _, usage := range usages {
		events = append(events, ChildUsageEvent{DatedUsage: usage})
	}
	return events, nil
}

func TestCodexSubagentWorkerPoolCloseRejectsInFlightWorkAndWaits(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	reader := subagentBlockingReader{started: started, release: release}
	pool, err := NewCodexSubagentUsageWorkerPool(2, func() SubagentUsageReader { return reader })
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}

	pendingErr := make(chan error, 1)
	go func() {
		_, err := pool.Read("/unused", "2026-07-25T00:00:00.000Z", "UTC", nil)
		pendingErr <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker never started the queued read")
	}

	closeDone := make(chan error, 1)
	secondCloseDone := make(chan error, 1)
	go func() { closeDone <- pool.Close() }()
	go func() { secondCloseDone <- pool.Close() }()

	select {
	case err := <-pendingErr:
		if err == nil || !strings.Contains(err.Error(), "closed before completing queued work") {
			t.Fatalf("pending err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("close did not reject the in-flight read")
	}
	close(release)
	for index := 0; index < 2; index++ {
		select {
		case err := <-closeDone:
			if err != nil {
				t.Fatalf("close: %v", err)
			}
		case err := <-secondCloseDone:
			if err != nil {
				t.Fatalf("second close: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("close did not wait for the workers")
		}
	}
	if _, err := pool.Read("/unused", "2026-07-25T00:00:00.000Z", "UTC", nil); err == nil ||
		!strings.Contains(err.Error(), "worker pool is closed") {
		t.Fatalf("err = %v", err)
	}
}

func TestNormalizeCodexSubagentWorkerCountMatchesTheTypeScriptLimits(t *testing.T) {
	if _, err := NormalizeCodexSubagentWorkerCount(0); err == nil ||
		!strings.Contains(err.Error(), "Invalid Codex subagent worker count: expected an integer from 1 to 8") {
		t.Fatalf("err = %v", err)
	}
	if _, err := NormalizeCodexSubagentWorkerCount(9); err == nil {
		t.Fatal("9 workers was accepted")
	}
	for _, value := range []int{1, 4, 8} {
		normalized, err := NormalizeCodexSubagentWorkerCount(value)
		if err != nil || normalized != value {
			t.Fatalf("normalize(%d) = %d, %v", value, normalized, err)
		}
	}
	if count := DefaultCodexSubagentWorkerCount(); count < 1 || count > 4 {
		t.Fatalf("default worker count = %d", count)
	}
}
