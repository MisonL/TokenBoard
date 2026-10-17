package sessionfile

import "github.com/MisonL/TokenBoard/clients/go/internal/codexusage"

// resolveCodexRawUsage keeps the parser's local call shape while the rules
// live in codexusage (shared with the ccusage normalizer and context pricing).

type codexRawUsageInput struct {
	inputTokens         float64
	outputTokens        float64
	cacheCreationTokens float64
	cacheReadTokens     float64
	explicitTotalTokens *float64
}

type codexRawUsage struct {
	cacheReadIncludedInInput bool
	totalTokens              float64
}

func resolveCodexRawUsage(input codexRawUsageInput) codexRawUsage {
	resolved := codexusage.ResolveRawUsage(codexusage.Totals{
		InputTokens:         input.inputTokens,
		OutputTokens:        input.outputTokens,
		CacheCreationTokens: input.cacheCreationTokens,
		CacheReadTokens:     input.cacheReadTokens,
		ExplicitTotal:       input.explicitTotalTokens,
	})
	return codexRawUsage{
		cacheReadIncludedInInput: resolved.CacheReadIncludedInInput,
		totalTokens:              resolved.TotalTokens,
	}
}
