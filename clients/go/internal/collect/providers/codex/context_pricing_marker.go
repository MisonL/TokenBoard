package codex

import (
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// The cursor layer stamps Codex snapshots whose cost the context pricing pass
// must still resolve; the marker is a hook so the cursor package does not
// depend on the pricing rules. TS wires the same rule in updateCursorFile via
// isUnresolvedCodexContextPricingSnapshot. Importing this package (the
// provider registry does) installs it.
func init() {
	sessioncursor.ContextPricingMarker = markUnresolvedContextPricing
}

// markUnresolvedContextPricing ports the `cursor.source === 'codex'` branch of
// updateCursorFile. It only ever sets the flag: a carried-over snapshot that
// already has it keeps it until an acknowledgement clears it, which is what
// the TS spread does.
func markUnresolvedContextPricing(snapshots []sessioncursor.Snapshot) []sessioncursor.Snapshot {
	out := make([]sessioncursor.Snapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		if IsUnresolvedCodexContextPricingSnapshot(cursorCostSnapshot(snapshot)) {
			snapshot.CodexContextPricingPending = true
		}
		out = append(out, snapshot)
	}
	return out
}

// cursorCostSnapshot adapts a cursor snapshot for the pricing matcher. Every
// token field is present on a cursor snapshot, which is what the TS matcher
// sees for these rows.
func cursorCostSnapshot(snapshot sessioncursor.Snapshot) CostSnapshot {
	total := snapshot.TotalTokens
	input := snapshot.InputTokens
	output := snapshot.OutputTokens
	cacheRead := snapshot.CacheReadTokens
	cacheCreation := snapshot.CacheCreationTokens
	return CostSnapshot{
		Source:              snapshot.Source,
		UsageDate:           snapshot.UsageDate,
		Model:               snapshot.Model,
		CostUSD:             snapshot.CostUSD,
		TotalTokens:         &total,
		InputTokens:         &input,
		OutputTokens:        &output,
		CacheReadTokens:     &cacheRead,
		CacheCreationTokens: &cacheCreation,
	}
}
