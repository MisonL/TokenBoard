package ccusage

import "github.com/MisonL/TokenBoard/clients/go/internal/codexusage"

// Port of codex-token-usage.ts's normalizeCodexTotalTokens. The rules live in
// codexusage so the parser, this normalizer and the context-pricing layer
// cannot drift; the total feeds the snapshot hash.

type codexTokenTotals struct {
	inputTokens         float64
	outputTokens        float64
	cacheCreationTokens float64
	cacheReadTokens     float64
	explicitTotalTokens *float64
}

func normalizeCodexTotalTokens(input codexTokenTotals) float64 {
	return codexusage.NormalizeTotal(codexusage.Totals{
		InputTokens:         input.inputTokens,
		OutputTokens:        input.outputTokens,
		CacheCreationTokens: input.cacheCreationTokens,
		CacheReadTokens:     input.cacheReadTokens,
		ExplicitTotal:       input.explicitTotalTokens,
	})
}
