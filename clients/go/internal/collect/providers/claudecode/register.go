package claudecode

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func init() {
	collect.Register(contract.SourceClaudeCode, provider{})
}

type provider struct{}

// Collect adapts Collect to the registry's Provider interface.
func (provider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return Collect(ctx, Options{
		Timezone: options.Timezone,
		Since:    options.Since,
		Until:    options.Until,
		StateDir: options.StateDir,
		HomeDir:  options.HomeDir,
		Stderr:   options.Stderr,
		Env:      options.EnvValue,
	})
}
