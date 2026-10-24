package antigravitygui

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func init() {
	collect.Register(contract.SourceAntigravity, provider{source: contract.SourceAntigravity})
	collect.Register(contract.SourceAntigravityIDE, provider{source: contract.SourceAntigravityIDE})
}

// provider adapts one GUI/IDE source to the shared collect contract. The two
// sources differ only in the source name, which selects the cursor namespace
// and the default conversations directory.
type provider struct {
	source contract.Source
}

// Collect adapts the shared collection options to this source's own.
func (p provider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	_ = ctx
	return Collect(Options{
		Source:      Source(p.source),
		Timezone:    options.Timezone,
		Since:       options.Since,
		StateDir:    options.StateDir,
		CursorScope: options.CursorScope,
		Stderr:      options.Stderr,
		Env:         options.Env,
		HomeDir:     options.HomeDir,
	})
}
