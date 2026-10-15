//go:build !windows

package state

import (
	"syscall"
)

func platformSignalZero(pid int) error {
	return syscall.Kill(pid, 0)
}
