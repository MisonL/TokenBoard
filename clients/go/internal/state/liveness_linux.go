//go:build linux

package state

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// platformProcessStartIdentity returns "linux:<boot_id>:<start_ticks>" —
// byte-identical to cursor-process-liveness.ts, sourced from the same files
// (/proc/<pid>/stat field 22 after the comm field, /proc/sys/kernel/random/boot_id).
func platformProcessStartIdentity(pid int) (string, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		if os.IsNotExist(err) {
			return "", errProcessGone
		}
		return "", err
	}
	commandEnd := strings.LastIndex(string(raw), ")")
	if commandEnd < 0 {
		return "", fmt.Errorf("stat: unparseable")
	}
	fields := strings.Fields(string(raw[commandEnd+1:]))
	if len(fields) < 20 || !regexp.MustCompile(`^\d+$`).MatchString(fields[19]) {
		return "", fmt.Errorf("stat: start ticks missing")
	}
	bootRaw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	bootID := strings.TrimSpace(string(bootRaw))
	if bootID == "" || len(bootID) > 256 || strings.ContainsAny(bootID, " \t\n") {
		return "", fmt.Errorf("boot_id unusable")
	}
	return fmt.Sprintf("linux:%s:%s", bootID, fields[19]), nil
}
