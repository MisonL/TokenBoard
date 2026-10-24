package codexusage

import "testing"

// Port of codex-token-usage.test.ts: the legacy/additive discriminator and the
// total rules that feed every Codex snapshot's token count.

func ptr(value float64) *float64 { return &value }

func TestResolveRawUsageKeepsALegacyTotalFreeOfDoubleCountedCachedInput(t *testing.T) {
	got := ResolveRawUsage(Totals{InputTokens: 100, OutputTokens: 1, CacheReadTokens: 40})
	if got.CacheReadIncludedInInput != true || got.TotalTokens != 101 {
		t.Errorf("got = %+v", got)
	}
}

func TestResolveRawUsageKeepsALegacyTotalConsistentWithALowExplicitTotal(t *testing.T) {
	got := ResolveRawUsage(Totals{
		InputTokens: 20, OutputTokens: 4, CacheCreationTokens: 3, CacheReadTokens: 5,
		ExplicitTotal: ptr(10),
	})
	if got.CacheReadIncludedInInput != true || got.TotalTokens != 27 {
		t.Errorf("got = %+v", got)
	}
}

func TestResolveRawUsageAddsACacheReadThatCannotFitInsideInputTokens(t *testing.T) {
	got := ResolveRawUsage(Totals{InputTokens: 100, OutputTokens: 1, CacheReadTokens: 200})
	if got.CacheReadIncludedInInput != false || got.TotalTokens != 301 {
		t.Errorf("got = %+v", got)
	}
}

func TestResolveRawUsageTreatsAnExplicitAdditiveTotalAsAdditive(t *testing.T) {
	got := ResolveRawUsage(Totals{
		InputTokens: 20, OutputTokens: 4, CacheCreationTokens: 3, CacheReadTokens: 5,
		ExplicitTotal: ptr(32),
	})
	if got.CacheReadIncludedInInput != false || got.TotalTokens != 32 {
		t.Errorf("got = %+v", got)
	}
}

func TestNormalizeTotalKeepsAnExplicitTotalWhenInputAlreadyIncludesCacheCreation(t *testing.T) {
	got := NormalizeTotal(Totals{
		InputTokens: 100, OutputTokens: 20, CacheCreationTokens: 30, CacheReadTokens: 10,
		ExplicitTotal: ptr(120),
	})
	if got != 120 {
		t.Errorf("got = %v, want 120", got)
	}
}

func TestNormalizeTotalAddsSeparatelyReportedCachedInputWhenItExceedsInput(t *testing.T) {
	got := NormalizeTotal(Totals{
		InputTokens: 10, OutputTokens: 4, CacheCreationTokens: 3, CacheReadTokens: 20,
		ExplicitTotal: ptr(15),
	})
	if got != 37 {
		t.Errorf("got = %v, want 37", got)
	}
}

func TestNormalizeTotalAddsAllComponentFieldsWhenTotalIsOmitted(t *testing.T) {
	got := NormalizeTotal(Totals{InputTokens: 200, OutputTokens: 20, CacheReadTokens: 150})
	if got != 370 {
		t.Errorf("got = %v, want 370", got)
	}
}

func TestNormalizeTotalRaisesAnInconsistentLowExplicitTotal(t *testing.T) {
	got := NormalizeTotal(Totals{
		InputTokens: 20, OutputTokens: 4, CacheCreationTokens: 3, CacheReadTokens: 5,
		ExplicitTotal: ptr(10),
	})
	if got != 27 {
		t.Errorf("got = %v, want 27", got)
	}
}

// A zero or negative explicit total is unusable, exactly like an absent one.
func TestNormalizeTotalIgnoresNonPositiveExplicitTotals(t *testing.T) {
	for _, explicit := range []float64{0, -5} {
		got := NormalizeTotal(Totals{InputTokens: 10, OutputTokens: 2, ExplicitTotal: ptr(explicit)})
		if got != 12 {
			t.Errorf("explicit %v: got %v, want 12", explicit, got)
		}
	}
}
