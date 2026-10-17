package codex

import (
	"strings"
	"testing"
)

// Port of codex-subagent-usage-math.test.ts: the aggregate identity and the
// integer split the correction relies on.

func baseMetric() Metric {
	return Metric{UsageDate: "2026-05-25", Model: "gpt-5.4"}
}

func TestSumMetricsKeepsTheFirstModelsIdentity(t *testing.T) {
	first := baseMetric()
	first.TotalTokens = 10
	second := baseMetric()
	second.Model = "gpt-5.5"
	second.TotalTokens = 20
	summed, err := SumMetrics([]Metric{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if summed.UsageDate != "2026-05-25" || summed.Model != "gpt-5.4" || summed.TotalTokens != 30 {
		t.Errorf("summed = %+v", summed)
	}
}

func TestSumMetricsRejectsAnEmptyList(t *testing.T) {
	_, err := SumMetrics(nil)
	if err == nil || !strings.Contains(err.Error(), "no model metrics") {
		t.Fatalf("err = %v", err)
	}
}

func TestDistributeMetricSplitsEvenlyAcrossZeroUsageModels(t *testing.T) {
	total := baseMetric()
	total.InputTokens = 5
	total.OutputTokens = 3
	total.CacheReadTokens = 7
	total.TotalTokens = 11
	first := baseMetric()
	second := baseMetric()
	second.Model = "gpt-5.5"
	distributed := DistributeMetric(total, []Metric{first, second})
	if len(distributed) != 2 {
		t.Fatalf("distributed = %+v", distributed)
	}
	if distributed[0].InputTokens != 3 || distributed[0].OutputTokens != 2 ||
		distributed[0].CacheReadTokens != 4 || distributed[0].TotalTokens != 6 {
		t.Errorf("first = %+v", distributed[0])
	}
	if distributed[1].InputTokens != 2 || distributed[1].OutputTokens != 1 ||
		distributed[1].CacheReadTokens != 3 || distributed[1].TotalTokens != 5 {
		t.Errorf("second = %+v", distributed[1])
	}
}

func TestDistributeMetricKeepsThePartsSummingToTheTotal(t *testing.T) {
	total := baseMetric()
	total.InputTokens = 100
	total.TotalTokens = 100
	first := baseMetric()
	first.TotalTokens = 1
	second := baseMetric()
	second.Model = "gpt-5.5"
	second.TotalTokens = 2
	distributed := DistributeMetric(total, []Metric{first, second})
	sum := distributed[0].InputTokens + distributed[1].InputTokens
	if sum != 100 {
		t.Errorf("parts sum = %v, want 100", sum)
	}
}

func TestSubtractMetricFailsClosedWhenTheRightSideExceedsTheLeft(t *testing.T) {
	left := baseMetric()
	left.InputTokens = 5
	right := baseMetric()
	right.InputTokens = 10
	_, err := SubtractMetric(left, right)
	if err == nil || !strings.Contains(err.Error(), "correction exceeded") {
		t.Fatalf("err = %v", err)
	}
}

func TestSubtractMetricClampsATinyFloatUndershootToZero(t *testing.T) {
	left := baseMetric()
	left.CostUSD = 0.3
	right := baseMetric()
	right.CostUSD = 0.30000000000000004
	subtracted, err := SubtractMetric(left, right)
	if err != nil {
		t.Fatal(err)
	}
	if subtracted.CostUSD != 0 {
		t.Errorf("cost = %v, want 0", subtracted.CostUSD)
	}
}

func TestProrateCostScalesByTheTokenRatio(t *testing.T) {
	if got := ProrateCost(10, 5, 10); got != 5 {
		t.Errorf("prorated = %v", got)
	}
	if got := ProrateCost(10, 5, 0); got != 0 {
		t.Errorf("zero original tokens must give zero, got %v", got)
	}
}

func TestAddMetricAccumulatesByDateAndModel(t *testing.T) {
	adjustments := map[string]Metric{}
	first := baseMetric()
	first.TotalTokens = 1
	AddMetric(adjustments, first)
	second := baseMetric()
	second.TotalTokens = 2
	AddMetric(adjustments, second)
	if len(adjustments) != 1 {
		t.Fatalf("adjustments = %v", adjustments)
	}
	if got := adjustments[SnapshotKey("2026-05-25", "gpt-5.4")].TotalTokens; got != 3 {
		t.Errorf("total = %v", got)
	}
}
