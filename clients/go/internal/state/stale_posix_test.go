//go:build !windows

package state

import (
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// spawnDeadPid starts a child, kills it, and reaps it; the pid is then
// provably gone (ESRCH on signal 0).
func spawnDeadPid(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("/bin/sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot spawn: %v", err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Process.Kill(); err != nil {
		t.Skipf("cannot kill child: %v", err)
	}
	_ = cmd.Wait()
	for i := 0; i < 50; i++ {
		if err := syscall.Kill(pid, 0); err != nil {
			return pid
		}
		time.Sleep(20 * time.Millisecond)
	}
	return -1
}
