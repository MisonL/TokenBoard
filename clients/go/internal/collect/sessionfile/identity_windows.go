//go:build windows

package sessionfile

import "os"

// fileIdentity reports that the Windows dev/inode pair is unavailable from
// os.FileInfo: Go's syscall.Win32FileAttributeData carries no file index, and
// obtaining one needs an open handle. The caller falls back to the size check;
// the SHA-256 assertion after the read remains the authoritative guarantee
// that the bytes parsed are the bytes the scan fingerprinted.
func fileIdentity(os.FileInfo) (uint64, uint64, bool) {
	return 0, 0, false
}
