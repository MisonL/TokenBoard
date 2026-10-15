// Package sessioncursor reads and writes the collector's cursor JSON v1
// state files. The format is shared with the TypeScript collector
// (packages/collector/src/providers/session-cursor-store.ts): during the
// per-source migration either implementation may write a cursor the other
// must read back without semantic drift, so this file mirrors that
// validator's rules field by field.
//
// Fields Go does not interpret yet are carried as raw JSON and written back
// verbatim. A Go write must never delete state a newer TypeScript collector
// stored, and a corrupt cursor must fail loudly — silently resetting it would
// trigger a full rescan and re-upload.
package sessioncursor

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Snapshot is the cursor-carried projection of a usage snapshot: everything
// except collectedAt, plus the pending-correction marker.
type Snapshot struct {
	Source                     string  `json:"source"`
	UsageDate                  string  `json:"usageDate"`
	Timezone                   string  `json:"timezone"`
	Model                      string  `json:"model"`
	InputTokens                float64 `json:"inputTokens"`
	OutputTokens               float64 `json:"outputTokens"`
	CacheCreationTokens        float64 `json:"cacheCreationTokens"`
	CacheReadTokens            float64 `json:"cacheReadTokens"`
	TotalTokens                float64 `json:"totalTokens"`
	CostUSD                    float64 `json:"costUsd"`
	SessionCount               float64 `json:"sessionCount"`
	CodexContextPricingPending bool    `json:"codexContextPricingPending,omitempty"`
}

// Entry is one tracked session file, or one synthetic key for the Antigravity
// sources. Booleans that are optional in the format are pointers so an absent
// field stays absent through a round trip.
type Entry struct {
	Size              float64    `json:"size"`
	MtimeMs           float64    `json:"mtimeMs"`
	SHA256            string     `json:"sha256"`
	ContentHashAlgo   string     `json:"contentHashAlgo,omitempty"`
	EndsWithNewline   *bool      `json:"endsWithNewline,omitempty"`
	Snapshots         []Snapshot `json:"snapshots"`
	MissingCost       bool       `json:"missingCost"`
	PendingUpload     *bool      `json:"pendingUpload,omitempty"`
	CompactedIdentity *bool      `json:"compactedIdentity,omitempty"`
	StatuslineClaimed *bool      `json:"statuslineClaimed,omitempty"`
	AntigravityOrigin string     `json:"antigravityOrigin,omitempty"`
	UpdatedAt         string     `json:"updatedAt"`
}

// State is a whole cursor file. Scalar top-level fields Go does not model yet
// live in Extra and are re-emitted unchanged.
type State struct {
	Version int
	Source  string
	Files   map[string]Entry

	extra map[string]json.RawMessage
}

// Extra returns a copy of the unmodelled top-level fields.
func (s State) Extra() map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(s.extra))
	for k, v := range s.extra {
		out[k] = v
	}
	return out
}

// SetExtra stores an unmodelled top-level field.
func (s *State) SetExtra(key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if s.extra == nil {
		s.extra = map[string]json.RawMessage{}
	}
	s.extra[key] = encoded
	return nil
}

// Read parses and validates a cursor file. A missing file yields an empty
// state, matching the TypeScript collector; corrupt JSON or a failed
// validation is an error.
func Read(path, source string) (State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewState(source), nil
		}
		return State{}, fmt.Errorf("read cursor: %w", err)
	}
	state, err := parse(data, source)
	if err != nil {
		return State{}, fmt.Errorf("invalid cursor %s: %w", path, err)
	}
	return state, nil
}

// Write serializes the state the way the TypeScript collector does: two-space
// indent, trailing newline, 0600 file mode inside a 0700 directory, atomic
// rename over the destination.
func Write(path string, state State) error {
	if state.Version != 1 {
		return fmt.Errorf("cursor version must be 1, got %d", state.Version)
	}
	payload, err := marshal(state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-go-%d", path, os.Getpid())
	if err := os.WriteFile(tmp, append(payload, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// NewState returns the empty cursor the TypeScript collector would have
// written for a source with no history yet.
func NewState(source string) State {
	return State{Version: 1, Source: source, Files: map[string]Entry{}, extra: map[string]json.RawMessage{}}
}

// knownTopLevel are the keys parsed into typed fields; everything else is
// preserved verbatim so a future field survives a Go round trip.
var knownTopLevel = map[string]bool{"version": true, "source": true, "files": true}

func parse(data []byte, source string) (State, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return State{}, fmt.Errorf("not a JSON object: %w", err)
	}

	var version int
	if err := decode(raw["version"], &version); err != nil || version != 1 {
		return State{}, fmt.Errorf("version must be 1")
	}
	var parsedSource string
	if err := decode(raw["source"], &parsedSource); err != nil || parsedSource != source {
		return State{}, fmt.Errorf("source mismatch: cursor says %q, want %q", parsedSource, source)
	}

	state := NewState(source)
	for key, value := range raw {
		if knownTopLevel[key] {
			continue
		}
		if err := validateTopLevel(key, value); err != nil {
			return State{}, err
		}
		state.extra[key] = value
	}

	filesRaw, ok := raw["files"]
	if !ok {
		return State{}, fmt.Errorf("files is required")
	}
	var files map[string]json.RawMessage
	if err := json.Unmarshal(filesRaw, &files); err != nil {
		return State{}, fmt.Errorf("files must be an object")
	}
	state.Files = make(map[string]Entry, len(files))
	for key, entryRaw := range files {
		if !isValidCursorKey(key) {
			return State{}, fmt.Errorf("files: invalid key %q", key)
		}
		entry, err := parseEntry(entryRaw)
		if err != nil {
			return State{}, fmt.Errorf("files[%q]: %w", key, err)
		}
		state.Files[key] = entry
	}
	return state, nil
}

var (
	sha256Pattern         = regexp.MustCompile(`^[a-f0-9]{64}$`)
	kebabKindPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	usageDatePattern      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	scanGenerationPattern = regexp.MustCompile(`^[a-z0-9-]+$`)
)

// validateTopLevel mirrors the TypeScript validator's per-field rules for the
// fields Go does not model. A field both sides know must never bypass
// validation just because Go stores it opaquely.
func validateTopLevel(key string, value json.RawMessage) error {
	switch key {
	case "codexHookProfileHash", "lastScanPrefixSha256":
		var s string
		if err := decode(value, &s); err != nil || !sha256Pattern.MatchString(s) {
			return fmt.Errorf("%s must be a sha256 hex digest", key)
		}
	case "lastScanHighWaterMs":
		var n float64
		if err := decode(value, &n); err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return fmt.Errorf("%s must be a finite number", key)
		}
	case "lastScanOffsetBytes":
		var n float64
		if err := decode(value, &n); err != nil || n < 0 || n != math.Trunc(n) {
			return fmt.Errorf("%s must be a non-negative integer", key)
		}
	case "lastScanGeneration":
		var s string
		if err := decode(value, &s); err != nil || !scanGenerationPattern.MatchString(s) {
			return fmt.Errorf("%s has an invalid shape", key)
		}
	case "pendingSnapshotRetryCursor":
		var s string
		if err := decode(value, &s); err != nil || len(s) > 4096 {
			return fmt.Errorf("%s must be a string of at most 4096 bytes", key)
		}
	case "antigravityHistoryReplayReady", "antigravityStatuslineReplayReady",
		"antigravityHistoryReplayCompacted", "antigravityStatuslineReplayCompacted",
		"antigravityCliHistoryComplete", "antigravityCliHistoryCompacted":
		var b bool
		if err := decode(value, &b); err != nil || !b {
			return fmt.Errorf("%s must be true when present", key)
		}
	case "antigravityCliHistoryCompactedThroughDate":
		var s string
		if err := decode(value, &s); err != nil || !usageDatePattern.MatchString(s) {
			return fmt.Errorf("%s must be a YYYY-MM-DD date", key)
		}
	case "antigravityCliMeteringVersion":
		var n float64
		if err := decode(value, &n); err != nil || n < 1 || n != math.Trunc(n) {
			return fmt.Errorf("%s must be an integer of at least 1", key)
		}
	case "antigravityDbFileScan", "antigravityCascadeFileScan", "antigravityHistoryAliasMtimes":
		var probe any
		if err := decode(value, &probe); err != nil {
			return fmt.Errorf("%s must be an object", key)
		}
		if _, isObject := probe.(map[string]any); !isObject {
			return fmt.Errorf("%s must be an object", key)
		}
	}
	return nil
}

func parseEntry(raw json.RawMessage) (Entry, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return Entry{}, fmt.Errorf("must be an object")
	}
	for _, required := range []string{"size", "mtimeMs", "sha256", "snapshots", "missingCost", "updatedAt"} {
		if _, ok := probe[required]; !ok {
			return Entry{}, fmt.Errorf("%s is required", required)
		}
	}
	var entry Entry
	if err := json.Unmarshal(raw, &entry); err != nil {
		return Entry{}, err
	}
	if math.IsNaN(entry.Size) || math.IsInf(entry.Size, 0) || math.IsNaN(entry.MtimeMs) || math.IsInf(entry.MtimeMs, 0) {
		return Entry{}, fmt.Errorf("size and mtimeMs must be finite numbers")
	}
	if !sha256Pattern.MatchString(entry.SHA256) {
		return Entry{}, fmt.Errorf("sha256 must be a sha256 hex digest")
	}
	switch entry.AntigravityOrigin {
	case "", "database", "language-server":
	default:
		return Entry{}, fmt.Errorf("antigravityOrigin must be database or language-server")
	}
	for i, snapshot := range entry.Snapshots {
		for _, check := range []struct {
			name  string
			value float64
		}{
			{"inputTokens", snapshot.InputTokens},
			{"outputTokens", snapshot.OutputTokens},
			{"cacheCreationTokens", snapshot.CacheCreationTokens},
			{"cacheReadTokens", snapshot.CacheReadTokens},
			{"totalTokens", snapshot.TotalTokens},
			{"costUsd", snapshot.CostUSD},
			{"sessionCount", snapshot.SessionCount},
		} {
			if math.IsNaN(check.value) || math.IsInf(check.value, 0) {
				return Entry{}, fmt.Errorf("snapshots[%d].%s must be a finite number", i, check.name)
			}
		}
	}
	// A missing snapshots array must round-trip as [], not null.
	if entry.Snapshots == nil {
		entry.Snapshots = []Snapshot{}
	}
	return entry, nil
}

// isValidCursorKey mirrors the TypeScript rule: either a relative path with
// no empty or ".." segments, or a synthetic `kind\0part...` identifier whose
// kind is kebab-case and whose parts cannot escape a path. A model name may
// legitimately contain "/" (org/model), so only escaping shapes are rejected.
func isValidCursorKey(key string) bool {
	separator := strings.Index(key, "\x00")
	if separator == 0 {
		return false
	}
	if separator > 0 {
		if !kebabKindPattern.MatchString(key[:separator]) {
			return false
		}
		for _, part := range strings.Split(key[separator+1:], "\x00") {
			if strings.HasPrefix(part, "/") {
				return false
			}
			for _, segment := range strings.Split(part, "/") {
				if segment == "." || segment == ".." {
					return false
				}
			}
		}
		return true
	}
	if key == "" {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == ".." {
			return false
		}
	}
	return true
}

func decode(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return fmt.Errorf("missing")
	}
	return json.Unmarshal(raw, target)
}

// marshal emits the cursor as JSON. Key order differs from the TypeScript
// writer (Go maps sort), which both sides tolerate: each reads by key.
func marshal(state State) ([]byte, error) {
	document := make(map[string]json.RawMessage, len(state.extra)+3)
	for key, value := range state.extra {
		document[key] = value
	}
	version, err := json.Marshal(state.Version)
	if err != nil {
		return nil, err
	}
	source, err := json.Marshal(state.Source)
	if err != nil {
		return nil, err
	}
	files, err := json.Marshal(state.Files)
	if err != nil {
		return nil, err
	}
	document["version"] = version
	document["source"] = source
	document["files"] = files
	return json.MarshalIndent(document, "", "  ")
}
