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
	if dir := strings.TrimSpace(env("TOKENBOARD_STATE_DIR")); dir != "" {
		return dir
	}
	if dir := strings.TrimSpace(env("TOKENBOARD_CONFIG_DIR")); dir != "" {
		return dir
	}
	return filepath.Join(homeDir, ".tokenboard")
}

// EnsurePrivateDir creates dir with 0700 when missing. The state directory
// holds tokens and cursors; a world-readable directory would let any local
// account swap them.
func EnsurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	// Best effort on platforms without POSIX bits; enforced where they exist.
	_ = os.Chmod(dir, 0o700)
	if info.Mode().Perm()&0o077 != 0 {
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
	waiting  bool
	released bool
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
		time.Sleep(lockRetryInterval)
	}
}

// lockRetryInterval is the poll cadence, matching the TS cursor lock's 25ms
// so a Go run picks up a released lock at the same latency the TS peer does.
const lockRetryInterval = 25 * time.Millisecond

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
		// Held: clear it when provably stale, otherwise report contention.
		if err := removeStale(path); err != nil {
			return nil, false, err
		}
		return nil, false, nil
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
	return &Lock{Path: path, Owner: owner}, true, nil
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

// removeStale clears the lock file when its owner is provably dead. A live
// or indeterminate holder is left in place (conservative, like the TS probe).
// The removal itself goes through removeLockRecord so a lock another process
// acquired after we observed this one is never deleted.
func removeStale(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var record LockOwner
	if err := json.Unmarshal(data, &record); err != nil {
		// Unparseable lock file: nothing can vouch for it. Removing is what
		// the TS side does when the record is unreadable.
		_, err = removeLockRecord(path, data)
		return err
	}
	if record.PID <= 0 {
		_, err = removeLockRecord(path, data)
		return err
	}
	if ProbeLiveness(record.PID, record.ProcessStartIdentity) != LivenessDead {
		return nil // alive or indeterminate: keep waiting
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
		restoreAside(path, aside)
		return false, nil
	}
	if err := os.Remove(aside); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		restoreAside(path, aside)
		return false, err
	}
	return true, nil
}

// quarantinePath is unique per caller so concurrent releases in one process
// never share a quarantine name.
func quarantinePath(path string) string {
	return fmt.Sprintf("%s.release-%d-%d", path, os.Getpid(), time.Now().UnixNano())
}

// restoreAside puts a quarantined file back. link, not rename: when another
// process re-created the lock at path while this copy was quarantined, link
// fails with EEXIST and that other lock is left untouched. Every other
// failure is tolerable too (the next staleness pass re-evaluates), so the
// error is deliberately ignored after best effort.
func restoreAside(path, aside string) {
	_ = os.Link(aside, path)
	_ = os.Remove(aside)
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
