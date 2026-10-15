//go:build darwin

package state

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// platformProcessStartIdentity returns "darwin:<seconds>:<microseconds>" —
// byte-identical to cursor-process-liveness.ts, so a lock record written by
// either implementation validates against the other's probe. The values come
// from the same source (kinfo_proc's p_starttime) via sysctl.
func platformProcessStartIdentity(pid int) (string, error) {
	proc, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	start := proc.Proc.P_starttime
	if start.Sec <= 0 || start.Usec < 0 || start.Usec >= 1_000_000 {
		return "", fmt.Errorf("implausible starttime %d.%d", start.Sec, start.Usec)
	}
	return fmt.Sprintf("darwin:%d:%d", start.Sec, start.Usec), nil
}
