// Command tokenboard is the Go client entry point. It stays thin: every
// subcommand lives in internal/cli so the binary surface is testable without
// spawning itself.
package main

import (
	"os"

	"github.com/MisonL/TokenBoard/clients/go/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
