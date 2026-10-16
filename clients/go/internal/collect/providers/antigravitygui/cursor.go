// Package antigravitygui ports the Antigravity GUI/IDE sources: the shared
// conversation SQLite history plus the optional language-server route.
//
// The cursor keys are the two sources' own (the CLI source has its own family),
// so they live here rather than in the CLI package even though the two share
// the history reader.
package antigravitygui

import (
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Source is one of the two GUI sources this package serves.
type Source = contract.Source

// Origin records which route produced an entry's usage: the SQLite history or
// the language server. A cursor reset may discard one without touching the
// other, so every usage entry has to carry it.
type Origin string

const (
	OriginDatabase       Origin = "database"
	OriginLanguageServer Origin = "language-server"
)

// dbResetCorrectionPrefix keys the zero corrections a database-cursor reset
// queues, so the usage it discards is cancelled on the server.
const dbResetCorrectionPrefix = "gui-db-reset-correction\x00"

// EmptyCascadeFrontier is the record that a cascade was requested and returned
// no usable events, so the next run does not ask again for the same file state.
type EmptyCascadeFrontier struct {
	MtimeMs     float64
	CascadeHash string
}

// PrepareGuiHistoryScope migrates bounded cursor keys to the current history
// scope, dropping the ones whose window is no longer reusable.
//
// A bounded run's keys carry `since:<scope>` in place of the cascade id's
// position, so moving the window forward rewrites them rather than re-reading
// every conversation.
func PrepareGuiHistoryScope(cursor *sessioncursor.State, source Source, historyScope string) {
	if historyScope == "all" {
		return
	}
	type candidate struct {
		key   string
		entry sessioncursor.Entry
		scope string
		parts []string
		kind  string
	}
	candidates := []candidate{}
	for _, key := range sortedKeys(cursor.Files) {
		parsed, ok := parseBoundedGuiCursorKey(key, source)
		if !ok {
			continue
		}
		candidates = append(candidates, candidate{
			key:   key,
			entry: cursor.Files[key],
			scope: parsed.scope,
			parts: parsed.parts,
			kind:  parsed.parts[0],
		})
	}
	// The migration mutates the map it read, so the candidates were snapshotted
	// first; the delete/re-add below is what the TS loop does in one pass.
	migrated := map[string]migratedEntry{}
	for _, item := range candidates {
		delete(cursor.Files, item.key)
		if !antigravityscan.IsReusableHistoryScope(item.scope, historyScope) {
			continue
		}
		item.parts[2] = "since:" + historyScope
		nextKey := strings.Join(item.parts, "\x00")
		current, seen := migrated[nextKey]
		next := migratedEntry{entry: item.entry, kind: item.kind}
		if seen {
			next = mergeBoundedGuiCursorEntry(current, next)
		}
		migrated[nextKey] = next
	}
	for key, value := range migrated {
		cursor.Files[key] = value.entry
	}
}

type migratedEntry struct {
	entry sessioncursor.Entry
	kind  string
}

// mergeBoundedGuiCursorEntry picks between two entries that collapse onto one
// key: the empty-cascade frontier is ordered by mtime then content, a cascade
// cursor by mtime then size.
func mergeBoundedGuiCursorEntry(left, right migratedEntry) migratedEntry {
	if left.kind == "cascade-empty-frontier" {
		if right.entry.MtimeMs < left.entry.MtimeMs {
			return right
		}
		if right.entry.MtimeMs == left.entry.MtimeMs && right.entry.SHA256 > left.entry.SHA256 {
			return right
		}
		return left
	}
	if right.entry.MtimeMs > left.entry.MtimeMs {
		return right
	}
	if right.entry.MtimeMs == left.entry.MtimeMs && right.entry.Size > left.entry.Size {
		return right
	}
	return left
}

// PushGuiUsageEvent records one event under its event identity and appends its
// snapshot. An event already in the cursor re-emits its stored snapshot while
// the upload is pending, and is otherwise ignored, so a re-read cannot
// double-count it.
func PushGuiUsageEvent(input PushGuiUsageEventInput) {
	eventKey := UsageEventKey(input.Event)
	if existing, ok := input.Cursor.Files[eventKey]; ok {
		if existing.PendingUpload != nil && *existing.PendingUpload {
			pushCachedSnapshots(input.Snapshots, existing, input.CollectedAt, input.EmittedKeys, eventKey, nil)
		}
		return
	}
	snapshot := buildGuiSnapshot(input)
	entry := newCursorEntry(newCursorEntryInput{
		Snapshots:     []sessioncursor.Snapshot{StripCollectedAt(snapshot)},
		Marker:        eventKey,
		MtimeMs:       parseIsoMillis(input.Event.CreatedAt),
		PendingUpload: true,
		Origin:        input.Origin,
		CollectedAt:   input.CollectedAt,
	})
	input.Cursor.Files[eventKey] = entry
	*input.Snapshots = append(*input.Snapshots, snapshot)
	input.EmittedKeys[eventKey] = true
}

// PushGuiUsageEventInput carries one event through the GUI cursor.
type PushGuiUsageEventInput struct {
	Event       antigravitymeta.UsageEvent
	Origin      Origin
	Cursor      *sessioncursor.State
	Snapshots   *[]contract.Snapshot
	EmittedKeys map[string]bool
	Timezone    string
	CollectedAt string
	Source      Source
}

// PushCompleteGuiCursorSnapshots re-emits the pending entries whose daily group
// this run touched, so a partially-acked model group still uploads its total.
func PushCompleteGuiCursorSnapshots(
	snapshots *[]contract.Snapshot,
	cursor *sessioncursor.State,
	collectedAt string,
	emittedKeys map[string]bool,
	includeSnapshot func(sessioncursor.Snapshot) bool,
) {
	dirtyGroups := map[string]bool{}
	for _, key := range sortedKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload || len(entry.Snapshots) == 0 {
			continue
		}
		for _, snapshot := range entry.Snapshots {
			if includeSnapshot != nil && !includeSnapshot(snapshot) {
				continue
			}
			dirtyGroups[SnapshotGroupKey(snapshot)] = true
		}
	}
	for _, snapshot := range *snapshots {
		dirtyGroups[SnapshotGroupKey(StripCollectedAt(snapshot))] = true
	}

	for _, eventKey := range sortedKeys(cursor.Files) {
		entry := cursor.Files[eventKey]
		if len(entry.Snapshots) == 0 {
			continue
		}
		matches := false
		for _, snapshot := range entry.Snapshots {
			if dirtyGroups[SnapshotGroupKey(snapshot)] {
				matches = true
				break
			}
		}
		if !matches {
			continue
		}
		pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey, includeSnapshot)
	}
}

// SnapshotGroupKey is the daily group a snapshot belongs to.
func SnapshotGroupKey(snapshot sessioncursor.Snapshot) string {
	return strings.Join(
		[]string{snapshot.Source, snapshot.UsageDate, snapshot.Timezone, snapshot.Model}, "\x00")
}

// StripCollectedAt projects a snapshot into the cursor form.
func StripCollectedAt(snapshot contract.Snapshot) sessioncursor.Snapshot {
	return sessioncursor.Snapshot{
		Source:              string(snapshot.Source),
		UsageDate:           snapshot.UsageDate,
		Timezone:            snapshot.Timezone,
		Model:               snapshot.Model,
		InputTokens:         float64(snapshot.InputTokens),
		OutputTokens:        float64(snapshot.OutputTokens),
		CacheCreationTokens: float64(snapshot.CacheCreation),
		CacheReadTokens:     float64(snapshot.CacheRead),
		TotalTokens:         float64(snapshot.TotalTokens),
		CostUSD:             snapshot.CostUSD,
		SessionCount:        float64(snapshot.SessionCount),
	}
}

// ShouldRequestCascade reports whether a conversation needs a language-server
// request: it has not been seen, or its file changed since it was.
func ShouldRequestCascade(
	cursor sessioncursor.State,
	source Source,
	cascadeID string,
	cascadeMtimeMs float64,
	cascadeSize int64,
	historyScope string,
) bool {
	entry, ok := cursor.Files[CascadeCursorKey(source, cascadeID, historyScope)]
	return !ok || entry.MtimeMs != cascadeMtimeMs || entry.Size != float64(cascadeSize)
}

// ReadEmptyCascadeFrontier returns the recorded empty-cascade frontier, if any.
func ReadEmptyCascadeFrontier(
	cursor sessioncursor.State,
	source Source,
	historyScope string,
) (EmptyCascadeFrontier, bool) {
	entry, ok := cursor.Files[EmptyCascadeFrontierCursorKey(source, historyScope)]
	if !ok {
		return EmptyCascadeFrontier{}, false
	}
	return EmptyCascadeFrontier{MtimeMs: entry.MtimeMs, CascadeHash: entry.SHA256}, true
}

// MarkEmptyCascadeAttempted records that a cascade produced no usable events at
// this file state, so the next run skips it.
func MarkEmptyCascadeAttempted(
	cursor *sessioncursor.State,
	source Source,
	cascadeID string,
	cascadeMtimeMs float64,
	cascadeSize int64,
	historyScope string,
	collectedAt string,
) {
	key := EmptyCascadeFrontierCursorKey(source, historyScope)
	cursor.Files[key] = newCursorEntry(newCursorEntryInput{
		Snapshots:     []sessioncursor.Snapshot{},
		Marker:        cascadeID,
		MtimeMs:       cascadeMtimeMs,
		PendingUpload: false,
		Size:          cascadeSize,
		CollectedAt:   collectedAt,
	})
}

// MarkCascadeProcessed records that a cascade was read at this file state.
func MarkCascadeProcessed(
	cursor *sessioncursor.State,
	source Source,
	cascadeID string,
	cascadeMtimeMs float64,
	cascadeSize int64,
	historyScope string,
	collectedAt string,
) {
	key := CascadeCursorKey(source, cascadeID, historyScope)
	cursor.Files[key] = newCursorEntry(newCursorEntryInput{
		Snapshots:     []sessioncursor.Snapshot{},
		Marker:        key,
		MtimeMs:       cascadeMtimeMs,
		PendingUpload: false,
		Size:          cascadeSize,
		CollectedAt:   collectedAt,
	})
}

// HasDbCascadeRowsProcessed reports whether the SQLite history already covered
// this cascade at this file state, so the language server need not be asked.
func HasDbCascadeRowsProcessed(
	cursor sessioncursor.State,
	source Source,
	cascadeID string,
	cascadeMtimeMs float64,
	cascadeSize int64,
	historyScope string,
) bool {
	entry, ok := cursor.Files[DBCoveredCascadeCursorKey(source, cascadeID, historyScope)]
	return ok && entry.MtimeMs == cascadeMtimeMs && entry.Size == float64(cascadeSize)
}

// LastSeenDbRowIndexByCascadeHash returns the acknowledged row index per
// conversation hash, for the SQLite reader to resume from.
func LastSeenDbRowIndexByCascadeHash(
	cursor sessioncursor.State,
	source Source,
	historyScope string,
) map[string]int64 {
	reusableScope := historyScope
	if historyScope != "all" {
		latest, ok := LatestReusableDBScope(cursor, source, historyScope)
		if ok {
			reusableScope = latest
		}
	}
	prefix := DBCascadeCursorPrefixForScope(source, reusableScope)
	indexes := map[string]int64{}
	for key, entry := range cursor.Files {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		cascadeHash := key[len(prefix):]
		if sha256HexPattern.MatchString(cascadeHash) {
			indexes[cascadeHash] = int64(entry.MtimeMs)
		}
	}
	return indexes
}

// HasUnanchoredDbRowCursor reports whether any row cursor lacks its SQLite
// continuity anchor.
func HasUnanchoredDbRowCursor(cursor sessioncursor.State, source Source, historyScope string) bool {
	return len(UnanchoredDbRowCursorHashes(cursor, source, historyScope)) > 0
}

// UnanchoredDbRowCursorHashes returns the conversations whose row cursor cannot
// be continued incrementally.
func UnanchoredDbRowCursorHashes(
	cursor sessioncursor.State,
	source Source,
	historyScope string,
) map[string]bool {
	unanchored := map[string]bool{}
	rowIndexes := LastSeenDbRowIndexByCascadeHash(cursor, source, historyScope)
	if len(rowIndexes) == 0 {
		return unanchored
	}
	scanFiles := cursorDBFileScan(cursor).Files
	for cascadeHash, rowIndex := range rowIndexes {
		entry, ok := scanFiles[cascadeHash]
		if !ok ||
			entry.MetadataCursorRowIndex == nil ||
			float64(*entry.MetadataCursorRowIndex) != float64(rowIndex) ||
			entry.MetadataCursorRowSHA256 == nil ||
			!sha256HexPattern.MatchString(*entry.MetadataCursorRowSHA256) {
			unanchored[cascadeHash] = true
		}
	}
	return unanchored
}

// ResetGuiDbCursorState discards the SQLite-derived state after a detected
// cursor reset, returning the zero corrections that cancel the usage it drops.
//
// It refuses when the state cannot be classified by origin, or when pending
// database usage would be discarded: in both cases the reset would silently
// lose or double-count usage, so the caller must fall back to a full rebuild.
func ResetGuiDbCursorState(cursor *sessioncursor.State, source Source) ([]sessioncursor.Snapshot, error) {
	if err := assertGuiDbResetStateIsClassified(*cursor, source); err != nil {
		return nil, err
	}
	if err := AssertGuiDbResetHasNoPendingDatabaseUsage(*cursor); err != nil {
		return nil, err
	}
	corrections := collectGuiDbResetCorrections(*cursor)
	rowPrefix := DBCascadeCursorPrefix(source)
	coveredPrefix := DBCoveredCascadeCursorPrefix(source)
	for _, key := range sortedKeys(cursor.Files) {
		if strings.HasPrefix(key, rowPrefix) || strings.HasPrefix(key, coveredPrefix) {
			delete(cursor.Files, key)
		}
	}
	for _, key := range sortedKeys(cursor.Files) {
		if isDatabaseGuiUsageEntry(key, cursor.Files[key]) {
			delete(cursor.Files, key)
		}
	}
	for _, key := range sortedKeys(cursor.Files) {
		entry := cursor.Files[key]
		if IsGuiSessionKey(key, source) && entry.AntigravityOrigin == string(OriginDatabase) {
			delete(cursor.Files, key)
		}
	}
	if err := setCursorDBFileScan(cursor, antigravityscan.NewFileScanState()); err != nil {
		return nil, err
	}
	return corrections, nil
}

// QueueGuiDbResetCorrections records the corrections a reset produced.
func QueueGuiDbResetCorrections(
	cursor *sessioncursor.State,
	corrections []sessioncursor.Snapshot,
	collectedAt string,
) {
	for _, snapshot := range corrections {
		key := guiDbResetCorrectionKey(snapshot)
		cursor.Files[key] = newCursorEntry(newCursorEntryInput{
			Snapshots:     []sessioncursor.Snapshot{snapshot},
			Marker:        key,
			MtimeMs:       parseIsoMillis(collectedAt),
			PendingUpload: true,
			Origin:        OriginDatabase,
			CollectedAt:   collectedAt,
		})
	}
}

// MarkDbCascadeRowsProcessed records the SQLite row progress, and which
// cascades the history covered.
func MarkDbCascadeRowsProcessed(input MarkDbCascadeRowsProcessedInput) {
	historyScope := input.HistoryScope
	if historyScope == "" {
		historyScope = "all"
	}
	prefix := DBCascadeCursorPrefixForScope(input.Source, historyScope)
	if historyScope != "all" {
		boundedPrefix := DBCascadeBoundedCursorPrefix(input.Source)
		for _, key := range sortedKeys(input.Cursor.Files) {
			if strings.HasPrefix(key, boundedPrefix) && !strings.HasPrefix(key, prefix) {
				delete(input.Cursor.Files, key)
			}
		}
	}
	for cascadeID, rowIndex := range input.LastReadRowIndexByCascade {
		key := prefix + antigravitymeta.Hash(cascadeID)
		input.Cursor.Files[key] = newCursorEntry(newCursorEntryInput{
			Snapshots:     []sessioncursor.Snapshot{},
			Marker:        key,
			MtimeMs:       float64(rowIndex),
			PendingUpload: false,
			CollectedAt:   input.CollectedAt,
		})
	}
	for _, cascade := range input.CoveredCascades {
		if !input.CoveredCascadeIDs[cascade.ID] {
			continue
		}
		key := DBCoveredCascadeCursorKey(input.Source, cascade.ID, historyScope)
		input.Cursor.Files[key] = newCursorEntry(newCursorEntryInput{
			Snapshots:     []sessioncursor.Snapshot{},
			Marker:        key,
			MtimeMs:       cascade.MtimeMs,
			PendingUpload: false,
			Size:          cascade.Size,
			CollectedAt:   input.CollectedAt,
		})
	}
}

// MarkDbCascadeRowsProcessedInput is one row-progress update.
type MarkDbCascadeRowsProcessedInput struct {
	Cursor                    *sessioncursor.State
	CoveredCascadeIDs         map[string]bool
	CoveredCascades           []CascadeRef
	Source                    Source
	LastReadRowIndexByCascade map[string]int64
	HistoryScope              string
	CollectedAt               string
}

// CascadeRef names one conversation file as the language server lists it.
type CascadeRef struct {
	ID      string
	MtimeMs float64
	Size    int64
}

// AssertGuiDbResetHasNoPendingDatabaseUsage refuses a reset that would discard
// usage the server has not acknowledged.
func AssertGuiDbResetHasNoPendingDatabaseUsage(cursor sessioncursor.State) error {
	for key, entry := range cursor.Files {
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			continue
		}
		if entry.AntigravityOrigin == string(OriginDatabase) && !IsGuiDbResetCorrectionKey(key) {
			return &GuiDbResetError{
				Message: "Antigravity SQLite metadata cursor reset cannot discard pending database usage",
			}
		}
	}
	return nil
}

// GuiDbResetError reports a reset that cannot safely proceed.
type GuiDbResetError struct{ Message string }

func (e *GuiDbResetError) Error() string { return e.Message }

func assertGuiDbResetStateIsClassified(cursor sessioncursor.State, source Source) error {
	for key, entry := range cursor.Files {
		if isGuiUsageStateKey(key, source) && entry.AntigravityOrigin == "" {
			return &GuiDbResetError{
				Message: "Antigravity SQLite metadata cursor reset cannot safely classify legacy database or language-server usage state",
			}
		}
	}
	return nil
}

// IsGuiDbResetCorrectionKey reports whether the key is a reset correction.
func IsGuiDbResetCorrectionKey(key string) bool {
	return strings.HasPrefix(key, dbResetCorrectionPrefix)
}

// IsGuiSessionKey reports whether the key is one of this source's session
// markers.
func IsGuiSessionKey(key string, source Source) bool {
	parts := strings.Split(key, "\x00")
	return len(parts) == 5 && parts[0] == "session" && parts[1] == string(source) &&
		sha256HexPattern.MatchString(parts[4])
}

// UsageEventKey names one event under its source-independent identity.
func UsageEventKey(event antigravitymeta.UsageEvent) string {
	return strings.Join([]string{"event", event.CascadeHash, event.EventHash}, "\x00")
}

// UsageSessionKey names one conversation-day-model triple.
func UsageSessionKey(event antigravitymeta.UsageEvent, usageDate string, source Source) string {
	return strings.Join([]string{"session", string(source), usageDate, event.Model, event.CascadeHash}, "\x00")
}

// CascadeCursorKey names the language-server progress for one conversation.
func CascadeCursorKey(source Source, cascadeID string, historyScope string) string {
	if historyScope == "all" {
		return strings.Join([]string{"cascade", string(source), antigravitymeta.Hash(cascadeID)}, "\x00")
	}
	return strings.Join([]string{"cascade", string(source), "since:" + historyScope, antigravitymeta.Hash(cascadeID)}, "\x00")
}

// EmptyCascadeFrontierCursorKey names the recorded empty-cascade frontier.
func EmptyCascadeFrontierCursorKey(source Source, historyScope string) string {
	if historyScope == "all" {
		return strings.Join([]string{"cascade-empty-frontier", string(source)}, "\x00")
	}
	return strings.Join([]string{"cascade-empty-frontier", string(source), "since:" + historyScope}, "\x00")
}

// DBCoveredCascadeCursorKey names a cascade the SQLite history covered.
func DBCoveredCascadeCursorKey(source Source, cascadeID string, historyScope string) string {
	prefix := DBCoveredCascadeCursorPrefix(source)
	if historyScope == "all" {
		return prefix + antigravitymeta.Hash(cascadeID)
	}
	return prefix + "since:" + historyScope + "\x00" + antigravitymeta.Hash(cascadeID)
}

func DBCoveredCascadeCursorPrefix(source Source) string {
	return strings.Join([]string{"db-covered", string(source), ""}, "\x00")
}

func DBCascadeCursorPrefix(source Source) string {
	return strings.Join([]string{"db", string(source), ""}, "\x00")
}

func DBCascadeBoundedCursorPrefix(source Source) string {
	return DBCascadeCursorPrefix(source) + "since:"
}

// DBCascadeCursorPrefixForScope is the row-cursor key prefix for one window.
func DBCascadeCursorPrefixForScope(source Source, historyScope string) string {
	if historyScope == "all" {
		return DBCascadeCursorPrefix(source)
	}
	return DBCascadeBoundedCursorPrefix(source) + historyScope + "\x00"
}

// LatestReusableDBScope returns the newest bounded scope whose window still
// covers the current one.
func LatestReusableDBScope(cursor sessioncursor.State, source Source, historyScope string) (string, bool) {
	prefix := DBCascadeBoundedCursorPrefix(source)
	scopes := map[string]bool{}
	for key := range cursor.Files {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		remainder := key[len(prefix):]
		scope, _, _ := strings.Cut(remainder, "\x00")
		if antigravityscan.IsReusableHistoryScope(scope, historyScope) {
			scopes[scope] = true
		}
	}
	ordered := make([]string, 0, len(scopes))
	for scope := range scopes {
		ordered = append(ordered, scope)
	}
	// Descending by the JS default collation, matching the TS sort.
	sort.Slice(ordered, func(i, j int) bool {
		return collateLess(ordered[j], ordered[i])
	})
	if len(ordered) == 0 {
		return "", false
	}
	return ordered[0], true
}

type boundedGuiCursorKey struct {
	scope string
	parts []string
}

func parseBoundedGuiCursorKey(key string, source Source) (boundedGuiCursorKey, bool) {
	parts := strings.Split(key, "\x00")
	if len(parts) < 3 || parts[1] != string(source) || !strings.HasPrefix(parts[2], "since:") {
		return boundedGuiCursorKey{}, false
	}
	if !boundedGuiCursorKinds[parts[0]] {
		return boundedGuiCursorKey{}, false
	}
	scope := strings.TrimPrefix(parts[2], "since:")
	if scope == "" {
		return boundedGuiCursorKey{}, false
	}
	return boundedGuiCursorKey{scope: scope, parts: parts}, true
}

var boundedGuiCursorKinds = map[string]bool{
	"cascade": true, "cascade-empty-frontier": true, "db": true, "db-covered": true,
}

func isDatabaseGuiUsageEntry(key string, entry sessioncursor.Entry) bool {
	return entry.AntigravityOrigin == string(OriginDatabase) &&
		(IsGuiUsageEventKey(key) || IsGuiAggregateEntry(key))
}

// IsGuiUsageEventKey reports whether the key is an event identity.
func IsGuiUsageEventKey(key string) bool {
	parts := strings.Split(key, "\x00")
	return len(parts) == 3 && parts[0] == "event" &&
		sha256HexPattern.MatchString(parts[1]) && sha256HexPattern.MatchString(parts[2])
}

// IsGuiAggregateEntry reports whether the key is a compacted daily aggregate.
func IsGuiAggregateEntry(key string) bool {
	return strings.HasPrefix(key, "aggregate\x00")
}

func isGuiUsageStateKey(key string, source Source) bool {
	return IsGuiUsageEventKey(key) || IsGuiSessionKey(key, source) || IsGuiAggregateEntry(key)
}

func collectGuiDbResetCorrections(cursor sessioncursor.State) []sessioncursor.Snapshot {
	byGroup := map[string]sessioncursor.Snapshot{}
	for _, key := range sortedKeys(cursor.Files) {
		entry := cursor.Files[key]
		if !isDatabaseGuiUsageEntry(key, entry) {
			continue
		}
		for _, snapshot := range entry.Snapshots {
			correction := zeroGuiSnapshot(snapshot)
			byGroup[SnapshotGroupKey(correction)] = correction
		}
	}
	groupKeys := make([]string, 0, len(byGroup))
	for groupKey := range byGroup {
		groupKeys = append(groupKeys, groupKey)
	}
	sort.Strings(groupKeys)
	ordered := make([]sessioncursor.Snapshot, 0, len(groupKeys))
	for _, groupKey := range groupKeys {
		ordered = append(ordered, byGroup[groupKey])
	}
	return ordered
}

func zeroGuiSnapshot(snapshot sessioncursor.Snapshot) sessioncursor.Snapshot {
	return sessioncursor.Snapshot{
		Source:    snapshot.Source,
		UsageDate: snapshot.UsageDate,
		Timezone:  snapshot.Timezone,
		Model:     snapshot.Model,
	}
}

func guiDbResetCorrectionKey(snapshot sessioncursor.Snapshot) string {
	return dbResetCorrectionPrefix + antigravitymeta.Hash(SnapshotGroupKey(snapshot))
}

func buildGuiSnapshot(input PushGuiUsageEventInput) contract.Snapshot {
	usageDate := formatDate(parseIsoTime(input.Event.CreatedAt), input.Timezone)
	sessionKey := UsageSessionKey(input.Event, usageDate, input.Source)
	_, exists := input.Cursor.Files[sessionKey]
	if !exists {
		input.Cursor.Files[sessionKey] = newCursorEntry(newCursorEntryInput{
			Snapshots:     []sessioncursor.Snapshot{},
			Marker:        sessionKey,
			MtimeMs:       parseIsoMillis(input.Event.CreatedAt),
			PendingUpload: true,
			Origin:        input.Origin,
			CollectedAt:   input.CollectedAt,
		})
	}
	sessionCount := int64(0)
	if !exists {
		sessionCount = 1
	}
	total := input.Event.InputTokens + input.Event.OutputTokens +
		input.Event.CacheCreationTokens + input.Event.CacheReadTokens
	return contract.Snapshot{
		Source:        input.Source,
		UsageDate:     usageDate,
		Timezone:      input.Timezone,
		Model:         input.Event.Model,
		InputTokens:   input.Event.InputTokens,
		OutputTokens:  input.Event.OutputTokens,
		CacheCreation: input.Event.CacheCreationTokens,
		CacheRead:     input.Event.CacheReadTokens,
		TotalTokens:   total,
		CostUSD:       0,
		SessionCount:  sessionCount,
		CollectedAt:   input.CollectedAt,
	}
}

func pushCachedSnapshots(
	snapshots *[]contract.Snapshot,
	entry sessioncursor.Entry,
	collectedAt string,
	emittedKeys map[string]bool,
	eventKey string,
	includeSnapshot func(sessioncursor.Snapshot) bool,
) {
	if emittedKeys[eventKey] {
		return
	}
	for _, snapshot := range entry.Snapshots {
		if includeSnapshot != nil && !includeSnapshot(snapshot) {
			continue
		}
		*snapshots = append(*snapshots, snapshotWithCollectedAt(snapshot, collectedAt))
	}
	emittedKeys[eventKey] = true
}

func snapshotWithCollectedAt(snapshot sessioncursor.Snapshot, collectedAt string) contract.Snapshot {
	return contract.Snapshot{
		Source:        contract.Source(snapshot.Source),
		UsageDate:     snapshot.UsageDate,
		Timezone:      snapshot.Timezone,
		Model:         snapshot.Model,
		InputTokens:   int64(snapshot.InputTokens),
		OutputTokens:  int64(snapshot.OutputTokens),
		CacheCreation: int64(snapshot.CacheCreationTokens),
		CacheRead:     int64(snapshot.CacheReadTokens),
		TotalTokens:   int64(snapshot.TotalTokens),
		CostUSD:       snapshot.CostUSD,
		SessionCount:  int64(snapshot.SessionCount),
		CollectedAt:   collectedAt,
	}
}

type newCursorEntryInput struct {
	Snapshots     []sessioncursor.Snapshot
	Marker        string
	MtimeMs       float64
	PendingUpload bool
	Size          int64
	Origin        Origin
	CollectedAt   string
}

func newCursorEntry(input newCursorEntryInput) sessioncursor.Entry {
	pending := input.PendingUpload
	entry := sessioncursor.Entry{
		Size:          float64(input.Size),
		MtimeMs:       finiteOrZero(input.MtimeMs),
		SHA256:        antigravitymeta.Hash(input.Marker),
		Snapshots:     input.Snapshots,
		MissingCost:   true,
		PendingUpload: &pending,
		UpdatedAt:     collectedAtOrNow(input.CollectedAt),
	}
	if input.Origin != "" {
		entry.AntigravityOrigin = string(input.Origin)
	}
	return entry
}

func sortedKeys(files map[string]sessioncursor.Entry) []string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
