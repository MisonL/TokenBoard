// Package codexusage ports codex-token-usage.ts: how Codex token records are
// totalled. Codex has emitted totals that either include cached input inside
// input_tokens (the legacy representation) or report cached input as an
// additional field (the additive one); these helpers keep an explicit total
// only when it is sufficient and never let an inconsistent total discard
// tokens present in the component fields.
//
// The rules live in one package because three readers need the identical
// answer: the session JSONL parser, the ccusage daily normalizer and the
// context-pricing layer. A second copy would drift silently — the totals feed
// the snapshot hash, so a divergence changes what the server deduplicates.
package codexusage

// Totals is the component set one Codex record reports.
type Totals struct {
	InputTokens         float64
	OutputTokens        float64
	CacheCreationTokens float64
	CacheReadTokens     float64
	// ExplicitTotal is the record's own total when usable (positive), else nil.
	ExplicitTotal *float64
}

// NormalizeTotal ports normalizeCodexTotalTokens.
func NormalizeTotal(input Totals) float64 {
	additiveTotal := input.InputTokens + input.OutputTokens + input.CacheCreationTokens + input.CacheReadTokens
	if input.ExplicitTotal == nil || *input.ExplicitTotal <= 0 {
		return additiveTotal
	}
	explicit := *input.ExplicitTotal
	// When cached input is reported separately (larger than input_tokens), all
	// component fields must be included to avoid dropping those tokens. In the
	// other representation input_tokens already contains cached input, and a
	// positive explicit total is authoritative when it is at least the base
	// input/output total. Older malformed rows with a lower explicit total are
	// still raised to the minimum that preserves the separately reported cache
	// creation tokens.
	if input.CacheReadTokens > input.InputTokens {
		return mathMax(explicit, additiveTotal)
	}
	baseTotal := input.InputTokens + input.OutputTokens
	if explicit >= baseTotal {
		return explicit
	}
	return mathMax(explicit, baseTotal+input.CacheCreationTokens)
}

// RawUsage is the resolved representation plus its total.
type RawUsage struct {
	// CacheReadIncludedInInput reports the legacy representation: input_tokens
	// already contains the cached input.
	CacheReadIncludedInInput bool
	TotalTokens              float64
}

// ResolveRawUsage ports resolveCodexRawUsage.
//
// A usable explicit total is the reliable discriminator: equal to input +
// output + cache creation means the cache read is already inside input_tokens.
// Without one, the remaining signal is that a legacy record cannot carry more
// cached input than input_tokens, since that field already contains it; a
// larger cache read is additive by contradiction. A legacy total must exclude
// the folded cache read — adding it again would count those tokens twice,
// which is exactly what the additive fallback would do for these rows.
func ResolveRawUsage(input Totals) RawUsage {
	normalizedTotal := NormalizeTotal(input)
	cacheReadIncludedInInput := input.CacheReadTokens <= input.InputTokens &&
		(input.ExplicitTotal == nil ||
			normalizedTotal == input.InputTokens+input.OutputTokens+input.CacheCreationTokens)
	total := normalizedTotal
	if cacheReadIncludedInInput && input.ExplicitTotal == nil {
		total = input.InputTokens + input.OutputTokens + input.CacheCreationTokens
	}
	return RawUsage{CacheReadIncludedInInput: cacheReadIncludedInInput, TotalTokens: total}
}

func mathMax(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}
