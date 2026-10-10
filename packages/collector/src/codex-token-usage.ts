export type CodexTokenUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  explicitTotalTokens?: number
}

// Codex has emitted totals that either include cached input in input_tokens or
// report cached input as an additional field. Keep explicit totals when they
// are sufficient, but never let an inconsistent total violate the snapshot
// contract or discard tokens that are present in the component fields.
export function normalizeCodexTotalTokens(input: CodexTokenUsageTotals) {
  const additiveTotal = input.inputTokens + input.outputTokens + input.cacheCreationTokens + input.cacheReadTokens

  if (input.explicitTotalTokens === undefined || input.explicitTotalTokens <= 0) {
    return additiveTotal
  }

  // When cached input is reported separately (larger than input_tokens), all
  // component fields must be included to avoid dropping those tokens. In the
  // other representation input_tokens already contains cached input, and a
  // positive explicit total is authoritative when it is at least the base
  // input/output total. Older malformed rows with a lower explicit total are
  // still raised to the minimum that preserves the separately reported cache
  // creation tokens.
  if (input.cacheReadTokens > input.inputTokens) {
    return Math.max(input.explicitTotalTokens, additiveTotal)
  }

  const baseTotal = input.inputTokens + input.outputTokens
  if (input.explicitTotalTokens >= baseTotal) return input.explicitTotalTokens
  return Math.max(input.explicitTotalTokens, baseTotal + input.cacheCreationTokens)
}

export type CodexRawUsageInput = {
  /** The record's reported input_tokens, which may already contain the cached input. */
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** The record's explicit total when it is usable (a positive number), else undefined. */
  explicitTotalTokens?: number
}

export type CodexRawUsage = {
  /** Whether input_tokens already contains the cached input (the legacy representation). */
  cacheReadIncludedInInput: boolean
  /** The total under the representation the record actually uses. */
  totalTokens: number
}

// Raw Codex session records have emitted both representations over time: older records
// include cached input in input_tokens, newer ones report it as a separate additive field.
// A usable explicit total is the reliable discriminator — equal to input + output + cache
// creation means the cache read is already inside input_tokens. Without one, the remaining
// signal is that a legacy record cannot carry more cached input than input_tokens, since
// that field already contains it; a larger cache read is additive by contradiction. A
// legacy total must exclude the folded cache read — adding it again would count those
// tokens twice, which is exactly what the additive fallback of normalizeCodexTotalTokens
// would do for these rows.
export function resolveCodexRawUsage(input: CodexRawUsageInput): CodexRawUsage {
  const normalizedTotal = normalizeCodexTotalTokens(input)
  const cacheReadIncludedInInput =
    input.cacheReadTokens <= input.inputTokens &&
    (input.explicitTotalTokens === undefined ||
      normalizedTotal === input.inputTokens + input.outputTokens + input.cacheCreationTokens)
  return {
    cacheReadIncludedInInput,
    totalTokens:
      cacheReadIncludedInInput && input.explicitTotalTokens === undefined
        ? input.inputTokens + input.outputTokens + input.cacheCreationTokens
        : normalizedTotal
  }
}
