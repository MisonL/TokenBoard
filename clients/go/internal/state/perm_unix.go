//go:build !windows

package state

import "os"

// hasGroupOrWorldAccess reports whether the POSIX mode admits group or world
// access. This is the check that protects the state directory on the
// platforms whose permission bits actually mean something.
func hasGroupOrWorldAccess(mode os.FileMode) bool {
	return mode.Perm()&0o077 != 0
}
