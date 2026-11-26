// Package watermark persists the last usage date each source actually
// delivered, so an automatic since can cover an outage longer than the
// default seven-day window (up to thirty days; see EffectiveSince).
//
// The file is shared with the TypeScript collector
// (packages/collector/src/delivered-watermark.ts) byte-for-byte in shape:
// `{"schemaVersion": ..., "sources": {<source>: {usageDate, endpoint,
// tokenHash, updatedAt}}}`. Entries are scoped by endpoint and token
// fingerprint rather than by a device id: neither client knows its device id
// locally, and a re-paired install gets a new upload token, which is exactly
// the "do not inherit the old watermark" condition.
package watermark

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
)

// FileName is the state file, beside the cursors and backoff records.
const FileName = "delivered-watermark.json"

// SchemaVersion guards the file shape; any other value reads as absent.
const SchemaVersion = "tokenboard-delivered-watermark/v1"

const (
	dateLayout    = "2006-01-02"
	maxLookback   = 30 // days; the automatic window ceiling
	defaultWindow = 7  // days; the existing default lookback
)

// Entry is one source's persisted delivery watermark.
type Entry struct {
	UsageDate string `json:"usageDate"`
	Endpoint  string `json:"endpoint"`
	TokenHash string `json:"tokenHash"`
	UpdatedAt string `json:"updatedAt"`
}

type file struct {
	SchemaVersion string           `json:"schemaVersion"`
	Sources       map[string]Entry `json:"sources"`
}

// TokenFingerprint derives the install identity stored in the watermark. It
// never leaves this machine: only the truncated hash is persisted.
func TokenFingerprint(token string) string {
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:8])
}

func path(stateDir string) string {
	return filepath.Join(stateDir, FileName)
}

// Load returns the valid entries. A missing, unreadable, corrupt or
// wrong-version file yields no entries: the watermark is an optimisation, and
// an unreadable one must behave exactly like a fresh install.
func Load(stateDir string) map[string]Entry {
	data, err := os.ReadFile(path(stateDir))
	if err != nil {
		return nil
	}
	var parsed file
	if json.Unmarshal(data, &parsed) != nil || parsed.SchemaVersion != SchemaVersion {
		return nil
	}
	entries := make(map[string]Entry, len(parsed.Sources))
	for source, entry := range parsed.Sources {
		if _, err := time.Parse(dateLayout, entry.UsageDate); err != nil {
			continue
		}
		entries[source] = entry
	}
	return entries
}

// EffectiveSince returns the automatic since for the given sources, or
// ("", false) when no source has a usable watermark and the caller should keep
// its default. The effective date per source is
// max(today-30, min(today-7, watermark-1)): a watermark a week or more old
// widens the window, an older one is clamped to thirty days, and a recent one
// keeps the existing seven-day floor. The earliest effective date across the
// sources wins, so no source can be skipped.
func EffectiveSince(
	stateDir string, sources []string, endpoint, tokenHash string,
	now time.Time, location *time.Location,
) (string, bool) {
	if tokenHash == "" {
		return "", false
	}
	entries := Load(stateDir)
	if len(entries) == 0 {
		return "", false
	}
	today := now.In(location).Format(dateLayout)
	floor := addDays(today, -defaultWindow)
	ceiling := addDays(today, -maxLookback)
	earliest := ""
	for _, source := range sources {
		entry, ok := entries[source]
		if !ok || entry.Endpoint != endpoint || entry.TokenHash != tokenHash {
			continue
		}
		// A future date means the clock moved backwards; treat it as absent
		// rather than trusting a window that starts in the future.
		if entry.UsageDate > today {
			continue
		}
		effective := maxDate(ceiling, minDate(floor, addDays(entry.UsageDate, -1)))
		if earliest == "" || effective < earliest {
			earliest = effective
		}
	}
	if earliest == "" {
		return "", false
	}
	return earliest, true
}

// Record advances the watermark for each source/date pair. It never moves a
// watermark backwards, ignores dates it cannot parse, and clamps a candidate to
// today (a clock that jumped ahead must not record a future watermark). Other
// sources and other installs' entries are preserved; a corrupt file is simply
// replaced by the repaired structure.
func Record(
	stateDir, endpoint, tokenHash string, advances map[string]string,
	now time.Time, location *time.Location,
) error {
	if tokenHash == "" || len(advances) == 0 {
		return nil
	}
	today := now.In(location).Format(dateLayout)
	existing := Load(stateDir)
	next := file{SchemaVersion: SchemaVersion, Sources: make(map[string]Entry, len(existing)+len(advances))}
	for source, entry := range existing {
		next.Sources[source] = entry
	}
	changed := false
	for source, date := range advances {
		if _, err := time.Parse(dateLayout, date); err != nil {
			continue
		}
		if date > today {
			date = today
		}
		current, ok := next.Sources[source]
		if ok && current.Endpoint == endpoint && current.TokenHash == tokenHash && current.UsageDate >= date {
			continue
		}
		next.Sources[source] = Entry{
			UsageDate: date,
			Endpoint:  endpoint,
			TokenHash: tokenHash,
			UpdatedAt: now.UTC().Format(time.RFC3339Nano),
		}
		changed = true
	}
	if !changed {
		return nil
	}
	return write(stateDir, next)
}

func write(stateDir string, data file) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp := path(stateDir) + fmt.Sprintf(".tmp-go-%d", os.Getpid())
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	if err := renameatomic.Rename(tmp, path(stateDir)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func addDays(date string, days int) string {
	parsed, err := time.Parse(dateLayout, date)
	if err != nil {
		return date
	}
	return parsed.AddDate(0, 0, days).Format(dateLayout)
}

func maxDate(left, right string) string {
	if left > right {
		return left
	}
	return right
}

func minDate(left, right string) string {
	if left < right {
		return left
	}
	return right
}
