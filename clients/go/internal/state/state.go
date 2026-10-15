// Package state resolves the collector state directory and provides the
// cross-implementation run lock. The lock protocol mirrors the TypeScript
// collector's coordinator-lock.mjs + cursor-process-liveness.ts exactly —
// payload shape (pid/startedAt/token/processStartIdentity), wx exclusive
// creation, stale detection via pid liveness with a processStartIdentity
// guard against PID reuse — so a Go run and a TS run serialize against the
// same lock file during the per-source migration window.
package state

import (
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
		time.Sleep(100 * time.Millisecond)
	}
}

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

// Release removes the lock only if it still carries our token (another
// process may have cleared a stale version and re-locked). Mirrors
// releaseLock's token check.
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
	if err := json.Unmarshal(data, &owner); err != nil || owner.Token != l.Owner.Token {
		// Not ours anymore; leaving it alone is correct.
		return nil
	}
	return os.Remove(l.Path)
}

// removeStale clears the lock file when its owner is provably dead. A live
// or indeterminate holder is left in place (conservative, like the TS probe).
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
		return os.Remove(path)
	}
	if record.PID <= 0 {
		return os.Remove(path)
	}
	status := ProbeLiveness(record.PID, record.ProcessStartIdentity)
	if status == LivenessDead {
		return os.Remove(path)
	}
	return nil // alive or indeterminate: keep waiting
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
