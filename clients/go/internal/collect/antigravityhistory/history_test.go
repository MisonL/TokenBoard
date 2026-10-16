package antigravityhistory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"

	dbsql "database/sql"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sqlite"
)

func hashOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// declinedCascadeID builds a conversation id in the shape the directory filter
// accepts: a lowercase UUID.
func cascadeID(index int) string {
	return fmt.Sprintf("00000000-0000-0000-0000-%012d", index)
}

func intPtr(value int) *int { return &value }

// conversationsDir creates the conversations directory under a fresh temp root.
func conversationsDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "conversations")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// recordSQLiteCalls returns a reader that records the database each query ran
// against and returns no rows.
func recordSQLiteCalls(calls *[]string) ReadSQLite {
	return func(dbFile, _ string) (string, error) {
		*calls = append(*calls, dbFile)
		return "", nil
	}
}

var pageCursorPattern = regexp.MustCompile(`idx > (-?\d+)`)

// rowsForQuery answers a page query with rows between minimum and maximum,
// capped at the page size, in the CLI's `idx|hex` rendering.
func rowsForQuery(sql string, minimum, maximum int) string {
	match := pageCursorPattern.FindStringSubmatch(sql)
	if match == nil {
		return ""
	}
	cursor, _ := strconv.Atoi(match[1])
	start := cursor + 1
	if start < minimum {
		start = minimum
	}
	if start > maximum {
		return ""
	}
	end := start + GeneratorMetadataRowsPageSize - 1
	if end > maximum {
		end = maximum
	}
	var out []byte
	for index := start; index <= end; index++ {
		out = append(out, []byte(strconv.Itoa(index)+"|\n")...)
	}
	return string(out)
}

func TestFailsVisiblyWhenTheConversationsDirectoryIsMissing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	_, err := ReadUsageEvents(Options{ConversationDir: missing})
	if err == nil || err.Error() != "Antigravity conversations directory not found: "+missing {
		t.Fatalf("error = %v, want the missing-directory report", err)
	}
}

func TestFailsVisiblyInsteadOfTruncatingBeyondTheSafetyBound(t *testing.T) {
	listed := 0
	_, err := ReadUsageEvents(Options{
		ConversationDir: "/tmp/tokenboard-antigravity-overflow-databases",
		MaxDbFiles:      intPtr(2),
		ListFiles: func(_ string, yield func(antigravityscan.DirectoryEntry) error) error {
			for index := 0; index <= 10_000; index++ {
				listed++
				if err := yield(antigravityscan.DirectoryEntry{
					Name: cascadeID(index) + ".db", IsFile: true,
				}); err != nil {
					return err
				}
			}
			return nil
		},
		StatFile: func(string) (StatResult, error) { return StatResult{MtimeMs: 1}, nil },
	})
	if err == nil || !regexp.MustCompile(`exceeds the 10000-entry scan limit`).MatchString(err.Error()) {
		t.Fatalf("error = %v, want the entry-limit report", err)
	}
	if listed != 10_001 {
		t.Errorf("listed = %d, want 10001", listed)
	}
}

// This source used to call the sqlite3 executable unconditionally, so a machine
// without it on PATH reported the whole source unavailable. It now goes through
// the shared reader, whose embedded path needs nothing installed. The SQL
// renders its result set as text (`idx|hex` lines) rather than JSON, so the two
// readers have to agree byte for byte or a cursor would hash differently
// depending on which one ran.
func TestReadsThroughTheEmbeddedAndExecutableReadersIdentically(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000002"
	dbPath := filepath.Join(dir, conversationID+".db")
	seedGenMetadata(t, dbPath,
		"CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);",
		// Empty and null blobs: both render as an empty field, which is the
		// shape where the two readers are most likely to disagree, and neither
		// needs a valid protobuf body for the row index to be read.
		"INSERT INTO gen_metadata VALUES (3, x''), (4, NULL), (5, x'');",
	)

	embedded, err := ReadUsageEvents(Options{ConversationDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	// Both readers must land on the same high-water row index for the same
	// database.
	if got := embedded.LastReadRowIndexByCascade[conversationID]; got != 5 {
		t.Fatalf("embedded last read = %d, want 5", got)
	}

	if _, lookErr := exec.LookPath("sqlite3"); lookErr != nil {
		t.Skip("sqlite3 executable not installed; the embedded reader is covered above")
	}
	t.Setenv("TOKENBOARD_SQLITE_BIN", "sqlite3")
	external, err := ReadUsageEvents(Options{ConversationDir: dir, SQLiteBin: strPtr("sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	if got := external.LastReadRowIndexByCascade[conversationID]; got != embedded.LastReadRowIndexByCascade[conversationID] {
		t.Errorf("external last read = %d, want %d", got, embedded.LastReadRowIndexByCascade[conversationID])
	}
}

func TestDoesNotMarkCascadesAsCoveredWhenNoUsableEventsAreParsed(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      func(string, string) (string, error) { return "7|\n", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 0 {
		t.Errorf("events = %d, want 0", len(result.Events))
	}
	if len(result.CascadeIDs) != 0 {
		t.Errorf("cascadeIds = %v, want none", result.CascadeIDs)
	}
	if !result.CompleteDirectoryScan {
		t.Error("completeDirectoryScan = false, want true")
	}
	if !result.KnownCascadeIDs[conversationID] || len(result.KnownCascadeIDs) != 1 {
		t.Errorf("knownCascadeIds = %v, want just %s", result.KnownCascadeIDs, conversationID)
	}
	if got := result.LastReadRowIndexByCascade[conversationID]; got != 7 {
		t.Errorf("last read = %d, want 7", got)
	}
}

func TestConsidersANewerSQLiteWALMtimeWhenApplyingASinceFilter(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	walPath := filepath.Join(dir, conversationID+".db-wal")
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")
	writeFile(t, walPath, "wal")
	walTime := time.Date(2026, 6, 24, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(walPath, walTime, walTime); err != nil {
		t.Fatal(err)
	}

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      func(string, string) (string, error) { return "", nil },
		SinceDate:       "2026-06-24",
		Timezone:        "UTC",
		StatFile: func(string) (StatResult, error) {
			return StatResult{MtimeMs: float64(time.Date(2026, 6, 23, 0, 0, 0, 0, time.UTC).UnixMilli())}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.LastReadRowIndexByCascade[conversationID]; got != -1 {
		t.Errorf("last read = %d, want -1 (the WAL freshness must include the file)", got)
	}
}

func TestReadsAnUnprocessedDatabaseWhoseMtimePredatesTheBoundedSinceDate(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      func(string, string) (string, error) { return "7|\n", nil },
		SinceDate:       "2026-06-24",
		Timezone:        "UTC",
		StatFile: func(string) (StatResult, error) {
			return StatResult{MtimeMs: float64(time.Date(2026, 6, 23, 0, 0, 0, 0, time.UTC).UnixMilli())}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.LastReadRowIndexByCascade[conversationID]; got != 7 {
		t.Errorf("last read = %d, want 7 (an unread database is never filtered out)", got)
	}
}

func TestRecordsASuccessfulEmptyDatabaseScanSoBoundedBacklogSelectionCanAdvance(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	scanState := antigravityscan.NewFileScanState()
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      func(string, string) (string, error) { return "", nil },
		ScanState:       &scanState,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.LastReadRowIndexByCascade[conversationID]; got != -1 {
		t.Errorf("last read = %d, want -1", got)
	}
	entry, ok := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	if !ok {
		t.Fatal("scan entry missing")
	}
	if entry.MetadataCursorRowIndex == nil || *entry.MetadataCursorRowIndex != -1 {
		t.Errorf("metadataCursorRowIndex = %v, want -1", entry.MetadataCursorRowIndex)
	}
	if entry.MetadataCursorRowSHA256 == nil || *entry.MetadataCursorRowSHA256 != hashOf("") {
		t.Errorf("metadataCursorRowSha256 = %v, want the empty-blob hash", entry.MetadataCursorRowSHA256)
	}
}

func TestReturnsEveryEnumeratedCascadeAsKnownEvenWhenABoundedReadSelectsOne(t *testing.T) {
	dir := conversationsDir(t)
	ids := []string{cascadeID(1), cascadeID(2), cascadeID(3)}
	for _, id := range ids {
		writeFile(t, filepath.Join(dir, id+".db"), "")
	}

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      func(string, string) (string, error) { return "", nil },
		MaxDbFiles:      intPtr(1),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.KnownCascadeIDs) != 3 {
		t.Errorf("knownCascadeIds = %v, want all three", result.KnownCascadeIDs)
	}
	if result.CompleteDirectoryScan {
		t.Error("completeDirectoryScan = true, want false under a bounded read")
	}
	if len(result.LastReadRowIndexByCascade) != 1 {
		t.Errorf("read %d databases, want 1", len(result.LastReadRowIndexByCascade))
	}
}

func TestBoundsMetadataReadsByTheStoredPerCascadeRowCursor(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")
	actualQuery := ""

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite: func(_ string, sql string) (string, error) {
			actualQuery = sql
			return "", nil
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500"
	if actualQuery != want {
		t.Errorf("query = %q, want %q", actualQuery, want)
	}
}

func TestFailsExplicitlyWhenACompactedCursorIsAheadOfARecreatedDatabase(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	dbFile := filepath.Join(dir, conversationID+".db")
	writeFile(t, dbFile, "")
	readSQLite := func(_ string, sql string) (string, error) {
		if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
			return "7\n", nil
		}
		return "", nil
	}

	_, err := ReadUsageEvents(Options{
		ConversationDir:               dir,
		ReadSQLite:                    readSQLite,
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          true,
	})
	if !IsRowCursorResetError(err) {
		t.Fatalf("error = %v, want a row-cursor reset", err)
	}
	want := "Antigravity SQLite metadata cursor reset detected for " + dbFile + "; rerun with --since all"
	if err.Error() != want {
		t.Errorf("message = %q, want %q", err.Error(), want)
	}
}

func TestChecksForAResetBeforeAcknowledgingANonEmptyCursorPage(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")
	var queries []string

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
				return "7\n", nil
			}
			return "42|\n43|\n", nil
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          true,
	})
	if !IsRowCursorResetError(err) {
		t.Fatalf("error = %v, want a row-cursor reset", err)
	}
	want := []string{
		"select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500",
		"select max(idx) from gen_metadata",
	}
	if len(queries) != len(want) {
		t.Fatalf("queries = %v, want %v", queries, want)
	}
	for index := range want {
		if queries[index] != want[index] {
			t.Fatalf("queries = %v, want %v", queries, want)
		}
	}
}

func TestDetectsARebuiltDatabaseWhenTheRecreatedHighWaterStillExceedsTheCursor(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	dbFile := filepath.Join(dir, conversationID+".db")
	scanState := antigravityscan.NewFileScanState()
	var queries []string
	writeFile(t, dbFile, "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
				return "100\n", nil
			}
			var out []byte
			for index := 0; index <= 100; index++ {
				out = append(out, []byte(strconv.Itoa(index)+"|\n")...)
			}
			return string(out), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	if entry.MetadataRowHighWater == nil || *entry.MetadataRowHighWater != 100 {
		t.Fatalf("metadataRowHighWater = %v, want 100", entry.MetadataRowHighWater)
	}
	emptyHash := hashOf("")
	index41 := int64(41)
	entry.MetadataCursorRowIndex = &index41
	entry.MetadataCursorRowSHA256 = &emptyHash
	antigravityscan.MarkFileScanned(&scanState, conversationID, entry, entry.CheckedSequence)

	_, err = ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			switch {
			case regexp.MustCompile(`max\(idx\)`).MatchString(sql):
				return "50\n", nil
			case regexp.MustCompile(`where idx in`).MatchString(sql):
				return "41|\n", nil
			default:
				return "42|\n43|\n", nil
			}
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          true,
	})
	if !IsRowCursorResetError(err) {
		t.Fatalf("error = %v, want a row-cursor reset", err)
	}
	want := []string{
		"select idx, hex(data) from gen_metadata where idx > -1 order by idx limit 500",
		"select idx, hex(data) from gen_metadata where idx in (41) order by idx",
		"select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500",
		"select max(idx) from gen_metadata",
	}
	if len(queries) != len(want) {
		t.Fatalf("queries = %v, want %v", queries, want)
	}
	for index := range want {
		if queries[index] != want[index] {
			t.Fatalf("queries = %v, want %v", queries, want)
		}
	}
}

func TestKeepsTheHighWaterMarkAtTheEndOfAMultiPageIncrementalRead(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	scanState := antigravityscan.NewFileScanState()
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			return rowsForQuery(sql, 0, 1000), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	if entry.MetadataRowHighWater == nil || *entry.MetadataRowHighWater != 1000 {
		t.Fatalf("metadataRowHighWater = %v, want 1000", entry.MetadataRowHighWater)
	}
	if entry.MetadataCursorRowIndex == nil || *entry.MetadataCursorRowIndex != 1000 {
		t.Fatalf("metadataCursorRowIndex = %v, want 1000", entry.MetadataCursorRowIndex)
	}

	_, err = ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			switch {
			case regexp.MustCompile(`where idx in`).MatchString(sql):
				return "1000|\n", nil
			case regexp.MustCompile(`max\(idx\)`).MatchString(sql):
				return "1500\n", nil
			default:
				return rowsForQuery(sql, 1001, 1500), nil
			}
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 1000},
		DetectRowCursorReset:          true,
	})
	if err != nil {
		t.Fatal(err)
	}
	updated, _ := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	if updated.MetadataRowHighWater == nil || *updated.MetadataRowHighWater != 1500 {
		t.Errorf("metadataRowHighWater = %v, want 1500", updated.MetadataRowHighWater)
	}
	if updated.MetadataCursorRowIndex == nil || *updated.MetadataCursorRowIndex != 1500 {
		t.Errorf("metadataCursorRowIndex = %v, want 1500", updated.MetadataCursorRowIndex)
	}
}

func TestFailsClosedForALegacyScanStateWithoutARowContinuityAnchor(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	scanState := antigravityscan.NewFileScanState()
	var queries []string
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
				return "41\n", nil
			}
			return "41|\n", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	entry.MetadataCursorRowIndex = nil
	entry.MetadataCursorRowSHA256 = nil
	antigravityscan.MarkFileScanned(&scanState, conversationID, entry, entry.CheckedSequence)

	_, err = ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			return "42|\n", nil
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          true,
	})
	if !IsRowCursorResetError(err) {
		t.Fatalf("error = %v, want a row-cursor reset", err)
	}
	if len(queries) != 0 {
		t.Errorf("queries = %v, want none before the reset report", queries)
	}
}

func TestFailsClosedWhenARowContinuityAnchorIsOnlyPartiallyPersisted(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	scanState := antigravityscan.NewFileScanState()
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
				return "41\n", nil
			}
			return "41|\n", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	entry.MetadataCursorRowSHA256 = nil
	antigravityscan.MarkFileScanned(&scanState, conversationID, entry, entry.CheckedSequence)

	_, err = ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(string, string) (string, error) {
			return "", errors.New("SQLite must not be queried with a partial anchor")
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          true,
	})
	if !IsRowCursorResetError(err) {
		t.Fatalf("error = %v, want a row-cursor reset", err)
	}
}

func TestDoesNotPersistAnUnpairedCursorIndexWhenAnUnanchoredIncrementalPageIsEmpty(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	emptyHash := hashOf("")
	index40 := int64(40)
	highWater41 := int64(41)
	scanState := antigravityscan.NewFileScanState()
	scanState.Files[scanKey(conversationID)] = antigravityscan.FileScanEntry{
		MtimeMs:                 1,
		Size:                    0,
		HasDatabaseFile:         true,
		CheckedSequence:         0,
		MetadataRowHighWater:    &highWater41,
		MetadataCursorRowIndex:  &index40,
		MetadataCursorRowSHA256: &emptyHash,
	}
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	_, err := ReadUsageEvents(Options{
		ConversationDir:               dir,
		ScanState:                     &scanState,
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          false,
		ReadSQLite: func(_ string, sql string) (string, error) {
			if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
				return "41\n", nil
			}
			return "", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, _ := antigravityscan.ReadFileScanEntry(&scanState, conversationID)
	if entry.MetadataRowHighWater == nil || *entry.MetadataRowHighWater != 41 {
		t.Errorf("metadataRowHighWater = %v, want 41", entry.MetadataRowHighWater)
	}
	if entry.MetadataCursorRowIndex != nil {
		t.Errorf("metadataCursorRowIndex = %v, want absent", *entry.MetadataCursorRowIndex)
	}
	if entry.MetadataCursorRowSHA256 != nil {
		t.Errorf("metadataCursorRowSha256 = %v, want absent", *entry.MetadataCursorRowSHA256)
	}
}

func TestRejectsAChangedCursorAnchorBeforeReadingANonEmptyRebuiltPage(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	dbFile := filepath.Join(dir, conversationID+".db")
	scanState := antigravityscan.NewFileScanState()
	var queries []string
	writeFile(t, dbFile, "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			if regexp.MustCompile(`max\(idx\)`).MatchString(sql) {
				return "41\n", nil
			}
			return "41|\n", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = ReadUsageEvents(Options{
		ConversationDir: dir,
		ScanState:       &scanState,
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			switch {
			case regexp.MustCompile(`where idx in`).MatchString(sql):
				return "41|AA\n", nil
			case regexp.MustCompile(`max\(idx\)`).MatchString(sql):
				return "50\n", nil
			default:
				return "42|\n43|\n", nil
			}
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
		DetectRowCursorReset:          true,
	})
	if !IsRowCursorResetError(err) {
		t.Fatalf("error = %v, want a row-cursor reset", err)
	}
	want := []string{"select idx, hex(data) from gen_metadata where idx in (41) order by idx"}
	if len(queries) != len(want) || queries[0] != want[0] {
		t.Errorf("queries = %v, want %v", queries, want)
	}
}

func TestDoesNotAcknowledgeARowWhenANestedSQLiteUsageBlockIsSemanticallyInvalid(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	lastSeen := map[string]int64{hashOf(conversationID): 41}
	// A blob whose primary usage block is valid but whose optional nested
	// block (17.2) carries an out-of-range token field.
	invalidNestedUsageHex := "0A472216100A18025A10726573706F6E73652D7072696D6172798A01191217108194EBDC035A0F726573706F6E73652D6E65737465649A011067656D696E692D332D666C6173682D61220B657865637574696F6E2D61"
	var queries []string
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	read := func() error {
		_, err := ReadUsageEvents(Options{
			ConversationDir: dir,
			ReadSQLite: func(_ string, sql string) (string, error) {
				queries = append(queries, sql)
				return "42|" + invalidNestedUsageHex + "\n", nil
			},
			LastSeenRowIndexByCascadeHash: lastSeen,
		})
		return err
	}
	for attempt := 0; attempt < 2; attempt++ {
		err := read()
		if err == nil || !regexp.MustCompile(`token field 2 is invalid`).MatchString(err.Error()) {
			t.Fatalf("error = %v, want the nested-token rejection", err)
		}
	}

	if lastSeen[hashOf(conversationID)] != 41 {
		t.Error("the caller's cursor map must not advance on a failed read")
	}
	query := "select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500"
	want := []string{query, query}
	if len(queries) != len(want) || queries[0] != want[0] || queries[1] != want[1] {
		t.Errorf("queries = %v, want %v", queries, want)
	}
}

func TestRejectsANonIntegerSQLiteMetadataRowIndexInsteadOfTruncatingIt(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	dbFile := filepath.Join(dir, conversationID+".db")
	writeFile(t, dbFile, "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      func(string, string) (string, error) { return "7invalid|\n", nil },
	})
	if err == nil || err.Error() != "Invalid Antigravity SQLite metadata row in "+dbFile {
		t.Fatalf("error = %v, want the invalid-row report", err)
	}
}

func TestPagesLargeMetadataBacklogsAndAdvancesTheRowCursorBetweenCalls(t *testing.T) {
	dir := conversationsDir(t)
	conversationID := "00000000-0000-0000-0000-000000000001"
	var queries []string
	writeFile(t, filepath.Join(dir, conversationID+".db"), "")

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			if regexp.MustCompile(`idx > 41 `).MatchString(sql) {
				var out []byte
				for index := 42; index < 542; index++ {
					out = append(out, []byte(strconv.Itoa(index)+"|\n")...)
				}
				return string(out), nil
			}
			if regexp.MustCompile(`idx > 541 `).MatchString(sql) {
				return "542|\n", nil
			}
			return "", nil
		},
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(conversationID): 41},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500",
		"select idx, hex(data) from gen_metadata where idx > 541 order by idx limit 500",
	}
	if len(queries) != len(want) {
		t.Fatalf("queries = %v, want %v", queries, want)
	}
	for index := range want {
		if queries[index] != want[index] {
			t.Fatalf("queries = %v, want %v", queries, want)
		}
	}
	if len(result.Events) != 0 {
		t.Errorf("events = %d, want 0", len(result.Events))
	}
	if got := result.LastReadRowIndexByCascade[conversationID]; got != 542 {
		t.Errorf("last read = %d, want 542", got)
	}
}

func TestReadsOnlyTheMostRecentBoundedDbFiles(t *testing.T) {
	dir := conversationsDir(t)
	var calls []string
	oldID, middleID, recentID := cascadeID(1), cascadeID(2), cascadeID(3)
	for _, id := range []string{oldID, middleID, recentID} {
		writeFile(t, filepath.Join(dir, id+".db"), "")
	}
	setMtime(t, filepath.Join(dir, oldID+".db"), "2026-04-28T10:00:00.000Z")
	setMtime(t, filepath.Join(dir, middleID+".db"), "2026-04-28T10:01:00.000Z")
	setMtime(t, filepath.Join(dir, recentID+".db"), "2026-04-28T10:02:00.000Z")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      recordSQLiteCalls(&calls),
		MaxDbFiles:      intPtr(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, recentID+".db"), filepath.Join(dir, middleID+".db")}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Errorf("calls = %v, want %v", calls, want)
	}
}

func TestRebuildsOnlyAnUnanchoredDatabaseWithinTheBoundedFileBudget(t *testing.T) {
	dir := conversationsDir(t)
	first, second := cascadeID(1), cascadeID(2)
	var queries []string
	writeFile(t, filepath.Join(dir, first+".db"), "")
	writeFile(t, filepath.Join(dir, second+".db"), "")
	scanState := antigravityscan.NewFileScanState()

	result, err := ReadUsageEvents(Options{
		ConversationDir:               dir,
		MaxDbFiles:                    intPtr(1),
		ScanState:                     &scanState,
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(first): 41},
		DetectRowCursorReset:          true,
		ForceFullScanCascadeHashes:    map[string]bool{hashOf(first): true},
		ReadSQLite: func(_ string, sql string) (string, error) {
			queries = append(queries, sql)
			return "", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := result.LastReadRowIndexByCascade[first]; got != -1 {
		t.Errorf("last read = %d, want -1 (the forced rebuild starts from zero)", got)
	}
	want := []string{"select idx, hex(data) from gen_metadata where idx > -1 order by idx limit 500"}
	if len(queries) != len(want) || queries[0] != want[0] {
		t.Errorf("queries = %v, want %v", queries, want)
	}
	if result.CompleteDirectoryScan {
		t.Error("completeDirectoryScan = true, want false")
	}
}

func TestDoesNotTruncateForcedDatabaseRepairsAtTheMetadataScanLimit(t *testing.T) {
	dir := conversationsDir(t)
	ids := make([]string, 0, 20)
	forced := map[string]bool{}
	for index := 1; index <= 20; index++ {
		id := cascadeID(index)
		ids = append(ids, id)
		forced[hashOf(id)] = true
		writeFile(t, filepath.Join(dir, id+".db"), "")
	}
	var statted []string
	scanState := antigravityscan.NewFileScanState()

	result, err := ReadUsageEvents(Options{
		ConversationDir:            dir,
		MaxDbFiles:                 intPtr(1),
		ScanState:                  &scanState,
		ForceFullScanCascadeHashes: forced,
		StatFile: func(path string) (StatResult, error) {
			statted = append(statted, path)
			return StatResult{MtimeMs: 1}, nil
		},
		ReadSQLite: recordSQLiteCalls(&[]string{}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(statted) != len(ids) {
		t.Errorf("statted %d files, want all %d forced repairs", len(statted), len(ids))
	}
	if result.CompleteDirectoryScan {
		t.Error("completeDirectoryScan = true, want false")
	}
}

func TestPrioritizesUnreadDatabaseBacklogBeforeRevisitingRecentFiles(t *testing.T) {
	dir := conversationsDir(t)
	var calls []string
	oldID, middleID, recentID := cascadeID(1), cascadeID(2), cascadeID(3)
	oldDB := filepath.Join(dir, oldID+".db")
	middleDB := filepath.Join(dir, middleID+".db")
	recentDB := filepath.Join(dir, recentID+".db")
	for _, path := range []string{oldDB, middleDB, recentDB} {
		writeFile(t, path, "")
	}
	setMtime(t, oldDB, "2026-04-28T10:00:00.000Z")
	setMtime(t, middleDB, "2026-04-28T10:01:00.000Z")
	setMtime(t, recentDB, "2026-04-28T10:02:00.000Z")

	first, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      recordSQLiteCalls(&calls),
		MaxDbFiles:      intPtr(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0] != recentDB || calls[1] != middleDB {
		t.Fatalf("calls = %v, want [recent middle]", calls)
	}
	acknowledgedRows := map[string]int64{}
	for conversation, rowIndex := range first.LastReadRowIndexByCascade {
		acknowledgedRows[hashOf(conversation)] = rowIndex
	}
	calls = nil

	_, err = ReadUsageEvents(Options{
		ConversationDir:               dir,
		ReadSQLite:                    recordSQLiteCalls(&calls),
		MaxDbFiles:                    intPtr(2),
		LastSeenRowIndexByCascadeHash: acknowledgedRows,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0] != oldDB || calls[1] != recentDB {
		t.Errorf("calls = %v, want [old recent]", calls)
	}
}

func TestReservesReadCapacityForProcessedDatabasesWhileUnreadFilesRemain(t *testing.T) {
	dir := conversationsDir(t)
	var calls []string
	unreadOldID, unreadNewID, processedID := cascadeID(1), cascadeID(2), cascadeID(3)
	for _, id := range []string{unreadOldID, unreadNewID, processedID} {
		writeFile(t, filepath.Join(dir, id+".db"), "")
	}

	_, err := ReadUsageEvents(Options{
		ConversationDir:               dir,
		ReadSQLite:                    recordSQLiteCalls(&calls),
		MaxDbFiles:                    intPtr(2),
		LastSeenRowIndexByCascadeHash: map[string]int64{hashOf(processedID): 0},
		StatFile: func(path string) (StatResult, error) {
			suffix := filepath.Base(path)
			index, _ := strconv.Atoi(suffix[len(suffix)-15 : len(suffix)-3])
			return StatResult{MtimeMs: float64(index)}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, unreadNewID+".db"), filepath.Join(dir, processedID+".db")}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Errorf("calls = %v, want %v", calls, want)
	}
}

func TestBoundsDbMetadataStatsWhileSelectingRecentFilesFromALargeDirectory(t *testing.T) {
	dir := conversationsDir(t)
	var calls []string
	scanState := antigravityscan.NewFileScanState()
	for index := 0; index < 200; index++ {
		writeFile(t, filepath.Join(dir, cascadeID(index)+".db"), "")
	}
	statCount := 0

	entries := func(_ string, yield func(antigravityscan.DirectoryEntry) error) error {
		for index := 0; index < 200; index++ {
			if err := yield(antigravityscan.DirectoryEntry{Name: cascadeID(index) + ".db", IsFile: true}); err != nil {
				return err
			}
		}
		return nil
	}
	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      recordSQLiteCalls(&calls),
		MaxDbFiles:      intPtr(2),
		ListFiles:       entries,
		StatFile: func(path string) (StatResult, error) {
			statCount++
			return StatResult{MtimeMs: cascadeMtime(path)}, nil
		},
		ScanState: &scanState,
	})
	if err != nil {
		t.Fatal(err)
	}
	if statCount > 16 {
		t.Errorf("statted %d files, want at most 16", statCount)
	}
	want := []string{
		filepath.Join(dir, cascadeID(199)+".db"),
		filepath.Join(dir, cascadeID(198)+".db"),
	}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Errorf("calls = %v, want %v", calls, want)
	}
	if len(scanState.Files) != 16 {
		t.Errorf("scan state holds %d files, want 16", len(scanState.Files))
	}
}

func TestRotatesBoundedDbMetadataScansUntilMiddleFilesAreSelected(t *testing.T) {
	var calls []string
	scanState := antigravityscan.NewFileScanState()

	for run := 0; run < 24; run++ {
		statCount := 0
		_, err := ReadUsageEvents(Options{
			ConversationDir: "/tmp/tokenboard-antigravity-rotating-databases",
			ReadSQLite:      recordSQLiteCalls(&calls),
			MaxDbFiles:      intPtr(2),
			ListFiles: func(_ string, yield func(antigravityscan.DirectoryEntry) error) error {
				for index := 0; index < 200; index++ {
					if err := yield(antigravityscan.DirectoryEntry{Name: cascadeID(index) + ".db", IsFile: true}); err != nil {
						return err
					}
				}
				return nil
			},
			StatFile: func(path string) (StatResult, error) {
				statCount++
				mtime := cascadeMtime(path)
				if mtime == 100 {
					mtime = 10_000
				}
				return StatResult{MtimeMs: mtime}, nil
			},
			ScanState: &scanState,
		})
		if err != nil {
			t.Fatal(err)
		}
		if statCount > 16 {
			t.Fatalf("run %d statted %d files, want at most 16", run, statCount)
		}
	}

	if len(scanState.Files) != 200 {
		t.Errorf("scan state holds %d files, want all 200", len(scanState.Files))
	}
	target := filepath.Join("/tmp/tokenboard-antigravity-rotating-databases", cascadeID(100)+".db")
	found := false
	for _, call := range calls {
		if call == target {
			found = true
			break
		}
	}
	if !found {
		t.Error("the hottest file was never read across the rotation")
	}
}

func TestSkipsDbFilesThatDisappearBeforeStat(t *testing.T) {
	dir := conversationsDir(t)
	var calls []string
	skippedID, keptID := cascadeID(4), cascadeID(5)
	skippedDB := filepath.Join(dir, skippedID+".db")
	keptDB := filepath.Join(dir, keptID+".db")
	writeFile(t, skippedDB, "")
	writeFile(t, keptDB, "")

	result, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite:      recordSQLiteCalls(&calls),
		StatFile: func(path string) (StatResult, error) {
			if path == skippedDB {
				return StatResult{}, fs.ErrNotExist
			}
			mtime := float64(1000)
			if path == keptDB {
				mtime = 2000
			}
			return StatResult{MtimeMs: mtime}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != keptDB {
		t.Errorf("calls = %v, want just the surviving database", calls)
	}
	if result.CompleteDirectoryScan {
		t.Error("completeDirectoryScan = true, want false")
	}
}

func TestFailsARequiredCompleteScanWhenAnEnumeratedDatabaseDisappearsBeforeStat(t *testing.T) {
	dir := conversationsDir(t)
	skippedID, keptID := cascadeID(4), cascadeID(5)
	skippedDB := filepath.Join(dir, skippedID+".db")
	writeFile(t, skippedDB, "")
	writeFile(t, filepath.Join(dir, keptID+".db"), "")

	_, err := ReadUsageEvents(Options{
		ConversationDir:              dir,
		UnboundedDbFiles:             true,
		RequireCompleteDirectoryScan: true,
		StatFile: func(path string) (StatResult, error) {
			if path == skippedDB {
				return StatResult{}, fs.ErrNotExist
			}
			return StatResult{MtimeMs: 2000}, nil
		},
	})
	want := "Antigravity CLI full history scan could not read every enumerated SQLite database; " +
		"retry after the conversations directory is stable"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestReportsAnInjectedReaderENOENTAsAMetadataReadFailure(t *testing.T) {
	dir := conversationsDir(t)
	dbFile := filepath.Join(dir, cascadeID(6)+".db")
	writeFile(t, dbFile, "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		ReadSQLite: func(string, string) (string, error) {
			return "", errors.New("database disappeared")
		},
	})
	want := "Failed to read Antigravity SQLite metadata from " + dbFile + ": database disappeared"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestFailsVisiblyWhenDbFileMetadataCannotBeRead(t *testing.T) {
	dir := conversationsDir(t)
	writeFile(t, filepath.Join(dir, cascadeID(6)+".db"), "")

	_, err := ReadUsageEvents(Options{
		ConversationDir: dir,
		StatFile: func(string) (StatResult, error) {
			return StatResult{}, errors.New("permission denied")
		},
	})
	if err == nil || !regexp.MustCompile(`permission denied`).MatchString(err.Error()) {
		t.Fatalf("error = %v, want the stat failure", err)
	}
}

// The Antigravity sources read whole pages of hex(data), which doubles each
// blob, so the shared 64 MiB reader default would reject pages their own
// 128 MiB ceiling accepted before the read path was unified. Deleting the
// ceiling from the call site would leave every other test green, so this
// captures the options the package actually passes.
func TestPassesTheRaisedCeilingOnEveryQueryItIssues(t *testing.T) {
	original := queryText
	t.Cleanup(func() { queryText = original })
	var recorded []sqlite.QueryOptions
	queryText = func(_ string, _ string, options sqlite.QueryOptions) (string, error) {
		recorded = append(recorded, options)
		return "", nil
	}

	dir := conversationsDir(t)
	writeFile(t, filepath.Join(dir, "00000000-0000-0000-0000-000000000009.db"), "")

	if _, err := ReadUsageEvents(Options{ConversationDir: dir}); err != nil {
		t.Fatal(err)
	}
	if len(recorded) == 0 {
		t.Fatal("no query was issued")
	}
	for _, options := range recorded {
		if options.MaxOutputBytes != sqlite.AntigravityMaxOutputBytes {
			t.Errorf("maxOutputBytes = %d, want %d", options.MaxOutputBytes, sqlite.AntigravityMaxOutputBytes)
		}
	}
}

func strPtr(value string) *string { return &value }

func scanKey(cascadeID string) string {
	sum := sha256.Sum256([]byte(cascadeID))
	return hex.EncodeToString(sum[:])
}

func setMtime(t *testing.T, path, isoTimestamp string) {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, isoTimestamp)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, parsed, parsed); err != nil {
		t.Fatal(err)
	}
}

// cascadeMtime reads the trailing numeric index out of a cascade id file name.
func cascadeMtime(path string) float64 {
	suffix := filepath.Base(path)
	index, _ := strconv.Atoi(suffix[len(suffix)-15 : len(suffix)-3])
	return float64(index)
}

// seedGenMetadata creates a real database through the embedded driver.
func seedGenMetadata(t *testing.T, dbPath string, statements ...string) {
	t.Helper()
	database, err := dbsql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("opening %s: %v", dbPath, err)
	}
	defer database.Close()
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("seeding %s with %q: %v", dbPath, statement, err)
		}
	}
}
