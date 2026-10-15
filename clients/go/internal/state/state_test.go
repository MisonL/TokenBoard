package state

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveDirPrecedence(t *testing.T) {
	home := "/home/tester"
	env := func(key string) string {
		switch key {
		case "TOKENBOARD_STATE_DIR":
			return "/state/override"
		case "TOKENBOARD_CONFIG_DIR":
			return "/config/override"
		}
		return ""
	}
	if got := ResolveDir(env, home); got != "/state/override" {
		t.Errorf("state dir wins: %q", got)
	}
	env = func(key string) string {
		if key == "TOKENBOARD_CONFIG_DIR" {
			return "/config/override"
		}
		return ""
	}
	if got := ResolveDir(env, home); got != "/config/override" {
		t.Errorf("config dir second: %q", got)
	}
	if got := ResolveDir(func(string) string { return "" }, home); got != filepath.Join(home, ".tokenboard") {
		t.Errorf("home fallback: %q", got)
	}
}

func TestAcquireAndRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collector-run.lock")
	// t.TempDir() inherits the test root's mode; Acquire tightens the parent
	// dir itself, so pre-tighten here to keep the check meaningful.
	_ = os.Chmod(filepath.Dir(path), 0o700)
	lock, err := Acquire(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if lock == nil {
		t.Fatal("fresh lock not acquired")
	}
	if lock.Owner.PID != os.Getpid() {
		t.Errorf("owner pid %d", lock.Owner.PID)
	}
	second, err := Acquire(path, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if second != nil {
		t.Fatal("lock must be exclusive while held")
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	third, err := Acquire(path, time.Second)
	if err != nil || third == nil {
		t.Fatalf("re-acquire after release: lock=%v err=%v", third, err)
	}
	_ = third.Release()
}

func TestStaleLockOfDeadPidIsCleared(t *testing.T) {
	dead := spawnDeadPid(t)
	if dead <= 0 {
		t.Skip("no provably-dead pid available")
	}
	path := filepath.Join(t.TempDir(), "run.lock")
	_ = os.Chmod(filepath.Dir(path), 0o700)
	payload := fmt.Sprintf(`{"pid":%d,"startedAt":"2026-05-09T10:00:00.000Z","token":"deadbeef"}`, dead)
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if lock == nil {
		t.Fatal("stale lock must be cleared and acquired")
	}
	_ = lock.Release()
}

// A lock held by a live process (here: our own pid, a foreign token) must
// never be stolen, whatever the probe reads.
func TestLiveForeignLockIsNotStolen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.lock")
	_ = os.Chmod(filepath.Dir(path), 0o700)
	payload := fmt.Sprintf(`{"pid":%d,"startedAt":"2026-05-09T10:00:00.000Z","token":"foreign"}`, os.Getpid())
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(path, 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if lock != nil {
		_ = lock.Release()
		t.Fatal("a live holder's lock must not be stolen")
	}
}

func TestProcessStartIdentityMatchesTSFormat(t *testing.T) {
	identity, err := ProcessStartIdentity(os.Getpid())
	if err != nil {
		t.Skipf("identity unavailable: %v", err)
	}
	switch {
	case len(identity) > 7 && identity[:7] == "darwin:":
	// darwin:<seconds>:<microseconds> — matches cursor-process-liveness.ts
	case len(identity) > 6 && identity[:6] == "linux:":
	// linux:<boot_id>:<start_ticks> — matches too
	default:
		t.Errorf("unexpected identity format %q", identity)
	}
}
