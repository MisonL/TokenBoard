package antigravitycli

import (
	"path/filepath"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// AcknowledgeSourceInput names one source cursor to acknowledge after a
// successful upload.
type AcknowledgeSourceInput struct {
	StateDir           string
	Source             contract.Source
	CursorScope        string
	AcknowledgedGroups map[string]bool
	Since              string
	Timezone           string
}

// AcknowledgeSourceCursor applies an upload acknowledgement to one source's
// cursor file, under the same lock the collector uses.
//
// Only the CLI source's cursor is acknowledged here: the two GUI sources share
// this package's key layout but their own provider (and its acknowledgement)
// is not ported yet, so acknowledging them would write a cursor nothing reads.
func AcknowledgeSourceCursor(input AcknowledgeSourceInput) error {
	if input.Source != contract.SourceAntigravityCLI {
		return nil
	}
	cursorPath := filepath.Join(input.StateDir, sessioncursor.FileName(input.Source, input.CursorScope))
	lock, err := state.Acquire(cursorPath+".lock", cursorLockTimeout)
	if err != nil {
		return err
	}
	if lock == nil {
		return &AcknowledgeError{Message: "could not acquire the Antigravity CLI cursor lock"}
	}
	defer func() { _ = lock.Release() }()

	cursor, err := sessioncursor.Read(cursorPath, string(input.Source))
	if err != nil {
		return err
	}
	if err := ClearPendingUploadCursors(AcknowledgeInput{
		Cursor:             &cursor,
		AcknowledgedGroups: input.AcknowledgedGroups,
		Since:              input.Since,
		Timezone:           input.Timezone,
	}); err != nil {
		return err
	}
	return sessioncursor.Write(cursorPath, cursor)
}
