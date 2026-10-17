package antigravitygui

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/mtime"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
)

var sha256HexPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// cursorDBFileScan reads the persisted file-scan state, entry by entry: the
// shared validator does not cover the continuity anchors, and one unusable
// anchor should cost that cascade a re-read rather than invalidate the rest.
func cursorDBFileScan(state sessioncursor.State) antigravityscan.FileScanState {
	scan := antigravityscan.NewFileScanState()
	raw, ok := state.ExtraValue("antigravityDbFileScan")
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

func setCursorDBFileScan(state *sessioncursor.State, scan antigravityscan.FileScanState) error {
	return state.SetExtra("antigravityDbFileScan", scan)
}

// formatDate renders a timestamp's local calendar date.
func formatDate(at time.Time, timezone string) string {
	return sessionusage.FormatDate(at, timezone)
}

// parseIsoTime parses an ISO timestamp; an unparseable value is the zero time.
func parseIsoTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}
	}
	return parsed
}

// parseIsoMillis mirrors Date.parse: an unparseable value is NaN, which the
// entry writer turns into zero.
func parseIsoMillis(value string) float64 {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return math.NaN()
	}
	return float64(parsed.UnixMilli())
}

func finiteOrZero(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

// collectedAtOrNow stamps an entry the way the TS writer does.
func collectedAtOrNow(collectedAt string) string {
	if collectedAt != "" {
		return collectedAt
	}
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// collateLess mirrors the JS default localeCompare the TS cursor uses for its
// scope ordering.
func collateLess(left, right string) bool {
	return collate.Less(left, right)
}

// compareHashes orders two hex digests the way the TS localeCompare does.
func compareHashes(left, right string) int {
	if collate.Less(left, right) {
		return -1
	}
	if left == right {
		return 0
	}
	return 1
}

// mtimeMs converts a mod time the way the cursor values are stored.
func mtimeMs(at time.Time) float64 {
	return mtime.Millis(at)
}

// IsUnavailableDBError reports the "the tool is not installed here" read
// failures an all-source run skips on.
func IsUnavailableDBError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.HasPrefix(message, "Antigravity SQLite reader unavailable:") ||
		strings.HasPrefix(message, "Antigravity conversations directory not found:")
}

// IsUnavailableLanguageServerError reports the language-server failures that
// only mean the server is not here.
func IsUnavailableLanguageServerError(err error) bool {
	return antigravitymeta.IsUnavailableLanguageServerError(err)
}
