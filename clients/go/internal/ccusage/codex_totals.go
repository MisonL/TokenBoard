package ccusage

// Port of codex-token-usage.ts. Codex has emitted totals that either include
// cached input in input_tokens or report cached input as an additional field;
// these helpers keep an explicit total only when it is sufficient and never
// let an inconsistent total discard tokens present in the component fields.

type codexTokenTotals struct {
	inputTokens         float64
	outputTokens        float64
	cacheCreationTokens float64
	cacheReadTokens     float64
	explicitTotalTokens *float64
}

func normalizeCodexTotalTokens(input codexTokenTotals) float64 {
	additiveTotal := input.inputTokens + input.outputTokens + input.cacheCreationTokens + input.cacheReadTokens
	if input.explicitTotalTokens == nil || *input.explicitTotalTokens <= 0 {
		return additiveTotal
	}
	explicit := *input.explicitTotalTokens
	if input.cacheReadTokens > input.inputTokens {
		return mathMax(explicit, additiveTotal)
	}
	baseTotal := input.inputTokens + input.outputTokens
	if explicit >= baseTotal {
		return explicit
	}
	return mathMax(explicit, baseTotal+input.cacheCreationTokens)
}

func mathMax(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}
