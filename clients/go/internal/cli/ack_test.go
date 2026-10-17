package cli

import (
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of the TS shouldAckCursor contract: the Antigravity sources always
// acknowledge, the session-file sources only in hook mode.

func hookAckFixture(t *testing.T, stateDir string) contract.Snapshot {
	t.Helper()
	snapshot := contract.Snapshot{
		Source:       contract.SourceClaudeCode,
		UsageDate:    "2026-05-22",
		Timezone:     "Asia/Shanghai",
		Model:        "claude-sonnet-4-5",
		InputTokens:  8,
		OutputTokens: 13,
		TotalTokens:  21,
		CollectedAt:  "2026-05-22T10:00:00.000Z",
	}
	pending := true
	cursor := sessioncursor.NewState("claude-code")
	cursor.Files["project-a/session.jsonl"] = sessioncursor.Entry{
		Size:    10,
		MtimeMs: 1,
		SHA256:  "abc",
		Snapshots: []sessioncursor.Snapshot{{
			Source:       "claude-code",
			UsageDate:    "2026-05-22",
			Timezone:     "Asia/Shanghai",
			Model:        "claude-sonnet-4-5",
			InputTokens:  8,
			OutputTokens: 13,
			TotalTokens:  21,
		}},
		MissingCost:   false,
		PendingUpload: &pending,
		UpdatedAt:     "2026-05-22T10:00:00.000Z",
	}
	cursorPath := filepath.Join(stateDir, sessioncursor.FileName(contract.SourceClaudeCode, ""))
	if err := sessioncursor.Write(cursorPath, cursor); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func readHookAckCursor(t *testing.T, stateDir string) sessioncursor.Entry {
	t.Helper()
	cursor, err := sessioncursor.Read(
		filepath.Join(stateDir, sessioncursor.FileName(contract.SourceClaudeCode, "")), "claude-code")
	if err != nil {
		t.Fatal(err)
	}
	return cursor.Files["project-a/session.jsonl"]
}

func TestAcknowledgeUploadCursorsClearsPendingClaudeEntriesInHookMode(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := hookAckFixture(t, stateDir)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, []contract.Source{contract.SourceClaudeCode},
		[]contract.Snapshot{snapshot}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || *entry.PendingUpload {
		t.Errorf("pending upload must be cleared: %+v", entry)
	}
}

func TestAcknowledgeUploadCursorsLeavesClaudeEntriesPendingOutsideHookMode(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := hookAckFixture(t, stateDir)
	env := func(string) string { return "" }
	if err := acknowledgeUploadCursors(stateDir, []contract.Source{contract.SourceClaudeCode},
		[]contract.Snapshot{snapshot}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("a range-mode run must not acknowledge the hook cursor: %+v", entry)
	}
}

// An entry whose snapshot was not part of the uploaded groups stays pending:
// acknowledging it would drop usage the server never accepted.
func TestAcknowledgeUploadCursorsKeepsUnacknowledgedEntriesPending(t *testing.T) {
	stateDir := t.TempDir()
	hookAckFixture(t, stateDir)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	// The uploaded snapshot belongs to a different day, so it cannot cover the
	// pending entry.
	other := contract.Snapshot{
		Source:       contract.SourceClaudeCode,
		UsageDate:    "2026-05-23",
		Timezone:     "Asia/Shanghai",
		Model:        "claude-sonnet-4-5",
		InputTokens:  8,
		OutputTokens: 13,
		TotalTokens:  21,
		CollectedAt:  "2026-05-23T10:00:00.000Z",
	}
	if err := acknowledgeUploadCursors(stateDir, []contract.Source{contract.SourceClaudeCode},
		[]contract.Snapshot{other}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("unacknowledged entry must stay pending: %+v", entry)
	}
}
