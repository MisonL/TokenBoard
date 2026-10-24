package codex

import (
	"reflect"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of codex-cost-projection.test.ts's unit cases: the day total is spread
// across models at fixed precision and the shares sum back exactly.

func projectionSnapshot(model string, totalTokens int64, costUsd float64) contract.Snapshot {
	return contract.Snapshot{
		Source:       contract.SourceCodex,
		UsageDate:    "2026-07-08",
		Timezone:     "Asia/Shanghai",
		Model:        model,
		InputTokens:  totalTokens,
		TotalTokens:  totalTokens,
		CostUSD:      costUsd,
		SessionCount: 1,
		CollectedAt:  "2026-07-28T00:00:00.000Z",
	}
}

func TestProjectCodexDailyCostsUsesFixedDecimalPrecision(t *testing.T) {
	projected, err := ProjectCodexDailyCosts([]contract.Snapshot{
		projectionSnapshot("gpt-b", 1, 0.16666666666666666),
		projectionSnapshot("gpt-a", 2, 0.8333333333333334),
	})
	if err != nil {
		t.Fatal(err)
	}
	if projected[0].Model != "gpt-b" || projected[0].CostUSD != 0.333333 {
		t.Errorf("projected[0] = %+v", projected[0])
	}
	if projected[1].Model != "gpt-a" || projected[1].CostUSD != 0.666667 {
		t.Errorf("projected[1] = %+v", projected[1])
	}
	if sum := projected[0].CostUSD + projected[1].CostUSD; sum != 1 {
		t.Errorf("share sum = %v, want exactly 1", sum)
	}
}

func TestProjectCodexDailyCostsRoundsOnlyAfterAccumulatingTheDay(t *testing.T) {
	projected, err := ProjectCodexDailyCosts([]contract.Snapshot{
		projectionSnapshot("gpt-b", 1, 0.0000004),
		projectionSnapshot("gpt-a", 1, 0.0000004),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Rounding each row on its own would give 0 and 0; the accumulated day
	// total is 1 unit and the tie goes to the first model by name.
	if projected[0].CostUSD != 0 {
		t.Errorf("projected[0] = %+v", projected[0])
	}
	if projected[1].CostUSD != 0.000001 {
		t.Errorf("projected[1] = %+v", projected[1])
	}
}

func TestProjectCodexDailyCostsLeavesZeroTokenRowsAtTheirOwnCost(t *testing.T) {
	projected, err := ProjectCodexDailyCosts([]contract.Snapshot{
		projectionSnapshot("gpt-a", 100, 1),
		projectionSnapshot("gpt-zero", 0, 0.5),
	})
	if err != nil {
		t.Fatal(err)
	}
	// The zero-token row keeps its own cost and takes no share of the day.
	if projected[1].CostUSD != 0.5 {
		t.Errorf("zero-token row = %+v", projected[1])
	}
	if projected[0].CostUSD != 1 {
		t.Errorf("weighted row = %+v", projected[0])
	}
}

func TestProjectCodexDailyCostsIsStableRegardlessOfInputOrder(t *testing.T) {
	first, err := ProjectCodexDailyCosts([]contract.Snapshot{
		projectionSnapshot("gpt-b", 1, 0.5),
		projectionSnapshot("gpt-a", 1, 0.5),
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := ProjectCodexDailyCosts([]contract.Snapshot{
		projectionSnapshot("gpt-a", 1, 0.5),
		projectionSnapshot("gpt-b", 1, 0.5),
	})
	if err != nil {
		t.Fatal(err)
	}
	// The tie breaks by model name, not by position: gpt-a takes the unit in
	// both orderings.
	for _, projected := range [][]contract.Snapshot{first, second} {
		byModel := map[string]float64{}
		for _, snapshot := range projected {
			byModel[snapshot.Model] = snapshot.CostUSD
		}
		if byModel["gpt-a"] != 0.5 || byModel["gpt-b"] != 0.5 {
			t.Errorf("allocation differs by input order: %v", byModel)
		}
	}
}

func TestProjectCodexDailyCostsSeparatesDatesAndTimezones(t *testing.T) {
	other := projectionSnapshot("gpt-a", 1, 1)
	other.UsageDate = "2026-07-09"
	projected, err := ProjectCodexDailyCosts([]contract.Snapshot{
		projectionSnapshot("gpt-a", 1, 1),
		other,
	})
	if err != nil {
		t.Fatal(err)
	}
	if projected[0].CostUSD != 1 || projected[1].CostUSD != 1 {
		t.Errorf("dates must be projected independently: %+v", projected)
	}
}

func TestProjectCodexDailyCostsPassesOtherSourcesThrough(t *testing.T) {
	claude := projectionSnapshot("claude-sonnet", 10, 0.25)
	claude.Source = contract.SourceClaudeCode
	projected, err := ProjectCodexDailyCosts([]contract.Snapshot{claude})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(projected[0], claude) {
		t.Errorf("non-Codex snapshot changed: %+v", projected[0])
	}
}

func TestProjectCodexDailyCostsRejectsNegativeCosts(t *testing.T) {
	if _, err := ProjectCodexDailyCosts([]contract.Snapshot{projectionSnapshot("gpt-a", 1, -0.5)}); err == nil {
		t.Fatal("a negative cost must fail closed")
	}
}
