package codex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of codex-multi-profile-hook.test.ts, at the CollectHookProfiles layer:
// the per-profile cursors, the legacy single-home cursor migration, and the
// merged pending bookkeeping. The scenarios that drive the whole
// collectCodexUsage provider (ccusage reconciliation, context-pricing
// resolution) belong to the provider-orchestration batch.

func writeHookJSONL(t *testing.T, path string, rows ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(rows, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func tokenCountEvent(timestamp string, totalTokens int, model string) string {
	return `{"type":"event_msg","timestamp":"` + timestamp + `","payload":{"type":"token_count","info":{"model":"` +
		model + `","last_token_usage":{"input_tokens":` + hookItoa(totalTokens) +
		`,"output_tokens":0,"total_tokens":` + hookItoa(totalTokens) + `}}}}`
}

type cursorFileInput struct {
	cursorPath            string
	relativePath          string
	totalTokens           int
	size                  float64
	sha256                string
	contentHashAlgo       string
	pendingUpload         bool
	model                 string
	costUsd               float64
	contextPricingPending bool
}

// writeCursorFile builds a cursor document by hand, the way the TS suite's
// writeProfileCursor / writeLegacyPendingCursor helpers do, so a test can pin
// a digest or size that no real file has.
func writeCursorFile(t *testing.T, input cursorFileInput) {
	t.Helper()
	if input.model == "" {
		input.model = "gpt-5"
	}
	snapshotRow := map[string]any{
		"source":              "codex",
		"usageDate":           "2026-05-22",
		"timezone":            "Asia/Shanghai",
		"model":               input.model,
		"inputTokens":         input.totalTokens,
		"outputTokens":        0,
		"cacheCreationTokens": 0,
		"cacheReadTokens":     0,
		"totalTokens":         input.totalTokens,
		"costUsd":             input.costUsd,
		"sessionCount":        1,
	}
	if input.contextPricingPending {
		snapshotRow["codexContextPricingPending"] = true
	}
	entry := map[string]any{
		"size":            input.size,
		"mtimeMs":         1779411600000,
		"sha256":          input.sha256,
		"endsWithNewline": true,
		"snapshots":       []any{snapshotRow},
		"missingCost":     false,
		"updatedAt":       "2026-05-22T10:00:00.000Z",
	}
	if input.contentHashAlgo != "" {
		entry["contentHashAlgo"] = input.contentHashAlgo
	}
	if input.pendingUpload {
		entry["pendingUpload"] = true
	}
	document := map[string]any{
		"version": 1,
		"source":  "codex",
		"files":   map[string]any{input.relativePath: entry},
	}
	if err := os.MkdirAll(filepath.Dir(input.cursorPath), 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input.cursorPath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func hookSHA256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func fileFingerprint(t *testing.T, path string) (float64, string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return float64(info.Size()), hookSHA256Hex(content)
}

func readCursorFiles(t *testing.T, path string) map[string]sessioncursor.Entry {
	t.Helper()
	cursor, err := sessioncursor.Read(path, "codex")
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return cursor.Files
}

func hookProfileInput(homes []string, stateDir string) HookProfileInput {
	return HookProfileInput{
		CodexHomes:  homes,
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
	}
}

func TestHookProfilePlanUsesTheLegacyCursorForOneHomeWithoutHistory(t *testing.T) {
	stateDir := t.TempDir()
	plan, err := ResolveHookCursorPlan([]string{filepath.Join(stateDir, "home")}, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if plan.UsesProfileCursors {
		t.Fatalf("plan = %+v", plan)
	}
	if len(plan.CursorNames) != 1 || plan.CursorNames[0] != "codex-cursor.json" {
		t.Errorf("names = %+v", plan.CursorNames)
	}
	if len(plan.CursorScopes) != 1 || plan.CursorScopes[0] != "" {
		t.Errorf("scopes = %+v", plan.CursorScopes)
	}
}

func TestHookProfilePlanSwitchesToProfileCursorsForMultipleHomes(t *testing.T) {
	stateDir := t.TempDir()
	first := filepath.Join(stateDir, "first")
	second := filepath.Join(stateDir, "second")
	plan, err := ResolveHookCursorPlan([]string{first, second}, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.UsesProfileCursors {
		t.Fatalf("plan = %+v", plan)
	}
	if len(plan.CursorNames) != 2 || plan.CursorNames[0] != HookProfileCursorName(first) ||
		plan.CursorNames[1] != HookProfileCursorName(second) {
		t.Errorf("names = %+v", plan.CursorNames)
	}
	if plan.CursorScopes[0] != first || plan.CursorScopes[1] != second {
		t.Errorf("scopes = %+v", plan.CursorScopes)
	}
}

// The profile cursor name hashes the resolved home, so a home containing a
// comma (legal on POSIX) cannot be confused with the legacy comma-separated
// CODEX_HOME list, and two homes never share a cursor.
func TestHookProfileCursorNameIsAHashedScope(t *testing.T) {
	name := HookProfileCursorName("/tmp/profile,primary")
	if strings.Contains(name, ",") || !strings.Contains(name, "profile-") {
		t.Fatalf("name = %q", name)
	}
	other := HookProfileCursorName("/tmp/profile")
	if name == other {
		t.Error("distinct homes must not share a cursor name")
	}
}

// A single home whose legacy cursor records a different profile hash belongs
// to another profile: the plan moves to a profile cursor instead of reading
// the legacy entries as this home's own.
func TestHookProfilePlanRejectsALegacyCursorFromAnotherProfile(t *testing.T) {
	stateDir := t.TempDir()
	home := filepath.Join(stateDir, "home")
	legacy := sessioncursor.NewState("codex")
	if err := legacy.SetExtra("codexHookProfileHash", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := sessioncursor.Write(filepath.Join(stateDir, "codex-cursor.json"), legacy); err != nil {
		t.Fatal(err)
	}
	plan, err := ResolveHookCursorPlan([]string{home}, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.UsesProfileCursors || plan.CursorNames[0] != HookProfileCursorName(home) {
		t.Fatalf("plan = %+v", plan)
	}
}

// The same home's own hash keeps the legacy cursor in use, so a collector
// restart does not fork a profile cursor for the profile that already had
// one.
func TestHookProfilePlanAcceptsTheLegacyCursorFromTheSameProfile(t *testing.T) {
	stateDir := t.TempDir()
	home := filepath.Join(stateDir, "home")
	legacy := sessioncursor.NewState("codex")
	if err := legacy.SetExtra("codexHookProfileHash", hookProfileHash(home)); err != nil {
		t.Fatal(err)
	}
	if err := sessioncursor.Write(filepath.Join(stateDir, "codex-cursor.json"), legacy); err != nil {
		t.Fatal(err)
	}
	plan, err := ResolveHookCursorPlan([]string{home}, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if plan.UsesProfileCursors {
		t.Fatalf("plan = %+v", plan)
	}
}

// Same relative session paths under two homes are independent: each profile
// cursor records its own file, and a change in one does not acknowledge the
// other.
func TestHookProfilesKeepSameRelativePathsInIndependentCursors(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "session.jsonl")
	writeHookJSONL(t, filepath.Join(firstHome, "sessions", relative), tokenCountEvent("2026-05-22T01:00:00.000Z", 10, "gpt-5"))
	writeHookJSONL(t, filepath.Join(secondHome, "sessions", relative), tokenCountEvent("2026-05-22T02:00:00.000Z", 20, "gpt-5"))

	result, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || len(result.ChangedKeys) != 1 {
		t.Fatalf("result = %+v", result)
	}
	// A first run parses the files; the snapshots ride on the changed dates
	// rather than the pending cache, exactly as the TS result shape does.
	if len(result.CachedSnapshots) != 0 {
		t.Errorf("cached = %+v", result.CachedSnapshots)
	}
	firstCursor := readCursorFiles(t, filepath.Join(stateDir, HookProfileCursorName(firstHome)))
	secondCursor := readCursorFiles(t, filepath.Join(stateDir, HookProfileCursorName(secondHome)))
	if firstCursor["2026/05/22/session.jsonl"].Snapshots[0].TotalTokens != 10 {
		t.Errorf("first = %+v", firstCursor)
	}
	if secondCursor["2026/05/22/session.jsonl"].Snapshots[0].TotalTokens != 20 {
		t.Errorf("second = %+v", secondCursor)
	}
	if len(result.AcknowledgedByCursorScope) != 2 {
		t.Fatalf("acknowledgements = %+v", result.AcknowledgedByCursorScope)
	}
	if result.AcknowledgedByCursorScope[0].CursorScope != firstHome ||
		result.AcknowledgedByCursorScope[1].CursorScope != secondHome {
		t.Errorf("scopes = %+v", result.AcknowledgedByCursorScope)
	}
	for _, scoped := range result.AcknowledgedByCursorScope {
		if len(scoped.Files) != 1 || scoped.Files[0].RelativePath != "2026/05/22/session.jsonl" {
			t.Errorf("files = %+v", scoped.Files)
		}
	}
}

// Reordering CODEX_HOME keeps every profile cursor stable: each home still
// resolves to its own hashed cursor, so an unchanged tree produces no work.
func TestHookProfilesKeepCursorsStableWhenHomeOrderChanges(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "session.jsonl")
	writeHookJSONL(t, filepath.Join(secondHome, "sessions", relative), tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))

	first, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed {
		t.Fatal("the first run must see the new session")
	}
	secondCursorPath := filepath.Join(stateDir, HookProfileCursorName(secondHome))
	if err := sessioncursor.AcknowledgePendingUploads(sessioncursor.AcknowledgeInput{
		StateDir:           stateDir,
		Source:             contract.SourceCodex,
		CursorScope:        secondHome,
		AcknowledgedGroups: map[string]bool{"codex\x002026-05-22\x00Asia/Shanghai\x00gpt-5": true},
	}); err != nil {
		t.Fatal(err)
	}

	reordered := hookProfileInput([]string{secondHome, firstHome}, stateDir)
	reordered.CollectedAt = "2026-05-22T10:01:00.000Z"
	second, err := CollectHookProfiles(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed {
		t.Fatalf("reordered run = %+v", second)
	}
	if entry := readCursorFiles(t, secondCursorPath)["2026/05/22/session.jsonl"]; entry.PendingUpload != nil && *entry.PendingUpload {
		t.Error("the acknowledged profile cursor must stay acknowledged")
	}
}

// Identical deleted pending sessions across two profiles are restored once:
// the merged result deduplicates by snapshot identity, not by file.
func TestHookProfilesDeduplicateIdenticalDeletedPendingSessions(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "session.jsonl")
	firstSession := filepath.Join(firstHome, "sessions", relative)
	secondSession := filepath.Join(secondHome, "sessions", relative)
	writeHookJSONL(t, firstSession, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	writeHookJSONL(t, secondSession, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))

	first, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed {
		t.Fatalf("the first run must see the new sessions: %+v", first)
	}
	if err := os.Remove(firstSession); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(secondSession); err != nil {
		t.Fatal(err)
	}
	second := hookProfileInput([]string{firstHome, secondHome}, stateDir)
	second.CollectedAt = "2026-05-22T10:01:00.000Z"
	result, err := CollectHookProfiles(second)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || len(result.CachedSnapshots) != 1 {
		t.Fatalf("deleted pending sessions must ride along once: %+v", result.CachedSnapshots)
	}
	if result.CachedSnapshots[0].TotalTokens != 15 || result.CachedSnapshots[0].SessionCount != 1 {
		t.Errorf("snapshot = %+v", result.CachedSnapshots[0])
	}
	if len(result.ReusablePendingSnapshots) != 0 {
		t.Errorf("a snapshot whose file is gone is not reusable: %+v", result.ReusablePendingSnapshots)
	}
}

// Unresolved context pricing is derived from the deduplicated pending entry,
// so a marker on one copy and not the other still reports the snapshot once.
func TestHookProfilesDeriveUnresolvedPricingFromTheDeduplicatedEntry(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := "2026/05/22/deleted.jsonl"
	size, digest := 15.0, strings.Repeat("a", 64)
	writeCursorFile(t, cursorFileInput{
		cursorPath: filepath.Join(stateDir, HookProfileCursorName(firstHome)), relativePath: relative,
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
		model: "gpt-5.6-sol", costUsd: 0.01, contextPricingPending: true,
	})
	writeCursorFile(t, cursorFileInput{
		cursorPath: filepath.Join(stateDir, HookProfileCursorName(secondHome)), relativePath: relative,
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
		model: "gpt-5.6-sol", costUsd: 0.01,
	})

	result, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.CachedSnapshots) != 1 || result.CachedSnapshots[0].Model != "gpt-5.6-sol" {
		t.Fatalf("cached = %+v", result.CachedSnapshots)
	}
	if len(result.UnresolvedContextPricing) != 1 || result.UnresolvedContextPricing[0].Model != "gpt-5.6-sol" {
		t.Fatalf("unresolved = %+v", result.UnresolvedContextPricing)
	}
}

// The pending-only path runs when the migration leaves pending entries behind
// in the legacy cursor: a deleted session with no matching file anywhere is
// still reported so its usage can upload.
func TestHookProfilesRecoverLegacyPendingCursorAfterSwitchingToMultipleProfiles(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/legacy.jsonl",
		totalTokens: 15, size: 1, sha256: strings.Repeat("a", 64), pendingUpload: true,
	})

	result, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || len(result.CachedSnapshots) != 1 || result.CachedSnapshots[0].TotalTokens != 15 {
		t.Fatalf("result = %+v", result)
	}
	if len(result.AcknowledgedByCursorScope) != 3 {
		t.Fatalf("the legacy run reports its own empty scope: %+v", result.AcknowledgedByCursorScope)
	}
	if result.AcknowledgedByCursorScope[2].CursorScope != "" {
		t.Errorf("legacy scope = %+v", result.AcknowledgedByCursorScope[2])
	}
}

// A legacy entry whose content matches one home is copied into that home's
// profile cursor and cleared from the legacy cursor.
func TestHookProfilesMigrateALegacyEntryMatchedByContent(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "legacy-copy.jsonl")
	firstSession := filepath.Join(firstHome, "sessions", relative)
	secondSession := filepath.Join(secondHome, "sessions", relative)
	writeHookJSONL(t, firstSession, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	writeHookJSONL(t, secondSession, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	size, digest := fileFingerprint(t, firstSession)
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/legacy-copy.jsonl",
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
	})

	if _, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir)); err != nil {
		t.Fatal(err)
	}
	if files := readCursorFiles(t, legacyCursorPath); len(files) != 0 {
		t.Errorf("the matched legacy entry must be cleared: %+v", files)
	}
	for _, home := range []string{firstHome, secondHome} {
		files := readCursorFiles(t, filepath.Join(stateDir, HookProfileCursorName(home)))
		if _, ok := files["2026/05/22/legacy-copy.jsonl"]; !ok {
			t.Errorf("%s did not receive the copied entry: %+v", home, files)
		}
	}
}

// The digest dispatch is what makes this migration work at all: the entry was
// written by the current collector, so its digest is blake2b512 and the cursor
// records contentHashAlgo. Hashing with sha256 regardless (the pre-fix
// behavior) matches nothing and drops the entry.
func TestHookProfilesMigrateALegacyEntryWithACurrentDigest(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "current-hash.jsonl")
	sessionFile := filepath.Join(firstHome, "sessions", relative)
	writeHookJSONL(t, sessionFile, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	content, err := os.ReadFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	digest, _, err := sessionfileFingerprintBlake2b(content)
	if err != nil {
		t.Fatal(err)
	}
	if len(digest) != 128 {
		t.Fatalf("digest = %q", digest)
	}
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/current-hash.jsonl",
		totalTokens: 15, size: float64(info.Size()), sha256: digest,
		contentHashAlgo: "blake2b512", pendingUpload: true,
	})

	if _, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir)); err != nil {
		t.Fatal(err)
	}
	if files := readCursorFiles(t, legacyCursorPath); len(files) != 0 {
		t.Errorf("the entry must be migrated, not left behind: %+v", files)
	}
	if files := readCursorFiles(t, filepath.Join(stateDir, HookProfileCursorName(firstHome))); len(files) == 0 {
		t.Error("the first home must receive the migrated entry")
	}
}

// An entry that matches no file anywhere stays in the legacy cursor while it
// is pending; dropping it would lose usage the server never acknowledged.
func TestHookProfilesKeepUnmatchedPendingLegacyEntries(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/gone.jsonl",
		totalTokens: 15, size: 1, sha256: strings.Repeat("a", 64), pendingUpload: true,
	})

	if _, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir)); err != nil {
		t.Fatal(err)
	}
	files := readCursorFiles(t, legacyCursorPath)
	if entry, ok := files["2026/05/22/gone.jsonl"]; !ok || entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Fatalf("the pending legacy entry must stay: %+v", files)
	}
}

// An acknowledged legacy entry that matches nothing is dropped, not carried
// forever: its usage already reached the server.
func TestHookProfilesDropAcknowledgedUnmatchedLegacyEntries(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/gone.jsonl",
		totalTokens: 15, size: 1, sha256: strings.Repeat("a", 64),
	})

	if _, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir)); err != nil {
		t.Fatal(err)
	}
	if files := readCursorFiles(t, legacyCursorPath); len(files) != 0 {
		t.Errorf("acknowledged unmatched entries must be dropped: %+v", files)
	}
}

// A legacy pending entry already present in a profile cursor (same relative
// path, same digest) is dropped without reading the source file: the profile
// cursor is the authority and the file may be gone.
func TestHookProfilesDropALegacyEntryAlreadyPersistedInAProfileCursor(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	digest := strings.Repeat("a", 64)
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/acknowledged-missing.jsonl",
		totalTokens: 15, size: 123, sha256: digest, pendingUpload: true,
	})
	writeCursorFile(t, cursorFileInput{
		cursorPath:   filepath.Join(stateDir, HookProfileCursorName(secondHome)),
		relativePath: "2026/05/22/acknowledged-missing.jsonl",
		totalTokens:  15, size: 123, sha256: digest,
	})

	if _, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir)); err != nil {
		t.Fatal(err)
	}
	if files := readCursorFiles(t, legacyCursorPath); len(files) != 0 {
		t.Errorf("the persisted entry must be dropped from the legacy cursor: %+v", files)
	}
}

// The active session path wins over an archived copy with the same relative
// path: matching the archived digest would copy the entry into a profile it
// does not belong to.
func TestHookProfilesDoNotLetAnArchivedCopyOverrideTheActiveSession(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	otherHome := filepath.Join(root, "other")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "reused.jsonl")
	activePath := filepath.Join(codexHome, "sessions", relative)
	archivedPath := filepath.Join(codexHome, "archived_sessions", relative)
	writeHookJSONL(t, activePath, tokenCountEvent("2026-05-22T01:00:00.000Z", 7, "gpt-5"))
	writeHookJSONL(t, archivedPath, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	size, digest := fileFingerprint(t, archivedPath)
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/reused.jsonl",
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
	})

	result, err := CollectHookProfiles(hookProfileInput([]string{codexHome, otherHome}, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.CachedSnapshots) != 1 || result.CachedSnapshots[0].TotalTokens != 15 {
		t.Fatalf("the pending legacy snapshot must ride along: %+v", result.CachedSnapshots)
	}
	files := readCursorFiles(t, legacyCursorPath)
	if entry, ok := files["2026/05/22/reused.jsonl"]; !ok || entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Fatalf("the unmatched pending entry must stay: %+v", files)
	}
}

// A legacy session path that is a symbolic link fails the migration loudly.
// The pending entry stays and no profile cursor is written.
func TestHookProfilesRejectALegacySessionSymlink(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "linked.jsonl")
	outsideSession := filepath.Join(root, "outside.jsonl")
	linkedSession := filepath.Join(secondHome, "sessions", relative)
	writeHookJSONL(t, outsideSession, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	if err := os.MkdirAll(filepath.Dir(linkedSession), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideSession, linkedSession); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	size, digest := fileFingerprint(t, outsideSession)
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/linked.jsonl",
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
	})

	_, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err == nil || !strings.Contains(err.Error(), "symbolic links are not supported") {
		t.Fatalf("err = %v", err)
	}
	files := readCursorFiles(t, legacyCursorPath)
	if entry, ok := files["2026/05/22/linked.jsonl"]; !ok || entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("the pending entry must survive the failed migration: %+v", files)
	}
	if _, statErr := os.Stat(filepath.Join(stateDir, HookProfileCursorName(secondHome))); !os.IsNotExist(statErr) {
		t.Errorf("no profile cursor may be written: %v", statErr)
	}
}

// An unauthorized symlinked session root fails the migration the same way the
// live scan would fail on it.
func TestHookProfilesRejectAnUnauthorizedSessionRootSymlink(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	outsideRoot := filepath.Join(root, "outside-sessions")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "linked-root.jsonl")
	outsideSession := filepath.Join(outsideRoot, relative)
	linkedRoot := filepath.Join(secondHome, "archived_sessions")
	writeHookJSONL(t, outsideSession, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	if err := os.MkdirAll(secondHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideRoot, linkedRoot); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	size, digest := fileFingerprint(t, outsideSession)
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/linked-root.jsonl",
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
	})

	_, err := CollectHookProfiles(hookProfileInput([]string{firstHome, secondHome}, stateDir))
	if err == nil || !strings.Contains(err.Error(), "symbolic links are not supported") {
		t.Fatalf("err = %v", err)
	}
	files := readCursorFiles(t, legacyCursorPath)
	if entry, ok := files["2026/05/22/linked-root.jsonl"]; !ok || entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("the pending entry must survive the failed migration: %+v", files)
	}
}

// A legacy pending cursor whose session moved into archived_sessions is still
// matched: the migration resolves both roots.
func TestHookProfilesMigrateALegacyPendingCursorForAnArchivedSession(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "legacy.jsonl")
	archivedPath := filepath.Join(codexHome, "archived_sessions", relative)
	writeHookJSONL(t, archivedPath, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	size, digest := fileFingerprint(t, archivedPath)
	legacyCursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeCursorFile(t, cursorFileInput{
		cursorPath: legacyCursorPath, relativePath: "2026/05/22/legacy.jsonl",
		totalTokens: 15, size: size, sha256: digest, pendingUpload: true,
	})

	// A profile cursor for this home already exists, which is what forces the
	// migration for a single home.
	writeCursorFile(t, cursorFileInput{
		cursorPath:   filepath.Join(stateDir, HookProfileCursorName(codexHome)),
		relativePath: "2026/05/22/other.jsonl",
		totalTokens:  1, size: 1, sha256: strings.Repeat("b", 64),
	})
	if _, err := CollectHookProfiles(hookProfileInput([]string{codexHome}, stateDir)); err != nil {
		t.Fatal(err)
	}
	if files := readCursorFiles(t, legacyCursorPath); len(files) != 0 {
		t.Errorf("the archived session must be migrated: %+v", files)
	}
	profileFiles := readCursorFiles(t, filepath.Join(stateDir, HookProfileCursorName(codexHome)))
	if _, ok := profileFiles["2026/05/22/legacy.jsonl"]; !ok {
		t.Errorf("the profile cursor must receive the entry: %+v", profileFiles)
	}
}

// An unknown content hash algorithm fails closed: guessing would compare two
// digests that were never meant to be equal and silently drop the entry.
func TestHookProfilesRejectAnUnknownContentHashAlgorithm(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	stateDir := filepath.Join(root, "state")
	relative := filepath.Join("2026", "05", "22", "unknown.jsonl")
	sessionFile := filepath.Join(home, "sessions", relative)
	writeHookJSONL(t, sessionFile, tokenCountEvent("2026-05-22T01:00:00.000Z", 15, "gpt-5"))
	size, digest := fileFingerprint(t, sessionFile)
	writeCursorFile(t, cursorFileInput{
		cursorPath:   filepath.Join(stateDir, "codex-cursor.json"),
		relativePath: "2026/05/22/unknown.jsonl",
		totalTokens:  15, size: size, sha256: digest,
		contentHashAlgo: "sha3-256", pendingUpload: true,
	})

	_, err := CollectHookProfiles(hookProfileInput([]string{home, filepath.Join(root, "other")}, stateDir))
	if err == nil || !strings.Contains(err.Error(), "Unsupported session content hash algorithm") {
		t.Fatalf("err = %v", err)
	}
}

// sessionfileFingerprintBlake2b hashes content with the current algorithm. The
// migration dispatches on the entry's recorded contentHashAlgo, so a test that
// builds a current-collector entry must use the same digest the collector
// writes.
func sessionfileFingerprintBlake2b(content []byte) (string, int, error) {
	hasher, err := sessionfile.NewContentHasherFor(sessionfile.ContentHashAlgorithm)
	if err != nil {
		return "", 0, err
	}
	if _, err := hasher.Write(content); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hasher.Sum(nil)), len(content), nil
}

func hookItoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
