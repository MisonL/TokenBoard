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
	ageLock(t, path)
	lock, err := Acquire(path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if lock == nil {
		t.Fatal("stale lock must be cleared and acquired")
	}
	_ = lock.Release()
}

// ageLock backdates a lock file's mtime past the stale window, which is what
// a genuinely abandoned lock looks like. Freshly written locks — however
// dead their recorded pid — are never swept.
func ageLock(t *testing.T, path string) {
	t.Helper()
	old := time.Now().Add(-2 * lockStaleWindow)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
}

// The stale window fences the creation window: a lock file younger than
// lockStaleWindow is never removed, no matter what it contains — that is the
// state another contender's O_CREATE-then-write leaves behind.
func TestFreshLockIsNeverSwept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.lock")
	_ = os.Chmod(filepath.Dir(path), 0o700)
	// Empty: exactly what a contender's O_CREATE looks like before the
	// payload lands. Previously this was swept and re-locked, breaking
	// mutual exclusion.
	writeLock(t, path, "")
	lock, err := Acquire(path, 150*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if lock != nil {
		_ = lock.Release()
		t.Fatal("a fresh unparseable lock must not be stolen")
	}
	// Same for a fresh record whose owner is long dead: age is the gate,
	// not liveness alone.
	dead := spawnDeadPid(t)
	if dead <= 0 {
		t.Skip("no provably-dead pid available")
	}
	writeLock(t, path, fmt.Sprintf(`{"pid":%d,"startedAt":"2026-05-09T10:00:00.000Z","token":"dead"}`, dead))
	lock, err = Acquire(path, 150*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if lock != nil {
		_ = lock.Release()
		t.Fatal("a fresh lock of a dead pid must not be stolen")
	}
	// Once it ages past the window, the dead owner's lock is cleared.
	ageLock(t, path)
	lock, err = Acquire(path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if lock == nil {
		t.Fatal("an aged dead-owner lock must be cleared")
	}
	_ = lock.Release()
}

// A held lock's heartbeat refreshes its mtime so a long-running hold is
// never swept by the stale window.
func TestHeartbeatRefreshesMtime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.lock")
	_ = os.Chmod(filepath.Dir(path), 0o700)
	lock, err := Acquire(path, time.Second)
	if err != nil || lock == nil {
		t.Fatalf("acquire: lock=%v err=%v", lock, err)
	}
	defer func() { _ = lock.Release() }()
	ageLock(t, path)
	lock.refreshMtime()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(info.ModTime()) >= lockStaleWindow {
		t.Fatalf("heartbeat did not refresh mtime: %v old", time.Since(info.ModTime()))
	}
	// A lock that is no longer ours must not be kept alive by our heartbeat.
	writeLock(t, path, `{"pid":424242,"startedAt":"2026-05-09T10:00:00.000Z","token":"someone-else"}`)
	ageLock(t, path)
	lock.refreshMtime()
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(info.ModTime()) < lockStaleWindow {
		t.Fatal("heartbeat must not refresh a lock it no longer owns")
	}
}

// A record claiming our own pid is ours only if its start identity matches;
// anything else is a leftover that happens to carry our pid and must be
// cleared, exactly as the TS probe decides.
func TestOwnPidLockStalenessMatchesTSProbe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.lock")
	_ = os.Chmod(filepath.Dir(path), 0o700)
	identity, identityErr := ProcessStartIdentity(os.Getpid())
	if identityErr != nil {
		t.Skipf("identity unavailable: %v", identityErr)
	}

	// Same pid, our real identity, foreign token: a lock from this process —
	// never stolen.
	writeLock(t, path, fmt.Sprintf(
		`{"pid":%d,"startedAt":"2026-05-09T10:00:00.000Z","token":"foreign","processStartIdentity":%q}`,
		os.Getpid(), identity))
	if lock, err := Acquire(path, 100*time.Millisecond); err != nil {
		t.Fatal(err)
	} else if lock != nil {
		_ = lock.Release()
		t.Fatal("a lock carrying our pid and identity must not be stolen")
	}

	// Same pid, a different identity: a stale record from another process
	// that recycled our pid — cleared once it ages past the stale window.
	writeLock(t, path, fmt.Sprintf(
		`{"pid":%d,"startedAt":"2026-05-09T10:00:00.000Z","token":"foreign","processStartIdentity":"darwin:1:1"}`,
		os.Getpid()))
	ageLock(t, path)
	if lock, err := Acquire(path, time.Second); err != nil {
		t.Fatal(err)
	} else if lock == nil {
		t.Fatal("an own-pid record with a mismatched identity must be cleared")
	} else {
		_ = lock.Release()
	}

	// Same pid, no identity: the TS probe treats this as stale (its
	// in-memory owner set is what vouches for a real own lock).
	writeLock(t, path, fmt.Sprintf(
		`{"pid":%d,"startedAt":"2026-05-09T10:00:00.000Z","token":"foreign"}`, os.Getpid()))
	ageLock(t, path)
	if lock, err := Acquire(path, time.Second); err != nil {
		t.Fatal(err)
	} else if lock == nil {
		t.Fatal("an own-pid record with no identity must be cleared")
	} else {
		_ = lock.Release()
	}
}

// Release must leave a foreign lock alone: another process may have cleared
// our stale lock and re-locked between our acquire and release.
func TestReleaseDoesNotDeleteForeignLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.lock")
	_ = os.Chmod(filepath.Dir(path), 0o700)
	lock, err := Acquire(path, time.Second)
	if err != nil || lock == nil {
		t.Fatalf("acquire: lock=%v err=%v", lock, err)
	}
	foreign := `{"pid":424242,"startedAt":"2026-05-09T10:00:00.000Z","token":"someone-else"}`
	writeLock(t, path, foreign)
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	remaining, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("foreign lock was deleted: %v", err)
	}
	if string(remaining) != foreign {
		t.Errorf("foreign lock altered: %q", remaining)
	}
}

// removeLockRecord must not remove a file whose bytes changed after the
// staleness decision — the race where a contender clears the stale lock and
// re-locks before we act on our (now outdated) observation.
func TestRemoveLockRecordVerifiesBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.lock")
	stale := []byte(`{"pid":1,"token":"stale"}`)
	writeLock(t, path, string(stale))

	// Simulate the winner's re-lock in the window before we remove.
	reLocked := `{"pid":2,"token":"fresh"}`
	writeLock(t, path, reLocked)

	removed, err := removeLockRecord(path, stale)
	if err != nil {
		t.Fatal(err)
	}
	if removed {
		t.Fatal("a lock whose bytes changed must not be removed")
	}
	remaining, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-locked file was lost: %v", err)
	}
	if string(remaining) != reLocked {
		t.Errorf("re-locked file altered: %q", remaining)
	}

	// With matching bytes it does remove.
	removed, err = removeLockRecord(path, []byte(reLocked))
	if err != nil || !removed {
		t.Fatalf("matching record must be removed: removed=%v err=%v", removed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("lock file should be gone, stat err=%v", err)
	}
}

func writeLock(t *testing.T, path, payload string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
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

func TestResolveDirWithNilEnvUsesTheProcessEnvironment(t *testing.T) {
	// The TS resolveStateDir reads process.env when no env is threaded through;
	// a nil env here must behave the same rather than panic.
	t.Setenv("TOKENBOARD_STATE_DIR", "/tmp/explicit-state")
	if dir := ResolveDir(nil, "/home/example"); dir != "/tmp/explicit-state" {
		t.Fatalf("dir = %q, want the process environment's override", dir)
	}
}
