package deepseekharness

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func init() {
	collect.Register(contract.SourceDeepSeekHarness, provider{})
}

type provider struct{}

// Collect adapts Collect to the registry's Provider interface.
func (provider) Collect(_ context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return Collect(Options{
		Timezone: options.Timezone,
		Since:    options.Since,
		Stderr:   options.Stderr,
		Env:      options.EnvValue,
	})
}
