package antigravitycli

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func init() {
	collect.Register(contract.SourceAntigravityCLI, provider{})
}

type provider struct{}

// Collect adapts the shared collection options to this source's own.
func (provider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	_ = ctx
	return Collect(Options{
		Timezone:    options.Timezone,
		Since:       options.Since,
		StateDir:    options.StateDir,
		CursorScope: options.CursorScope,
		Stderr:      options.Stderr,
		Env:         options.Env,
		HomeDir:     options.HomeDir,
	})
}
