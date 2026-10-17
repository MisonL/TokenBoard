package sessionfile

// Port of codex-token-usage.ts. Codex has emitted totals that either include
// cached input in input_tokens or report cached input as an additional field;
// these helpers keep an explicit total only when it is sufficient, and never
// let an inconsistent total discard tokens present in the component fields.

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

func normalizeCodexTotalTokens(input codexRawUsageInput) float64 {
	additiveTotal := input.inputTokens + input.outputTokens + input.cacheCreationTokens + input.cacheReadTokens
	if input.explicitTotalTokens == nil || *input.explicitTotalTokens <= 0 {
		return additiveTotal
	}
	explicit := *input.explicitTotalTokens
	// When cached input is reported separately (larger than input_tokens), all
	// component fields must be included. Otherwise input_tokens already
	// contains cached input, and a positive explicit total is authoritative
	// when it is at least the base input/output total.
	if input.cacheReadTokens > input.inputTokens {
		return mathMax(explicit, additiveTotal)
	}
	baseTotal := input.inputTokens + input.outputTokens
	if explicit >= baseTotal {
		return explicit
	}
	return mathMax(explicit, baseTotal+input.cacheCreationTokens)
}

func resolveCodexRawUsage(input codexRawUsageInput) codexRawUsage {
	normalizedTotal := normalizeCodexTotalTokens(input)
	cacheReadIncludedInInput := input.cacheReadTokens <= input.inputTokens &&
		(input.explicitTotalTokens == nil ||
			normalizedTotal == input.inputTokens+input.outputTokens+input.cacheCreationTokens)
	total := normalizedTotal
	if cacheReadIncludedInInput && input.explicitTotalTokens == nil {
		total = input.inputTokens + input.outputTokens + input.cacheCreationTokens
	}
	return codexRawUsage{cacheReadIncludedInInput: cacheReadIncludedInInput, totalTokens: total}
}

func mathMax(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}
