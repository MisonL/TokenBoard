package sessioncursor

import (
	"path/filepath"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// AcknowledgeInput names one source cursor to acknowledge after a successful
// upload.
type AcknowledgeInput struct {
	StateDir    string
	Source      contract.Source
	CursorScope string
	// AcknowledgedGroups are the daily snapshot groups the server accepted.
	AcknowledgedGroups map[string]bool
	// Now is the clock the rewritten entries are stamped from; zero uses the
	// wall clock.
	Now time.Time
}

// AcknowledgePendingUploads ports the non-Antigravity half of
// clearPendingUploadCursors: mark the pending entries the upload covered as
// uploaded so the next hook run stops re-emitting them.
//
// The Antigravity sources keep their own acknowledgement (their cursor key
// families carry session markers and compaction rules this function does not
// model); this one covers the session-file sources, whose pending entries are
// acknowledged only when every snapshot they carry was in an uploaded group.
func AcknowledgePendingUploads(input AcknowledgeInput) error {
	if input.Source == contract.SourceAntigravityCLI ||
		input.Source == contract.SourceAntigravity ||
		input.Source == contract.SourceAntigravityIDE {
		return &AcknowledgeError{Message: "Antigravity cursors use their own acknowledgement"}
	}
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	updatedAt := now.UTC().Format("2006-01-02T15:04:05.000Z")
	cursorPath := filepath.Join(input.StateDir, FileName(input.Source, input.CursorScope))
	lock, err := state.Acquire(cursorPath+".lock", 35*time.Second)
	if err != nil {
		return err
	}
	if lock == nil {
		return &AcknowledgeError{Message: "could not acquire the " + string(input.Source) + " cursor lock"}
	}
	defer func() { _ = lock.Release() }()

	cursor, err := Read(cursorPath, string(input.Source))
	if err != nil {
		return err
	}
	changed := false
	for _, key := range sortedEntryKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			continue
		}
		if len(entry.Snapshots) > 0 && !entryFullyAcknowledged(entry, input.AcknowledgedGroups) {
			continue
		}
		pending := false
		entry.PendingUpload = &pending
		entry.UpdatedAt = updatedAt
		cursor.Files[key] = entry
		changed = true
	}
	if !changed {
		return nil
	}
	return Write(cursorPath, cursor)
}

// entryFullyAcknowledged reports whether every snapshot in the entry belongs
// to a group the server accepted. An entry with no snapshots has nothing to
// match and is acknowledged by the caller.
func entryFullyAcknowledged(entry Entry, groups map[string]bool) bool {
	for _, snapshot := range entry.Snapshots {
		if !groups[CursorSnapshotGroupKey(snapshot)] {
			return false
		}
	}
	return true
}

// AcknowledgeError reports an acknowledgement that cannot be applied.
type AcknowledgeError struct{ Message string }

func (e *AcknowledgeError) Error() string { return e.Message }

// WarmInput names one hook cursor whose scan high-water mark is advanced.
type WarmInput struct {
	StateDir    string
	Source      contract.Source
	CursorScope string
	HighWaterMs float64
	// Now is injectable for tests; zero uses the wall clock.
	Now func() time.Time
}

// WarmHookCursorHighWater ports warmHookCursorHighWater: record that a full
// scan covered everything up to highWaterMs, so the next hook scan starts
// there instead of re-reading the whole tree.
//
// The value is clamped to the current clock for the same reason the per-file
// mark is: a caller-supplied time ahead of the clock would hide files the next
// scan has not read yet.
func WarmHookCursorHighWater(input WarmInput) error {
	now := time.Now
	if input.Now != nil {
		now = input.Now
	}
	cursorPath := filepath.Join(input.StateDir, FileName(input.Source, input.CursorScope))
	lock, err := state.Acquire(cursorPath+".lock", 35*time.Second)
	if err != nil {
		return err
	}
	if lock == nil {
		return &AcknowledgeError{Message: "could not acquire the " + string(input.Source) + " cursor lock"}
	}
	defer func() { _ = lock.Release() }()

	cursor, err := Read(cursorPath, string(input.Source))
	if err != nil {
		return err
	}
	highWaterMs := float64(now().UnixMilli())
	if input.HighWaterMs < highWaterMs {
		highWaterMs = input.HighWaterMs
	}
	if existing, ok := numericExtra(cursor, highWaterKey); ok && existing > highWaterMs {
		highWaterMs = existing
	}
	if existing, ok := numericExtra(cursor, highWaterKey); ok && existing == highWaterMs {
		return nil
	}
	if err := cursor.SetExtra(highWaterKey, highWaterMs); err != nil {
		return err
	}
	return Write(cursorPath, cursor)
}
