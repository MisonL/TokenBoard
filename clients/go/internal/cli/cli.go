// Package cli wires the tokenboard subcommands. Only the dispatch and exit
// semantics live here for now; preview/sync arrive with their milestones.
package cli

import (
	"fmt"
	"io"
)

// Exit codes shared with the TS collector. 75 is the scheduler retry
// contract: a transient failure the launchd/systemd/schtasks wrapper may
// re-run.
const (
	ExitOK        = 0
	ExitUsage     = 2
	ExitTransient = 75
)

// Run executes one CLI invocation and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: tokenboard <command> [flags]")
		fmt.Fprintln(stderr, "commands: version, help")
		return ExitUsage
	}
	switch args[0] {
	case "version":
		fmt.Fprintln(stdout, "tokenboard (go) dev")
		return ExitOK
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, "usage: tokenboard <command> [flags]")
		fmt.Fprintln(stdout, "commands: version, help")
		return ExitOK
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		return ExitUsage
	}
}
