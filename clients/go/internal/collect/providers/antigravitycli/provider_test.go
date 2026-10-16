package antigravitycli

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Integration: the real reader, the real cursor file, the full collect flow —
// the same shape the TS antigravity-cli tests pin. A second run must not
// double-count the same rows, and an acknowledgement must stop the re-emission.

// recentSeconds is a timestamp inside the cursor retention window. Anchoring
// the fixtures to the clock matters: an acknowledged identity older than 90
// days is compacted, and replaying it then correctly fails closed demanding
// --since all — which is the behaviour, not a bug to assert around.
func recentSeconds(offset int64) int64 {
	return time.Now().Unix() - 3600 + offset
}

func TestCollectReadsHistoryAndPersistsRowCursors(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	conversations := filepath.Join(root, "conversations")
	seedCascade(t, conversations, "00000000-0000-0000-0000-0000000000a1", map[int64][]byte{
		1: blobFixture(1, "gemini-3-flash-a", recentSeconds(0), 100, 12, 50),
		2: blobFixture(2, "gemini-3-flash-a", recentSeconds(1), 30, 3, 0),
	})

	options := Options{
		Timezone:        "UTC",
		CollectedAt:     recentISO(0),
		StateDir:        stateDir,
		ConversationDir: conversations,
	}
	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	// Both rows share the day and model, so one merged snapshot of 130/15/50.
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %d, want 1: %+v", len(snapshots), snapshots)
	}
	if snapshots[0].InputTokens != 130 || snapshots[0].OutputTokens != 15 ||
		snapshots[0].CacheRead != 50 || snapshots[0].TotalTokens != 195 || snapshots[0].SessionCount != 1 {
		t.Fatalf("snapshot = %+v", snapshots[0])
	}
	if snapshots[0].CostUSD != 0 {
		t.Fatal("antigravity cost must be 0")
	}

	// The cursor carries the version stamp and the row cursor at row 2.
	cursor, err := sessioncursor.Read(filepath.Join(stateDir, "antigravity-cli-cursor.json"), "antigravity-cli")
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if version, seen := cursorMeteringVersion(cursor); !seen || version != HistoryMeteringVersion {
		t.Fatalf("metering version = %d (seen %v)", version, seen)
	}
	rowIndexes := LastSeenCLIDbRowIndexByCascadeHash(cursor, "all")
	if len(rowIndexes) != 1 {
		t.Fatalf("row indexes = %v, want one cascade", rowIndexes)
	}
	for cascadeHash, rowIndex := range rowIndexes {
		if cascadeHash != hashString("00000000-0000-0000-0000-0000000000a1") || rowIndex != 2 {
			t.Fatalf("row cursor = %s -> %d, want the a1 cascade at row 2", cascadeHash[:12], rowIndex)
		}
	}

	// A second run re-emits the pending snapshot but reads nothing new.
	again, err := Collect(Options{
		Timezone:        "UTC",
		CollectedAt:     recentISO(1000),
		StateDir:        stateDir,
		ConversationDir: conversations,
	})
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if len(again) != 1 || again[0].InputTokens != 130 {
		t.Fatalf("second run snapshots = %+v, want the same usage re-emitted once", again)
	}
	if again[0].CollectedAt == snapshots[0].CollectedAt {
		t.Fatal("second run must carry a fresh collectedAt stamp")
	}

	// After an acknowledgement, the third run emits nothing.
	groups := map[string]bool{}
	for _, snapshot := range snapshots {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir:           stateDir,
		Source:             contract.SourceAntigravityCLI,
		AcknowledgedGroups: groups,
		Timezone:           "UTC",
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	third, err := Collect(Options{
		Timezone:        "UTC",
		CollectedAt:     recentISO(2000),
		StateDir:        stateDir,
		ConversationDir: conversations,
	})
	if err != nil {
		t.Fatalf("third collect: %v", err)
	}
	if len(third) != 0 {
		t.Fatalf("third run snapshots = %+v, want none after acknowledgement", third)
	}
}

func TestCollectSecondRunOnlyReadsNewRows(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	conversations := filepath.Join(root, "conversations")
	cascadeID := "00000000-0000-0000-0000-0000000000b2"
	seedCascade(t, conversations, cascadeID, map[int64][]byte{
		1: blobFixture(1, "gemini-3-flash-a", recentSeconds(0), 100, 10, 0),
	})

	base := Options{Timezone: "UTC", StateDir: stateDir, ConversationDir: conversations}
	first, err := Collect(base)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	// Acknowledge the first run, so the second one's output is only what the
	// incremental read newly produced — an unacknowledged entry is re-emitted
	// by design.
	groups := map[string]bool{}
	for _, snapshot := range first {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir: stateDir, Source: contract.SourceAntigravityCLI,
		AcknowledgedGroups: groups, Timezone: "UTC",
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}

	// Append row 2: the second run must ingest only the new row's usage.
	seedCascade(t, conversations, cascadeID, map[int64][]byte{
		2: blobFixture(2, "gemini-3-flash-a", recentSeconds(2), 5, 1, 0),
	})
	second, err := Collect(base)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	// The run re-sends the COMPLETE daily total, not just the new row: the
	// acknowledged 100 rides along as the compacted baseline so the server's
	// daily upsert lands on the right value instead of only the delta.
	var totals int64
	for _, snapshot := range second {
		totals += snapshot.InputTokens
	}
	if totals != 105 {
		t.Fatalf("second run input total = %d, want the complete daily total 105 (100 + the new row's 5)", totals)
	}
}

func TestCollectFailsClosedWhenBoundedScanIncomplete(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	conversations := filepath.Join(root, "conversations")
	// Three cascades: a budget of 2 cannot complete the directory scan, and a
	// fresh cursor has no full-scan flag, so the run must refuse.
	for index := 0; index < 3; index++ {
		seedCascade(t, conversations, "00000000-0000-0000-0000-"+string(rune('a'+index))+"0000000000c", map[int64][]byte{
			1: blobFixture(1, "gemini-3-flash-a", recentSeconds(0), 1, 0, 0),
		})
	}
	budget := 2
	_, err := Collect(Options{
		Timezone:        "UTC",
		StateDir:        stateDir,
		ConversationDir: conversations,
		MaxDbFiles:      &budget,
	})
	if err == nil {
		t.Fatal("expected the bounded-scan assertion to fail")
	}
	if want := "requires --since all"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to name %q", err, want)
	}
}

func TestCollectMissingConversationsDirectoryIsUnavailable(t *testing.T) {
	root := t.TempDir()
	_, err := Collect(Options{
		Timezone:        "UTC",
		StateDir:        filepath.Join(root, "state"),
		ConversationDir: filepath.Join(root, "absent"),
	})
	if err == nil {
		t.Fatal("expected the missing directory to fail")
	}
	if want := "Antigravity conversations directory not found"; want != err.Error()[:len(want)] {
		t.Fatalf("err = %v, want it to start with %q", err, want)
	}
}

// --- fixtures ------------------------------------------------------------

// seedCascade writes one conversation database with the given gen_metadata
// rows, merging with whatever rows the file already holds.
func seedCascade(t *testing.T, conversations, cascadeID string, rows map[int64][]byte) {
	t.Helper()
	if err := os.MkdirAll(conversations, 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(conversations, cascadeID+".db")))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec(
		`CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)`); err != nil {
		t.Fatal(err)
	}
	for index, blob := range rows {
		if _, err := database.Exec(
			`INSERT OR REPLACE INTO gen_metadata (idx, data) VALUES (?, ?)`, int(index), blob); err != nil {
			t.Fatal(err)
		}
	}
}

// blobFixture builds one valid generator-metadata blob: chat model 3/4/9/19
// with a usage (2 in, 3 out, 5 cache read, 11 response id) and a timestamp at
// 9.4, wrapped in field 1, plus the execution id at field 4.
func blobFixture(rowIndex int, model string, timestampSeconds int64, input, output, cacheRead int64) []byte {
	usage := appendFields(nil,
		varintField(2, uint64(input)),
		varintField(3, uint64(output)),
		varintField(5, uint64(cacheRead)),
		lengthField(11, []byte("response-"+string(rune('0'+rowIndex)))),
	)
	timestamp := appendFields(nil, varintField(1, uint64(timestampSeconds)))
	clock := appendFields(nil, lengthField(4, timestamp))
	chatModel := appendFields(nil,
		varintField(3, 1132),
		lengthField(4, usage),
		lengthField(9, clock),
		lengthField(19, []byte(model)),
	)
	return appendFields(nil, lengthField(1, chatModel), lengthField(4, []byte("execution")))
}

func varintField(fieldNumber int, value uint64) []byte {
	key := varint(uint64(fieldNumber) * 8)
	return append(key, varint(value)...)
}

func lengthField(fieldNumber int, payload []byte) []byte {
	out := varint(uint64(fieldNumber)*8 + 2)
	out = append(out, varint(uint64(len(payload)))...)
	return append(out, payload...)
}

func varint(value uint64) []byte {
	var out []byte
	for value >= 128 {
		out = append(out, byte(value&127)|128)
		value >>= 7
	}
	return append(out, byte(value))
}

func appendFields(base []byte, fields ...[]byte) []byte {
	for _, field := range fields {
		base = append(base, field...)
	}
	return base
}

// recentISO stamps a collection inside the retention window, offset by the
// given milliseconds so successive runs carry distinct stamps.
func recentISO(offset int) string {
	return time.Now().UTC().Add(time.Duration(offset) * time.Millisecond).
		Format("2006-01-02T15:04:05.000Z")
}
