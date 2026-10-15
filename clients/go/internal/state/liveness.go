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
		// A record claiming our own pid with a token we did not write:
		// compare the start identity exactly like the TS probe — a mismatch
		// means the record is stale (a leftover that happens to carry our
		// pid), a match is a lock from this very process. Without a recorded
		// identity the TS probe also treats the record as stale (its
		// in-memory owner set plays that role), and Go mirrors that since it
		// never re-acquires within a process either.
		if ownerIdentity != "" {
			if identity, err := ProcessStartIdentity(pid); err == nil && identity != "" {
				if identity != ownerIdentity {
					return LivenessDead
				}
				return LivenessAlive
			}
			return LivenessAlive // identity probe failed: conservative
		}
		return LivenessDead
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
