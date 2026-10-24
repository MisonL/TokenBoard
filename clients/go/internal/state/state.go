// Package state resolves the collector state directory and provides the
// cross-implementation run lock. The lock protocol mirrors the TypeScript
// collector's coordinator-lock.mjs + cursor-process-liveness.ts exactly —
// payload shape (pid/startedAt/token/processStartIdentity), wx exclusive
// creation, stale detection via pid liveness with a processStartIdentity
// guard against PID reuse — so a Go run and a TS run serialize against the
// same lock file during the per-source migration window.
package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ResolveDir mirrors resolveStateDir: TOKENBOARD_STATE_DIR, else
// TOKENBOARD_CONFIG_DIR, else ~/.tokenboard.
func ResolveDir(env func(string) string, homeDir string) string {
	if env == nil {
		env = os.Getenv
	}
	if dir := strings.TrimSpace(env("TOKENBOARD_STATE_DIR")); dir != "" {
		return dir
	}
	if dir := strings.TrimSpace(env("TOKENBOARD_CONFIG_DIR")); dir != "" {
		return dir
	}
	return filepath.Join(homeDir, ".tokenboard")
}

// EnsurePrivateDir creates dir with 0700 when missing and tightens an
// existing directory to 0700. The state directory holds tokens and cursors; a
// world-readable directory would let any local account swap them. The
// tightening is verified after the fact — if the mode still admits group or
// world access (a filesystem that cannot express POSIX bits, a failed chmod),
// the caller is refused rather than silently run against a loose directory.
func EnsurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(dir, 0o700)
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if hasGroupOrWorldAccess(info.Mode()) {
		return fmt.Errorf("state directory %s is group/world accessible", dir)
	}
	return nil
}

// LockOwner identifies the lock holder, serialized exactly like
// coordinator-lock.mjs's lockPayload.
type LockOwner struct {
	PID                  int    `json:"pid"`
	StartedAt            string `json:"startedAt"`
	Token                string `json:"token"`
	ProcessStartIdentity string `json:"processStartIdentity,omitempty"`
}

// Lock manages one lock file following the TS protocol.
type Lock struct {
	Path     string
	Owner    LockOwner
	released bool

	stopHeartbeat chan struct{}
	heartbeatDone chan struct{}
}

// Acquire takes the lock at path, waiting up to timeout for a stale holder to
// be cleared. It returns nil when the lock could not be acquired in time.
// The wait polls at the peer's cadence: the TS lock guarding this same file
// (session-cursor-store's withCursorLock) retries every 25ms.
func Acquire(path string, timeout time.Duration) (*Lock, error) {
	if err := EnsurePrivateDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		lock, held, err := tryAcquire(path)
		if err != nil {
			return nil, err
		}
		if held {
			return lock, nil
		}
		if time.Now().After(deadline) {
			return nil, nil
		}
		if err := removeStale(path); err != nil {
			return nil, err
		}
		time.Sleep(lockRetryInterval)
	}
}

// lockRetryInterval is the poll cadence, matching the TS cursor lock's 25ms
// so a Go run picks up a released lock at the same latency the TS peer does.
const lockRetryInterval = 25 * time.Millisecond

// lockStaleWindow is the age a lock file must reach before it may be
// cleared, mirroring the TS cursorLockStaleMs. It fences the creation
// window: a contender's O_CREATE file that has not received its payload yet
// is "unparseable", and without an age floor that half-written file would be
// deleted and re-locked, breaking mutual exclusion.
const lockStaleWindow = 30 * time.Second

// lockHeartbeatInterval refreshes the held lock's mtime so a holder doing
// long work is never swept by the stale window. The TS peer heartbeats every
// 5s; ours must stay under its 30s floor.
const lockHeartbeatInterval = 5 * time.Second

func tryAcquire(path string) (*Lock, bool, error) {
	owner, err := newOwner()
	if err != nil {
		return nil, false, err
	}
	payload, err := json.Marshal(owner)
	if err != nil {
		return nil, false, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return nil, false, err
		}
		return nil, false, nil // held: the caller decides whether it is stale
	}
	if _, err := file.Write(payload); err != nil {
		file.Close()
		_ = os.Remove(path)
		return nil, false, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return nil, false, err
	}
	lock := &Lock{Path: path, Owner: owner}
	lock.startHeartbeat()
	return lock, true, nil
}

func newOwner() (LockOwner, error) {
	token := make([]byte, 16)
	if _, err := randomFill(token); err != nil {
		return LockOwner{}, err
	}
	identity, err := ProcessStartIdentity(os.Getpid())
	if err != nil {
		identity = ""
	}
	return LockOwner{
		PID:                  os.Getpid(),
		StartedAt:            time.Now().UTC().Format(time.RFC3339Nano),
		Token:                hexEncode(token),
		ProcessStartIdentity: identity,
	}, nil
}

// Release removes the lock only if it still carries our token and pid
// (another process may have cleared a stale version and re-locked). The
// check and the removal are made atomic by removeLockRecord's
// quarantine-rename: only the process that wins the rename gets to inspect
// and delete the file, so a foreign lock acquired in between is restored,
// never overwritten. Mirrors the TS releaseLock token/pid checks and its
// removeLockRecord cleanup.
func (l *Lock) Release() error {
	if l == nil || l.released {
		return nil
	}
	l.released = true
	l.stopHeartbeatLoop()
	data, err := os.ReadFile(l.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var owner LockOwner
	if err := json.Unmarshal(data, &owner); err != nil ||
		owner.Token != l.Owner.Token || owner.PID != os.Getpid() {
		// Not ours anymore; leaving it alone is correct.
		return nil
	}
	_, err = removeLockRecord(l.Path, data)
	return err
}

// startHeartbeat refreshes the lock file's mtime every lockHeartbeatInterval
// so a long-running hold is never swept by the stale window — the same
// protection the TS peer's 5s utimes heartbeat provides.
func (l *Lock) startHeartbeat() {
	l.stopHeartbeat = make(chan struct{})
	l.heartbeatDone = make(chan struct{})
	go func() {
		defer close(l.heartbeatDone)
		ticker := time.NewTicker(lockHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-l.stopHeartbeat:
				return
			case <-ticker.C:
				l.refreshMtime()
			}
		}
	}()
}

// stopHeartbeatLoop halts the heartbeat and waits for it, so Release never
// races a refresh against the unlink.
func (l *Lock) stopHeartbeatLoop() {
	if l.stopHeartbeat == nil {
		return
	}
	close(l.stopHeartbeat)
	<-l.heartbeatDone
	l.stopHeartbeat = nil
}

// refreshMtime touches the lock only while it is still ours: extending a file
// someone else has taken over would keep their lock alive past its real age.
// A failed refresh is ignored — the stale window still guards the file, and a
// lock we can no longer touch is no longer ours to keep.
func (l *Lock) refreshMtime() {
	data, err := os.ReadFile(l.Path)
	if err != nil {
		return
	}
	var owner LockOwner
	if json.Unmarshal(data, &owner) != nil || owner.Token != l.Owner.Token {
		return
	}
	now := time.Now()
	_ = os.Chtimes(l.Path, now, now)
}

// removeStale clears a lock file that is provably stale, mirroring the TS
// recoverStaleCursorLock. Three conditions must hold: the file has been
// untouched for lockStaleWindow, its owner is dead (or the record is
// unreadable, which vouches for nothing), and the exact bytes observed are
// still in place when removeLockRecord re-checks them. The age floor is what
// fences the creation window — a contender's O_CREATE file that has not
// received its payload yet is unparseable but far too young to sweep.
func removeStale(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if time.Since(info.ModTime()) < lockStaleWindow {
		return nil // too fresh: live, or still being written
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var record LockOwner
	// An unreadable record (or one with no usable pid) vouches for nothing,
	// matching the TS owner probe returning null; only a positively live
	// owner blocks the sweep.
	if err := json.Unmarshal(data, &record); err == nil && record.PID > 0 {
		if ProbeLiveness(record.PID, record.ProcessStartIdentity) != LivenessDead {
			return nil // alive or indeterminate: keep waiting
		}
	}
	_, err = removeLockRecord(path, data)
	return err
}

// removeLockRecord removes path only when its bytes still equal the raw
// content observed before the decision to remove was made. It renames the
// file to a private quarantine name (atomic and exclusive), re-reads it
// there, restores it via link on any mismatch, and unlinks only on a match.
// This is the TS removeLockRecord's protection against the classic race:
// two contenders both see a stale lock, one removes and re-locks, and a
// plain os.Remove by the other would delete the new holder's live lock.
func removeLockRecord(path string, expectedRaw []byte) (bool, error) {
	aside := quarantinePath(path)
	if err := os.Rename(path, aside); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	current, err := os.ReadFile(aside)
	if err != nil || !bytes.Equal(current, expectedRaw) {
		if restoreErr := restoreAside(path, aside); restoreErr != nil {
			return false, restoreErr
		}
		return false, nil
	}
	if err := os.Remove(aside); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		if restoreErr := restoreAside(path, aside); restoreErr != nil {
			return false, restoreErr
		}
		return false, err
	}
	return true, nil
}

// quarantinePath is unique per caller. A random suffix, not just pid and
// clock, is what the TS side uses (randomBytes(8)): two quarantines landing
// in the same nanosecond would otherwise rename over each other.
func quarantinePath(path string) string {
	suffix := make([]byte, 8)
	if _, err := randomFill(suffix); err != nil {
		// Fall back to the clock alone; a collision here only risks one
		// contender's quarantined copy, never the lock itself.
		suffix = nil
	}
	return fmt.Sprintf("%s.release-%d-%d%s", path, os.Getpid(), time.Now().UnixNano(), hexEncode(suffix))
}

// restoreAside puts a quarantined file back. link, not rename: when another
// process re-created the lock at path while this copy was quarantined, link
// fails with EEXIST and that other lock is left untouched — the TS
// restoreLockRecord behaves the same way. Any other failure keeps the
// quarantined copy on disk rather than destroying it, matching the TS side's
// throw-and-retain; the file is inert either way, and preserving it means an
// operator can still see what was there.
func restoreAside(path, aside string) error {
	err := os.Link(aside, path)
	if err != nil && !errors.Is(err, os.ErrExist) && !os.IsNotExist(err) {
		return err
	}
	_ = os.Remove(aside)
	return nil
}

func hexEncode(data []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(data)*2)
	for i, b := range data {
		out[i*2] = digits[b>>4]
		out[i*2+1] = digits[b&0x0f]
	}
	return string(out)
}
