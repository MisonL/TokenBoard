package state

import (
	"crypto/rand"
	"errors"
	"os"
	"syscall"
)

// Liveness is the outcome of probing a pid: alive, dead, or indeterminate
// (probe failed; treated as alive so a wedged-but-live owner keeps the lock).
type Liveness string

const (
	LivenessAlive         Liveness = "alive"
	LivenessDead          Liveness = "dead"
	LivenessIndeterminate Liveness = "indeterminate"
)

// errProcessGone marks a probe whose target provably no longer exists, so it
// classifies as dead regardless of platform error codes.
var errProcessGone = errors.New("process gone")

// ProcessStartIdentity returns the platform identity string, byte-compatible
// with cursor-process-liveness.ts on darwin and linux.
func ProcessStartIdentity(pid int) (string, error) {
	return platformProcessStartIdentity(pid)
}

// ProbeLiveness classifies a pid: existence first, then the start-identity
// comparison to catch PID reuse. A missing or unreadable identity is
// indeterminate→alive (never dead), so Go cannot steal a lock whose owner it
// fails to read.
func ProbeLiveness(pid int, ownerIdentity string) Liveness {
	if pid <= 0 {
		return LivenessDead
	}
	if pid == os.Getpid() {
		return LivenessAlive
	}
	err := platformSignalZero(pid)
	switch {
	case err == nil:
		if ownerIdentity != "" {
			if identity, idErr := ProcessStartIdentity(pid); idErr == nil && identity != "" && identity != ownerIdentity {
				return LivenessDead // same pid, different process
			}
		}
		return LivenessAlive
	case errors.Is(err, errProcessGone), errors.Is(err, syscall.ESRCH):
		return LivenessDead
	default:
		return LivenessIndeterminate
	}
}

func randomFill(b []byte) (int, error) {
	return rand.Read(b)
}

func osGetenv(key string) string {
	return os.Getenv(key)
}
