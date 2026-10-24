//go:build windows

package state

import "testing"

// spawnDeadPid is unsupported on Windows (no cheap signal-0 probe); the stale
// test skips there.
func spawnDeadPid(t *testing.T) int {
	t.Helper()
	t.Skip("stale-pid probe unsupported on windows")
	return -1
}
