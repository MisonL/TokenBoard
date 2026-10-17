package antigravitygui

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
)

// The language-server request gate: which conversations are worth asking the
// server about. Each scenario mirrors one TS case in antigravity-gui.test.ts.

func TestDoesNotRequestAnUnscannedDatabaseCascade(t *testing.T) {
	// A conversation that has a database but was not read this run (the
	// bounded scan skipped it) must not fall through to the language server:
	// its history is the database's job.
	options, _ := guiTestOptions(t, "antigravity", nil)
	options.ListCascadeIDs = nil
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{ID: "conversation-db", MtimeMs: 2000, Size: 20, HasDatabaseFile: true}}, nil
	}
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{},
			LastReadRowIndexByCascade: map[string]int64{},
		}, nil
	}
	var calls []string
	options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
		calls = append(calls, request.CascadeID)
		return guiMetadataResponse("antigravity"), nil
	}

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("requests = %v, want none for an unscanned database cascade", calls)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %d, want none", len(snapshots))
	}
}

func TestRequestsLanguageServerWhenDbRowsProduceNoUsableUsage(t *testing.T) {
	// The row cursor advanced but no usage event came out of it: the database
	// cannot account for the conversation, so the language server has to.
	options, _ := guiTestOptions(t, "antigravity", nil)
	cascadeID := "conversation-db"
	options.ListCascadeIDs = nil
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{ID: cascadeID, MtimeMs: 2000, Size: 20, HasDatabaseFile: true}}, nil
	}
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{cascadeID: true},
			LastReadRowIndexByCascade: map[string]int64{cascadeID: 7},
			CompleteDirectoryScan:     true,
		}, nil
	}
	var calls []string
	options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
		calls = append(calls, request.CascadeID)
		return guiMetadataResponse("antigravity"), nil
	}

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(calls) != 1 || calls[0] != cascadeID {
		t.Fatalf("requests = %v, want the database cascade", calls)
	}
	if len(snapshots) == 0 {
		t.Fatal("the language-server route produced no snapshots")
	}
}

func TestRequestsLanguageServerAgainAfterADbCoveredCascadeChanges(t *testing.T) {
	// Once the conversation file changes, its database coverage is stale: the
	// language server has to be asked again, and the new usage uploads.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	cascadeID := "conversation-db"
	size := int64(20)
	mtime := float64(2000)
	options.ListCascadeIDs = nil
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{ID: cascadeID, MtimeMs: mtime, Size: size}}, nil
	}
	run := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		run++
		if run == 1 {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{cascadeID: true},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{cascadeID: true},
				LastReadRowIndexByCascade: map[string]int64{cascadeID: 1},
				CompleteDirectoryScan:     true,
			}, nil
		}
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{},
			LastReadRowIndexByCascade: map[string]int64{},
			CompleteDirectoryScan:     true,
		}, nil
	}
	var calls []string
	options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
		calls = append(calls, request.CascadeID)
		return guiMetadataResponse("antigravity"), nil
	}

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if len(first) == 0 {
		t.Fatal("the first run produced no snapshots")
	}
	acknowledgeAll(t, stateDir, first)

	// The conversation file changed since the database covered it.
	size = 30
	mtime = 3000
	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	second, err := Collect(options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if len(calls) != 1 || calls[0] != cascadeID {
		t.Fatalf("requests = %v, want the changed cascade to be asked again", calls)
	}
	if len(second) == 0 {
		t.Fatal("the new language-server usage did not upload")
	}
	var total int64
	for _, snapshot := range second {
		total += snapshot.TotalTokens
	}
	if total == 0 {
		t.Fatal("the second run uploaded no usage")
	}
}

func TestKeepsDbCoveredMarkerWhenTheDatabaseStopsProducingUsage(t *testing.T) {
	// A conversation the database already covered must stay covered: a later
	// run whose database read yields nothing for it must neither ask the
	// language server nor re-upload the old day.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	cascadeID := "conversation-db"
	options.ListCascadeIDs = nil
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{ID: cascadeID, MtimeMs: 2000, Size: 20, HasDatabaseFile: true}}, nil
	}
	run := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		run++
		if run == 1 {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{cascadeID: true},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{cascadeID: true},
				LastReadRowIndexByCascade: map[string]int64{cascadeID: 1},
				CompleteDirectoryScan:     true,
			}, nil
		}
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{},
			LastReadRowIndexByCascade: map[string]int64{cascadeID: 1},
			CompleteDirectoryScan:     true,
		}, nil
	}
	var calls []string
	options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
		calls = append(calls, request.CascadeID)
		return guiMetadataResponse("antigravity"), nil
	}

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if len(first) == 0 {
		t.Fatal("the first run produced no snapshots")
	}
	acknowledgeAll(t, stateDir, first)

	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	second, err := Collect(options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("requests = %v, want the DB-covered cascade left alone", calls)
	}
	if len(second) != 0 {
		t.Fatalf("second run = %d snapshots, want none", len(second))
	}
}
