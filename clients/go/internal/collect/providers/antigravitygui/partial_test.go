package antigravitygui

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// guiDbRead returns a SQLite read result with one covered conversation.
func guiDbRead() func(antigravityhistory.Options) (antigravityhistory.Result, error) {
	return func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{"conversation-db": true},
			Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
			KnownCascadeIDs:           map[string]bool{"conversation-db": true},
			LastReadRowIndexByCascade: map[string]int64{"conversation-db": 3},
		}, nil
	}
}

func TestCollectGuiPartialWhenCascadeEnumerationFails(t *testing.T) {
	// Enumeration failing is not an unavailable cause, so the partial error is
	// fatal — but the DB snapshots ride along and the second run replays them
	// with the progress the first preserved.
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ListCascadeIDs = func() ([]string, error) {
			return nil, errors.New("Failed to enumerate Antigravity cascades")
		}
		options.ReadDbUsageEvents = guiDbRead()
	})

	_, err := Collect(options)
	first, ok := IsPartialUsageError(err)
	if !ok || !first.Fatal {
		t.Fatalf("err = %v, want a fatal partial usage error", err)
	}
	if len(first.Snapshots) == 0 {
		t.Fatal("the first partial error carried no snapshots")
	}

	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	_, err = Collect(options)
	second, ok := IsPartialUsageError(err)
	if !ok {
		t.Fatalf("second run err = %v, want a partial usage error", err)
	}
	if len(second.Snapshots) != len(first.Snapshots) {
		t.Fatalf("second run snapshots = %d, want the replayed %d", len(second.Snapshots), len(first.Snapshots))
	}
	for index := range second.Snapshots {
		if second.Snapshots[index].CollectedAt != "2026-06-24T02:05:00.000Z" {
			t.Fatalf("replayed row %d collectedAt = %q, want the new run's stamp",
				index, second.Snapshots[index].CollectedAt)
		}
	}
}

func TestCollectGuiFatalWhenMetadataIsInvalid(t *testing.T) {
	// An oversized or malformed metadata payload is a real collection failure
	// carried as a fatal partial error, not an absent language server.
	for _, message := range []string{
		"Antigravity metadata response exceeded the 8388608-byte limit for antigravity",
		"Antigravity metadata request returned invalid JSON for antigravity: Unexpected token",
	} {
		t.Run(message, func(t *testing.T) {
			options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
				options.ReadDbUsageEvents = guiDbRead()
				options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
					return nil, errors.New(message)
				}
			})

			_, err := Collect(options)
			partial, ok := IsPartialUsageError(err)
			if !ok {
				t.Fatalf("err = %v, want a partial usage error", err)
			}
			if !partial.Fatal {
				t.Fatalf("%q must classify as a collection failure, not unavailable", message)
			}
			if len(partial.Snapshots) == 0 {
				t.Fatal("the partial error carried no DB snapshots")
			}
		})
	}
}

func TestCollectGuiPreservesPartialSnapshotsWhenCursorCleanupFails(t *testing.T) {
	// The cleanup failure (a cursor that can no longer be written) must not
	// discard the collected snapshots: they still ride along as fatal partial
	// usage with the cleanup error attached as the cause.
	stateDir := t.TempDir()
	options := Options{
		Source:      "antigravity",
		StateDir:    stateDir,
		Timezone:    guiTimezone,
		CollectedAt: guiTestCollectedAt,
		Env:         func(string) string { return "" },
		ListCascadeIDs: func() ([]string, error) {
			return []string{"conversation-a"}, nil
		},
		ReadDbUsageEvents: guiDbRead(),
		RequestGeneratorMetadata: func(GeneratorMetadataRequest) (any, error) {
			// Break the cursor directory before the partial-progress write, the
			// way the TS test removes it under the failing request.
			if err := removeCursorDir(stateDir); err != nil {
				t.Errorf("cleanup: %v", err)
			}
			return nil, errors.New("spawn /missing/tokenboard-antigravity-language-server ENOENT")
		},
	}

	_, err := Collect(options)
	partial, ok := IsPartialUsageError(err)
	if !ok {
		t.Fatalf("err = %v, want a partial usage error", err)
	}
	if !partial.Fatal {
		t.Fatal("a cleanup failure makes the partial error fatal")
	}
	if len(partial.Snapshots) == 0 {
		t.Fatal("the partial error carried no DB snapshots")
	}
	if partial.Cause == nil {
		t.Fatal("the cleanup failure must be attached as the cause")
	}
}

func TestCollectGuiRejectsUnboundedTokenMetadata(t *testing.T) {
	response := guiMetadataResponse("antigravity")
	items := response.(map[string]any)["generatorMetadata"].([]any)
	item := items[0].(map[string]any)
	usage := item["chatModel"].(map[string]any)["usage"].(map[string]any)
	usage["inputTokens"] = "1e309"

	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			return response, nil
		}
	})
	_, err := Collect(options)
	if err == nil || !strings.Contains(err.Error(), "bounded") {
		t.Fatalf("err = %v, want the bounded-token refusal", err)
	}
}

func TestCollectGuiRejectsNonIsoMetadataTimestamps(t *testing.T) {
	response := guiMetadataResponse("antigravity")
	items := response.(map[string]any)["generatorMetadata"].([]any)
	item := items[0].(map[string]any)
	chatModel := item["chatModel"].(map[string]any)
	chatModel["chatStartMetadata"] = map[string]any{"createdAt": "2026-02-30T00:00:00.000Z"}

	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			return response, nil
		}
	})
	_, err := Collect(options)
	if err == nil || !strings.Contains(err.Error(), "createdAt must be an ISO datetime") {
		t.Fatalf("err = %v, want the ISO-datetime refusal", err)
	}
}

func TestCollectGuiSourceCarriesTheSourceName(t *testing.T) {
	// The two GUI variants must report their own source, and neither may turn
	// into the other's snapshot shape.
	for _, source := range []string{"antigravity", "antigravity-ide"} {
		t.Run(source, func(t *testing.T) {
			options, _ := guiTestOptions(t, source, nil)
			snapshots, err := Collect(options)
			if err != nil {
				t.Fatalf("collect: %v", err)
			}
			if len(snapshots) == 0 {
				t.Fatal("no snapshots")
			}
			if string(snapshots[0].Source) != source {
				t.Fatalf("source = %q, want %q", snapshots[0].Source, source)
			}
			var expected contract.Source
			if source == "antigravity-ide" {
				expected = contract.SourceAntigravityIDE
			} else {
				expected = contract.SourceAntigravity
			}
			if snapshots[0].Source != expected {
				t.Fatalf("source = %q, want the contract constant", snapshots[0].Source)
			}
		})
	}
}

// removeCursorDir replaces the state directory with a regular file, so the
// cursor write that follows cannot succeed.
func removeCursorDir(stateDir string) error {
	if err := os.RemoveAll(stateDir); err != nil {
		return err
	}
	return os.WriteFile(stateDir, []byte("blocked"), 0o600)
}

func TestCollectGuiUsesLanguageServerWhenConversationsDirectoryIsAbsent(t *testing.T) {
	// A machine without the GUI tool's conversations directory still collects
	// through the language-server route: the missing directory is "not
	// installed here", not a failure.
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ConversationDir = "/definitely/missing/conversations"
	})
	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %d, want the language-server route's single session", len(snapshots))
	}
	if snapshots[0].TotalTokens != 174 {
		t.Fatalf("totalTokens = %d, want the fixture's 174", snapshots[0].TotalTokens)
	}
}

func TestCollectGuiRetriesCascadesThatProduceNoUsableEvents(t *testing.T) {
	// An empty metadata response records a frontier for priority ordering but
	// must not mark the cascade done: the conversation may gain usage later.
	var calls []string
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
			calls = append(calls, request.CascadeID)
			return map[string]any{"generatorMetadata": []any{}}, nil
		}
	})

	if _, err := Collect(options); err != nil {
		t.Fatalf("first collect: %v", err)
	}
	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	if _, err := Collect(options); err != nil {
		t.Fatalf("second collect: %v", err)
	}

	want := []string{"conversation-a", "conversation-a"}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Fatalf("cascade requests = %v, want %v", calls, want)
	}
}

func TestCollectGuiSurfacesTheDbErrorInsteadOfTheScanAssertion(t *testing.T) {
	// Under --since all, a database read that failed carries no scan result at
	// all — the TS error path returns a result without completeDirectoryScan, so
	// its `=== false` assertion cannot fire. Reporting the incomplete-scan
	// message here would hide the real read failure.
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.Since = "all"
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{}, errors.New("Antigravity SQLite metadata query failed")
		}
	})

	_, err := Collect(options)
	if err == nil {
		t.Fatal("a failed database read must surface")
	}
	if strings.Contains(err.Error(), "requires a complete SQLite directory scan") {
		t.Fatalf("err = %v, want the SQLite failure, not the incomplete-scan assertion", err)
	}
	if !strings.Contains(err.Error(), "SQLite metadata query failed") {
		t.Fatalf("err = %v, want the SQLite failure", err)
	}
}

func TestCollectGuiPersistsScanStateOnThePartialPath(t *testing.T) {
	// The TS reader mutates cursor.antigravityDbFileScan in place and the
	// partial path writes the whole cursor, so the rotation bookkeeping
	// survives a failed language-server route. Go copies the scan state, so
	// the partial write has to put it back or every failed run re-stats the
	// same files from a cold rotation.
	conversationDir := t.TempDir()
	cascadeID := "11111111-1111-1111-1111-111111111111"
	if err := os.WriteFile(filepath.Join(conversationDir, cascadeID+".db"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	options, stateDir := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ConversationDir = conversationDir
		options.ListCascadeIDs = func() ([]string, error) {
			return []string{"conversation-a"}, nil
		}
		// The injected reader stands in for the SQLite read, so it has to
		// record the scan entry the real reader would.
		options.ReadDbUsageEvents = func(readOptions antigravityhistory.Options) (antigravityhistory.Result, error) {
			if readOptions.ScanState != nil {
				readOptions.ScanState.Files[hashOf(cascadeID)] = antigravityscan.FileScanEntry{
					MtimeMs: 1_782_000_000_000, Size: 1,
				}
			}
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			}, nil
		}
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			return nil, errors.New("metadata unavailable")
		}
	})

	if _, err := Collect(options); err == nil {
		t.Fatal("expected a partial error")
	}

	raw, err := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	var parsed struct {
		DBScan struct {
			Files map[string]any `json:"files"`
		} `json:"antigravityDbFileScan"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse cursor: %v", err)
	}
	if len(parsed.DBScan.Files) == 0 {
		t.Fatal("the partial write dropped the database scan state the reader recorded")
	}
}
