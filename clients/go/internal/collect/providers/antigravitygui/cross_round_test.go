package antigravitygui

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Cross-round accounting: a database that grows between runs must upload the
// whole day's new total (the compacted acknowledged aggregate plus the new
// rows), not just the delta and not a duplicate of what was already sent.

func dbReadWith(events ...antigravitymeta.UsageEvent) func(antigravityhistory.Options) (antigravityhistory.Result, error) {
	return func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{"conversation-db": true},
			Events:                    events,
			KnownCascadeIDs:           map[string]bool{"conversation-db": true},
			LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
			CompleteDirectoryScan:     true,
		}, nil
	}
}

func totalTokens(snapshots []contract.Snapshot) int64 {
	var total int64
	for _, snapshot := range snapshots {
		total += snapshot.TotalTokens
	}
	return total
}

func acknowledgeAll(t *testing.T, stateDir string, snapshots []contract.Snapshot) {
	t.Helper()
	groups := map[string]bool{}
	for _, snapshot := range snapshots {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir: stateDir, Source: contract.SourceAntigravity,
		AcknowledgedGroups: groups, Timezone: guiTimezone,
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
}

func TestCollectGuiReEmitsTheWholeDayWhenTheDatabaseGrows(t *testing.T) {
	// Round one uploads 40. After the acknowledgement the database gains a row
	// worth 50; the second run must report 90 for the day — the compacted
	// aggregate carries the acknowledged 40, and the new row adds its 50.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	// Isolate the database route: no language-server cascades to request.
	options.ListCascadeIDs = func() ([]string, error) { return nil, nil }
	first := guiDbEvent()
	options.ReadDbUsageEvents = dbReadWith(first)

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if got := totalTokens(snapshots); got != 40 {
		t.Fatalf("first run total = %d, want 40", got)
	}
	acknowledgeAll(t, stateDir, snapshots)

	grown := first
	grown.EventHash = hashOf("db-event-2")
	grown.InputTokens = 50
	options.ReadDbUsageEvents = dbReadWith(first, grown)
	options.CollectedAt = "2026-06-24T02:05:00.000Z"

	snapshots, err = Collect(options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if got := totalTokens(snapshots); got != 90 {
		t.Fatalf("second run total = %d, want the whole day's 90", got)
	}
}

func TestCollectGuiDoesNotReuploadAnUnchangedDay(t *testing.T) {
	// The same event row seen again carries no new usage: the day is already
	// acknowledged, so nothing uploads.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.ListCascadeIDs = func() ([]string, error) { return nil, nil }
	event := guiDbEvent()
	options.ReadDbUsageEvents = dbReadWith(event)

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	acknowledgeAll(t, stateDir, snapshots)

	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	snapshots, err = Collect(options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("second run = %d rows, want none for an unchanged acknowledged day", len(snapshots))
	}
}
