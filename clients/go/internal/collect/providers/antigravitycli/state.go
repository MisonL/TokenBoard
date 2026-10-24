// Package antigravitycli ports providers/antigravity-cli*.ts: the Antigravity
// CLI source's cursor bookkeeping and its SQLite history collection.
//
// The cursor's Antigravity fields are top-level keys the shared cursor type
// does not model, so they are read and written through this file rather than
// spelled out at each call site.
package antigravitycli

import (
	"encoding/json"
	"fmt"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// The Antigravity CLI top-level cursor fields.
const (
	cursorKeyDBFileScan              = "antigravityDbFileScan"
	cursorKeyMeteringVersion         = "antigravityCliMeteringVersion"
	cursorKeyHistoryCompacted        = "antigravityCliHistoryCompacted"
	cursorKeyHistoryCompactedThrough = "antigravityCliHistoryCompactedThroughDate"
	cursorKeyHistoryComplete         = "antigravityCliHistoryComplete"
)

// legacyCliMeteringFields are the pre-authority cursor fields whose presence
// marks a cursor that has to be rebuilt from SQLite before it is trusted.
var legacyCliMeteringFields = []string{
	"antigravityHistoryAliasMtimes",
	"antigravityHistoryReplayReady",
	"antigravityStatuslineReplayReady",
	"antigravityHistoryReplayCompacted",
	"antigravityStatuslineReplayCompacted",
	"lastScanOffsetBytes",
	"lastScanGeneration",
	"lastScanPrefixSha256",
}

// cursorDBFileScan reads the persisted file-scan state, defaulting to an empty
// one. An absent field and an empty one are equivalent for every lookup here,
// which is how the TypeScript `??= { nextSequence: 0, files: {} }` behaves.
//
// Entries are decoded one at a time: the shape validation that runs on read
// does not cover the continuity anchors, and a single unusable anchor should
// cost that cascade a full re-read rather than invalidate every other
// database's cursor.
func cursorDBFileScan(state sessioncursor.State) antigravityscan.FileScanState {
	scan := antigravityscan.NewFileScanState()
	raw, ok := state.ExtraValue(cursorKeyDBFileScan)
	if !ok {
		return scan
	}
	var shape struct {
		NextSequence *int64                     `json:"nextSequence"`
		Files        map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return scan
	}
	if shape.NextSequence != nil && *shape.NextSequence >= 0 {
		scan.NextSequence = *shape.NextSequence
	}
	for key, entryRaw := range shape.Files {
		if !sha256HexPattern.MatchString(key) {
			continue
		}
		var entry antigravityscan.FileScanEntry
		if err := json.Unmarshal(entryRaw, &entry); err != nil {
			continue
		}
		scan.Files[key] = entry
	}
	return scan
}

// setCursorDBFileScan persists the file-scan state the run produced.
func setCursorDBFileScan(state *sessioncursor.State, scan antigravityscan.FileScanState) error {
	return state.SetExtra(cursorKeyDBFileScan, scan)
}

// cursorMeteringVersion reads the persisted history-authority version. The
// second result distinguishes "absent" from a stored value.
func cursorMeteringVersion(state sessioncursor.State) (int64, bool) {
	raw, ok := state.ExtraValue(cursorKeyMeteringVersion)
	if !ok {
		return 0, false
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

func setCursorMeteringVersion(state *sessioncursor.State, version int64) error {
	return state.SetExtra(cursorKeyMeteringVersion, version)
}

// cursorHistoryCompactedThroughDate reads the date the CLI history was
// compacted through, empty when the field is absent or not a plain string.
func cursorHistoryCompactedThroughDate(state sessioncursor.State) string {
	raw, ok := state.ExtraValue(cursorKeyHistoryCompactedThrough)
	if !ok {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}

// setCursorHistoryCompactedThroughDate persists the date the CLI history was
// compacted through.
func setCursorHistoryCompactedThroughDate(state *sessioncursor.State, date string) error {
	return state.SetExtra(cursorKeyHistoryCompactedThrough, date)
}

func cursorHistoryComplete(state sessioncursor.State) bool {
	raw, ok := state.ExtraValue(cursorKeyHistoryComplete)
	if !ok {
		return false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	return value
}

func setCursorHistoryComplete(state *sessioncursor.State) error {
	return state.SetExtra(cursorKeyHistoryComplete, true)
}

// hasLegacyCliMeteringState mirrors hasLegacyCliMeteringState: any field from
// before the SQLite history became authoritative, or any cursor entry that is
// not a database row cursor, means the state predates it.
func hasLegacyCliMeteringState(state sessioncursor.State) bool {
	for _, key := range legacyCliMeteringFields {
		if _, ok := state.ExtraValue(key); ok {
			return true
		}
	}
	for key := range state.Files {
		if !hasPrefix(key, cursorPrefixCLIDbCascade) {
			return true
		}
	}
	return false
}

// resetLegacyCliMeteringState drops every field the old statusline metering
// owned, leaving the cursor as a fresh one for the SQLite history to rebuild.
func resetLegacyCliMeteringState(state *sessioncursor.State) {
	state.Files = map[string]sessioncursor.Entry{}
	if err := setCursorDBFileScan(state, antigravityscan.NewFileScanState()); err != nil {
		// SetExtra only fails on an unmarshalable value; a scan state is a
		// plain struct of maps and numbers, so this cannot happen.
		panic(fmt.Sprintf("antigravity-cli: reset scan state: %v", err))
	}
	for _, key := range legacyCliMeteringFields {
		state.DeleteExtra(key)
	}
	state.DeleteExtra(cursorKeyHistoryCompacted)
	state.DeleteExtra(cursorKeyHistoryCompactedThrough)
	state.DeleteExtra(cursorKeyHistoryComplete)
}
