// Package collect hosts orchestration: the provider registry, source
// classification, failure semantics, and the transient-error rules.
package collect

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Options is what a provider needs to collect: the timezone to attribute
// dates by, and the optional date window.
type Options struct {
	Timezone string
	Since    string
	Until    string
}

// Provider reads one source's local usage records and normalizes them. It
// never uploads or writes cursors itself — the CLI owns those.
type Provider interface {
	Collect(ctx context.Context, options Options) ([]contract.Snapshot, error)
}

// registry maps a source to its provider. Providers register themselves from
// their own files' init functions, so adding one never edits this package.
var registry = map[contract.Source]Provider{}

// Register installs a provider for a source; called from provider packages.
func Register(source contract.Source, provider Provider) {
	registry[source] = provider
}

// Lookup returns the provider for a source. Absent means the source is
// unavailable on this machine (its tool is not installed) — not a failure.
func Lookup(source contract.Source) (Provider, bool) {
	provider, ok := registry[source]
	return provider, ok
}
