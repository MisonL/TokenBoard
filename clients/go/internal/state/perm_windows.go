//go:build windows

package state

import "os"

// hasGroupOrWorldAccess always reports false on Windows. Go synthesizes
// directory permission bits there (every non-readonly file reads as 0666,
// see os/types_windows.go), so the POSIX check would reject every directory
// on the machine and make the client unusable. Access is governed by ACLs on
// the user profile directory, which the state dir inherits by default.
func hasGroupOrWorldAccess(mode os.FileMode) bool {
	return false
}
