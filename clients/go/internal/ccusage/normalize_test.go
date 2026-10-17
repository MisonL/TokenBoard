package ccusage

import (
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of normalize-ccusage.test.ts. Inputs are the JSON-shaped maps the TS
// tests pass; NormalizeCcusageDailyJSON converts them internally, so the
// assertions pin the same values the TS suite does.

const normalizeCollectedAt = "2026-04-28T10:00:00.000Z"

// jsonInput decodes a JSON document the way the production command runner
// does, so object key order is preserved. Handing NormalizeCcusageDailyJSON a
// Go map would sort the keys and change which model a session token tie picks.
func jsonInput(t *testing.T, text string) any {
	t.Helper()
	value, err := decodeOrdered([]byte(text))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return value
}

func TestNormalizeAllocatesMissingModelCostProRataFromTheParentDay(t *testing.T) {
	input := jsonInput(t, `{
		"type": "daily",
		"data": [{
			"date": "2026-04-28",
			"totalTokens": 300,
			"costUSD": 3,
			"breakdown": {
				"claude-sonnet-4-5": {"inputTokens": 100, "outputTokens": 0, "totalTokens": 100},
				"claude-opus-4-1": {"inputTokens": 200, "outputTokens": 0, "totalTokens": 200}
			}
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if snapshots[0].Model != "claude-sonnet-4-5" || snapshots[0].CostUSD != 1 {
		t.Errorf("snapshot[0] = %+v", snapshots[0])
	}
	if snapshots[1].Model != "claude-opus-4-1" || snapshots[1].CostUSD != 2 {
		t.Errorf("snapshot[1] = %+v", snapshots[1])
	}
	if sum := snapshots[0].CostUSD + snapshots[1].CostUSD; sum != 3 {
		t.Errorf("allocated cost sum = %v, want 3", sum)
	}
}

func TestNormalizeDailyBreakdownRowsIntoPerModelSnapshots(t *testing.T) {
	input := jsonInput(t, `{
		"type": "daily",
		"data": [{
			"date": "2026-04-28",
			"breakdown": {
				"claude-sonnet-4-5": {
					"inputTokens": 100, "outputTokens": 50,
					"cacheCreationTokens": 10, "cacheReadTokens": 5,
					"totalTokens": 165, "costUSD": 0.12
				}
			}
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := contract.Snapshot{
		Source:        contract.SourceClaudeCode,
		UsageDate:     "2026-04-28",
		Timezone:      "Asia/Shanghai",
		Model:         "claude-sonnet-4-5",
		InputTokens:   100,
		OutputTokens:  50,
		CacheCreation: 10,
		CacheRead:     5,
		TotalTokens:   165,
		CostUSD:       0.12,
		SessionCount:  0,
		CollectedAt:   normalizeCollectedAt,
	}
	if len(snapshots) != 1 || snapshots[0] != want {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

func TestNormalizeRecomputesInconsistentCodexDailyTotals(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{
			"date": "2026-04-28", "model": "gpt-5",
			"inputTokens": 10, "outputTokens": 4,
			"cacheCreationTokens": 3, "cacheReadTokens": 20, "totalTokens": 15
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceCodex, Timezone: "UTC", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := snapshots[0]
	if got.InputTokens != 10 || got.OutputTokens != 4 || got.CacheCreation != 3 || got.CacheRead != 20 || got.TotalTokens != 37 {
		t.Errorf("snapshot = %+v", got)
	}
}

func TestNormalizeKeepsCodexSnakeCaseCacheAliasesConsistent(t *testing.T) {
	input := jsonInput(t, `{
		"data": [
			{
				"date": "2026-04-28", "model": "gpt-5",
				"inputTokens": 10, "outputTokens": 2,
				"cache_creation_input_tokens": 3, "cache_read_input_tokens": 4
			},
			{
				"date": "2026-04-28", "model": "gpt-5-mini",
				"input_tokens": 1, "output_tokens": 1,
				"cache_write_input_tokens": 2, "cached_input_tokens": 5
			}
		]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceCodex, Timezone: "UTC", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	first, second := snapshots[0], snapshots[1]
	if first.Model != "gpt-5" || first.InputTokens != 10 || first.OutputTokens != 2 ||
		first.CacheCreation != 3 || first.CacheRead != 4 || first.TotalTokens != 19 {
		t.Errorf("first = %+v", first)
	}
	if second.Model != "gpt-5-mini" || second.InputTokens != 1 || second.OutputTokens != 1 ||
		second.CacheCreation != 2 || second.CacheRead != 5 || second.TotalTokens != 9 {
		t.Errorf("second = %+v", second)
	}
}

func TestNormalizeStandardDailyRowsWithoutBreakdown(t *testing.T) {
	input := jsonInput(t, `{
		"daily": [{
			"date": "2026-04-28",
			"inputTokens": 100, "outputTokens": 50,
			"cacheCreationTokens": 10, "cacheReadTokens": 5,
			"totalTokens": 165, "totalCost": 0.12,
			"modelsUsed": ["claude-sonnet-4-5", "claude-opus-4-5"]
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "UTC", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	if got.Model != "all" || got.InputTokens != 100 || got.OutputTokens != 50 ||
		got.CacheCreation != 10 || got.CacheRead != 5 || got.TotalTokens != 165 || got.CostUSD != 0.12 {
		t.Errorf("snapshot = %+v", got)
	}
}

func TestNormalizeAcceptsAgentRowsUsingPeriodInsteadOfDate(t *testing.T) {
	input := jsonInput(t, `{
		"daily": [{
			"period": "2026-05-18", "agent": "claude",
			"inputTokens": 100, "outputTokens": 50, "totalTokens": 150, "totalCost": 0.12,
			"modelBreakdowns": [{
				"modelName": "claude-opus-4-6",
				"inputTokens": 100, "outputTokens": 50, "totalTokens": 150, "cost": 0.12
			}]
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	if got.UsageDate != "2026-05-18" || got.Model != "claude-opus-4-6" ||
		got.InputTokens != 100 || got.OutputTokens != 50 || got.TotalTokens != 150 || got.CostUSD != 0.12 {
		t.Errorf("snapshot = %+v", got)
	}
}

func TestNormalizeRejectsImpossibleISODateInDailyUsage(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{"date": "2026-02-30", "model": "gpt-5", "inputTokens": 1, "totalTokens": 1}]
	}`)
	_, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceCodex, Timezone: "UTC", CollectedAt: normalizeCollectedAt,
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid ccusage date") {
		t.Fatalf("err = %v", err)
	}
}

func TestNormalizeRejectsImpossibleISODateInSessionMetadata(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{"date": "2026-04-28", "model": "gpt-5", "inputTokens": 1, "totalTokens": 1}]
	}`)
	sessions := jsonInput(t, `{
		"data": [{
			"lastActivity": "2026-04-31T12:00:00.000Z", "model": "gpt-5",
			"inputTokens": 1, "totalTokens": 1
		}]
	}`)
	_, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceCodex, Timezone: "UTC", CollectedAt: normalizeCollectedAt,
		Sessions: sessions, HasSessions: true,
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid ccusage date") {
		t.Fatalf("err = %v", err)
	}
}

func TestNormalizeAcceptsCacheInputTokenAliasesFromCompanionCLIs(t *testing.T) {
	input := jsonInput(t, `{
		"type": "daily",
		"data": [{
			"date": "2026-04-28", "models": ["gpt-5"],
			"inputTokens": 120, "outputTokens": 80,
			"cacheCreationInputTokens": 7, "cacheReadInputTokens": 11,
			"costUSD": 0.25
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceCodex, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	if got.Model != "gpt-5" || got.InputTokens != 120 || got.OutputTokens != 80 ||
		got.CacheCreation != 7 || got.CacheRead != 11 || got.TotalTokens != 218 || got.CostUSD != 0.25 {
		t.Errorf("snapshot = %+v", got)
	}
}

const codexDisplayDateDailyJSON = `{
	"daily": [{
		"date": "Apr 28, 2026",
		"inputTokens": 63578474, "cachedInputTokens": 58842240,
		"outputTokens": 250965, "totalTokens": 63829439, "costUSD": 18.860285,
		"models": {
			"gpt-5.4": {
				"inputTokens": 6663074, "cachedInputTokens": 4871680,
				"outputTokens": 45372, "totalTokens": 6708446
			},
			"gpt-5.5": {
				"inputTokens": 56915400, "cachedInputTokens": 53970560,
				"outputTokens": 205593, "totalTokens": 57120993
			}
		}
	}]
}`

func TestNormalizeCodexRowsWithDisplayDatesAndModelsObject(t *testing.T) {
	snapshots, err := NormalizeCcusageDailyJSON(jsonInput(t, codexDisplayDateDailyJSON), NormalizeOptions{
		Source: contract.SourceCodex, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	first, second := snapshots[0], snapshots[1]
	if first.UsageDate != "2026-04-28" || first.Model != "gpt-5.4" ||
		first.InputTokens != 6663074 || first.OutputTokens != 45372 ||
		first.CacheRead != 4871680 || first.TotalTokens != 6708446 {
		t.Errorf("first = %+v", first)
	}
	if second.Model != "gpt-5.5" || second.InputTokens != 56915400 || second.OutputTokens != 205593 ||
		second.CacheRead != 53970560 || second.TotalTokens != 57120993 {
		t.Errorf("second = %+v", second)
	}
	const epsilon = 1e-9
	if diff := first.CostUSD - 1.9822076685823609; diff > epsilon || diff < -epsilon {
		t.Errorf("first cost = %v", first.CostUSD)
	}
	if diff := second.CostUSD - 16.878077331417643; diff > epsilon || diff < -epsilon {
		t.Errorf("second cost = %v", second.CostUSD)
	}
	if diff := first.CostUSD + second.CostUSD - 18.860285; diff > epsilon || diff < -epsilon {
		t.Errorf("cost sum = %v", first.CostUSD+second.CostUSD)
	}
}

const multiModelSessionCountJSON = `{
	"data": [{
		"date": "2026-04-28",
		"modelBreakdowns": [
			{"modelName": "claude-sonnet", "inputTokens": 100, "outputTokens": 10},
			{"modelName": "claude-opus", "inputTokens": 200, "outputTokens": 20}
		]
	}]
}`

const multiModelSessionRowsJSON = `{
	"data": [
		{
			"sessionId": "s1", "lastActivity": "2026-04-28T10:00:00.000Z",
			"modelBreakdowns": {"claude-sonnet": {"inputTokens": 100, "outputTokens": 10}}
		},
		{
			"sessionId": "s2", "lastActivity": "2026-04-28T11:00:00.000Z",
			"modelBreakdowns": {"claude-opus": {"inputTokens": 200, "outputTokens": 20}}
		},
		{
			"sessionId": "s3", "lastActivity": "2026-04-28T12:00:00.000Z",
			"modelBreakdowns": {
				"claude-sonnet": {"inputTokens": 30, "outputTokens": 3},
				"claude-opus": {"inputTokens": 40, "outputTokens": 4}
			}
		}
	]
}`

func TestNormalizeDoesNotDoubleCountSessionsUsingMultipleModels(t *testing.T) {
	snapshots, err := NormalizeCcusageDailyJSON(jsonInput(t, multiModelSessionCountJSON), NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
		Sessions: jsonInput(t, multiModelSessionRowsJSON), HasSessions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if snapshots[0].Model != "claude-sonnet" || snapshots[0].SessionCount != 1 {
		t.Errorf("snapshot[0] = %+v", snapshots[0])
	}
	if snapshots[1].Model != "claude-opus" || snapshots[1].SessionCount != 2 {
		t.Errorf("snapshot[1] = %+v", snapshots[1])
	}
	if total := snapshots[0].SessionCount + snapshots[1].SessionCount; total != 3 {
		t.Errorf("session total = %v, want 3", total)
	}
}

func TestNormalizeDoesNotFallBackToPerModelSessionCountsWhenRowsProvided(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{
			"date": "2026-04-28",
			"modelBreakdowns": [
				{"modelName": "claude-sonnet", "inputTokens": 30, "outputTokens": 3, "sessionCount": 1},
				{"modelName": "claude-opus", "inputTokens": 40, "outputTokens": 4, "sessionCount": 1}
			]
		}]
	}`)
	sessions := jsonInput(t, `{
		"data": [{
			"sessionId": "s1", "lastActivity": "2026-04-28T12:00:00.000Z",
			"modelBreakdowns": {
				"claude-sonnet": {"inputTokens": 30, "outputTokens": 3},
				"claude-opus": {"inputTokens": 40, "outputTokens": 4}
			}
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
		Sessions: sessions, HasSessions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if snapshots[0].Model != "claude-sonnet" || snapshots[0].SessionCount != 0 {
		t.Errorf("snapshot[0] = %+v", snapshots[0])
	}
	if snapshots[1].Model != "claude-opus" || snapshots[1].SessionCount != 1 {
		t.Errorf("snapshot[1] = %+v", snapshots[1])
	}
	if total := snapshots[0].SessionCount + snapshots[1].SessionCount; total != 1 {
		t.Errorf("session total = %v, want 1", total)
	}
}

func TestNormalizeMatchesSessionCountsUsingTheReportTimezone(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{
			"date": "2026-04-28",
			"modelBreakdowns": [{"modelName": "claude-opus", "inputTokens": 40, "outputTokens": 4}]
		}]
	}`)
	sessions := jsonInput(t, `{
		"data": [{
			"sessionId": "s1", "lastActivity": "2026-04-27T16:10:00.000Z",
			"modelBreakdowns": {"claude-opus": {"inputTokens": 40, "outputTokens": 4}}
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
		Sessions: sessions, HasSessions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshots[0].UsageDate != "2026-04-28" || snapshots[0].Model != "claude-opus" || snapshots[0].SessionCount != 1 {
		t.Errorf("snapshot = %+v", snapshots[0])
	}
}

func TestNormalizeTreatsExplicitlyEmptySessionResultAsAuthoritative(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{
			"date": "2026-04-28",
			"modelBreakdowns": [
				{"modelName": "claude-opus", "inputTokens": 40, "outputTokens": 4, "sessionCount": 1}
			]
		}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
		Sessions: jsonInput(t, `{"data": []}`), HasSessions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshots[0].Model != "claude-opus" || snapshots[0].SessionCount != 0 {
		t.Errorf("snapshot = %+v", snapshots[0])
	}
}

func TestNormalizeDoesNotCrashOnSessionRowsWithEmptyModelBreakdowns(t *testing.T) {
	input := jsonInput(t, `{
		"data": [{"date": "2026-04-28", "model": "all", "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}]
	}`)
	sessions := jsonInput(t, `{
		"data": [{"sessionId": "s1", "lastActivity": "2026-04-28T10:00:00.000Z", "modelBreakdowns": []}]
	}`)
	snapshots, err := NormalizeCcusageDailyJSON(input, NormalizeOptions{
		Source: contract.SourceClaudeCode, Timezone: "Asia/Shanghai", CollectedAt: normalizeCollectedAt,
		Sessions: sessions, HasSessions: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshots[0].Model != "all" || snapshots[0].SessionCount != 1 {
		t.Errorf("snapshot = %+v", snapshots[0])
	}
}
