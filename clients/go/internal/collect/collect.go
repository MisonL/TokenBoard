// Package collect hosts orchestration: the provider registry, source
// classification, failure semantics, and the transient-error rules.
package collect

import (
	"context"
	"os"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Options is what a provider needs to collect: the timezone to attribute
// dates by, the optional date window, and the cursor scope. The scope is the
// endpoint origin for sync runs (empty for preview and warm-hooks), so the
// cursor file a provider reads and writes is per-server — a machine pointed
// at two endpoints never mixes state. Providers derive their cursor path
// with sessioncursor.FileName(source, options.CursorScope).
type Options struct {
	Timezone    string
	Since       string
	Until       string
	CursorScope string
	// StateDir is where the source's cursor file lives. Providers that keep
	// one read and write it themselves, the way the TS providers do; the CLI
	// only owns the post-upload acknowledgement.
	StateDir string
	// HomeDir is the user's home directory, for a provider whose default
	// source location is under it. Empty resolves the process home.
	HomeDir string
	// Stderr receives per-source diagnostics (skipped paths, unreadable
	// entries). Nil discards them.
	Stderr func(line string)
	// Env resolves provider configuration (TOKENBOARD_GROK_HOME, GROK_HOME,
	// ...). The TS collection context threads its env the same way; nil
	// falls back to the process environment.
	Env func(string) string
}

// EnvValue resolves a key through Options.Env, falling back to the process
// environment.
func (o Options) EnvValue(key string) string {
	if o.Env != nil {
		return o.Env(key)
	}
	return os.Getenv(key)
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

// IsOptionalSourceUnavailable mirrors the TS isOptionalSourceUnavailable: the
// "tool is not installed here" messages an all-source run skips instead of
// reporting as a failure. Anything else is a real collection failure.
func IsOptionalSourceUnavailable(source contract.Source, message string) bool {
	switch source {
	case contract.SourceOpenCode:
		return strings.Contains(message, "OpenCode database not found") ||
			strings.Contains(message, "OpenCode SQLite reader unavailable")
	case contract.SourcePi:
		return strings.Contains(message, "No Pi sessions found")
	case contract.SourceGrokBuild:
		return strings.Contains(message, "No Grok Build sessions found")
	case contract.SourceDeepSeekHarness:
		return strings.Contains(message, "No DeepSeek Harness sessions found") ||
			strings.Contains(message, "This Node.js build lacks zstd support")
	case contract.SourceAntigravityCLI, contract.SourceAntigravity, contract.SourceAntigravityIDE:
		return strings.Contains(message, "Antigravity SQLite reader unavailable") ||
			strings.Contains(message, "Antigravity conversations directory not found") ||
			strings.Contains(message, "No Antigravity conversations found")
	}
	return false
}
