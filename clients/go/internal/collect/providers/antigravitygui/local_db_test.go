package antigravitygui

import (
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

func TestLocalDbReadFiltersEventsAndCascadesByRange(t *testing.T) {
	// Events carry the cascade HASH; the result's cascadeIds carry the raw
	// conversation id, which is what the filter hashes to compare.
	cascadeHash := hashOf("cascade-a")
	inside := guiEventFixture(cascadeHash, strings.Repeat("b", 64), 10)
	inside.CreatedAt = "2026-06-24T10:00:00.000Z"
	outside := guiEventFixture(cascadeHash, strings.Repeat("c", 64), 20)
	outside.CreatedAt = "2026-06-20T10:00:00.000Z"

	since := "2026-06-24"
	rangeValue, err := antigravityscan.ResolveCollectionRange(&since, "UTC", func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	options := Options{Source: "antigravity"}
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{
			CascadeIDs: map[string]bool{"cascade-a": true, "cascade-b": true},
			Events:     []antigravitymeta.UsageEvent{inside, outside},
		}, nil
	}

	read := ReadGuiLocalDbUsage(options, sessioncursor.NewState("antigravity"), rangeValue, "UTC", nil)
	if read.Error != nil {
		t.Fatalf("read error: %v", read.Error)
	}
	if len(read.Usage.Events) != 1 || read.Usage.Events[0].EventHash != inside.EventHash {
		t.Fatalf("events = %+v, want only the in-range one", read.Usage.Events)
	}
	if !read.Usage.CascadeIDs["cascade-a"] || read.Usage.CascadeIDs["cascade-b"] {
		t.Fatalf("cascade ids = %v, want only the covered cascade", read.Usage.CascadeIDs)
	}
}

func TestLocalDbReadFoldsErrorsIntoTheResult(t *testing.T) {
	since := "2026-06-24"
	rangeValue, err := antigravityscan.ResolveCollectionRange(&since, "UTC", func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	options := Options{Source: "antigravity"}
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{}, contractErrorFixture()
	}

	read := ReadGuiLocalDbUsage(options, sessioncursor.NewState("antigravity"), rangeValue, "UTC", nil)
	if read.Error == nil || !strings.Contains(read.Error.Error(), "reader unavailable") {
		t.Fatalf("error = %v, want the unavailable classification", read.Error)
	}
	if read.Usage.Events == nil || len(read.Usage.Events) != 0 {
		t.Fatal("a failed read still returns an empty, usable result")
	}
}

func TestLocalDbReadThreadsCursorAndScanState(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:                    &cursor,
		Source:                    "antigravity",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4},
		HistoryScope:              "all",
		CollectedAt:               guiCollectedAt,
	})

	var observed antigravityhistory.Options
	options := Options{Source: "antigravity", ConversationDir: "/tmp/does-not-matter"}
	options.ReadDbUsageEvents = func(read antigravityhistory.Options) (antigravityhistory.Result, error) {
		observed = read
		return antigravityhistory.Result{}, nil
	}
	// A caller-owned scan state is threaded through untouched.
	scan := antigravityscan.NewFileScanState()
	scan.NextSequence = 3

	ReadGuiLocalDbUsage(options, cursor, antigravityscan.CollectionRange{HistoryScope: "all"}, "UTC", &scan)

	if observed.LastSeenRowIndexByCascadeHash[hashOf("cascade-a")] != 4 {
		t.Fatalf("last seen rows = %v, want the cursor's row 4", observed.LastSeenRowIndexByCascadeHash)
	}
	if observed.ScanState == nil {
		t.Fatal("the scan state was not threaded to the reader")
	}
	if observed.ScanState.NextSequence != 3 {
		t.Fatalf("scan state = %+v, want the caller's", observed.ScanState)
	}
}

// contractErrorFixture builds an unavailable-classified error.
func contractErrorFixture() error {
	return &unavailableError{}
}

type unavailableError struct{}

func (*unavailableError) Error() string {
	return "Antigravity SQLite reader unavailable: sqlite3 not found"
}
