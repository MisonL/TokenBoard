package codex

import (
	"errors"
	"math"
	"sort"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of codex-cost-projection.ts. ccusage reports the Codex daily cost as a
// date-level total, not a per-model cost; the projection spreads it across the
// day's models by token share, in fixed-point integer units so the shares sum
// back to the day total exactly.
//
// The allocation runs only after the frozen collection batches are merged:
// projecting each batch separately would round twice and change the hashes of
// historical snapshots when a `--since` window moves a model into another
// batch.

const costUsdScale = 1_000_000

// ProjectCodexDailyCosts ports projectCodexDailyCosts. Snapshots from other
// sources pass through untouched.
func ProjectCodexDailyCosts(snapshots []contract.Snapshot) ([]contract.Snapshot, error) {
	entriesByDate := map[string][]int{}
	order := []string{}
	for index, snapshot := range snapshots {
		if snapshot.Source != contract.SourceCodex {
			continue
		}
		key := string(snapshot.Source) + "\x00" + snapshot.UsageDate + "\x00" + snapshot.Timezone
		if _, seen := entriesByDate[key]; !seen {
			order = append(order, key)
		}
		entriesByDate[key] = append(entriesByDate[key], index)
	}
	projected := map[int]contract.Snapshot{}
	for _, key := range order {
		entries := entriesByDate[key]
		shares, err := projectDailyCostEntries(snapshots, entries)
		if err != nil {
			return nil, err
		}
		for index, snapshot := range shares {
			projected[index] = snapshot
		}
	}
	out := make([]contract.Snapshot, len(snapshots))
	copy(out, snapshots)
	for index, snapshot := range projected {
		out[index] = snapshot
	}
	return out, nil
}

type costShare struct {
	index     int
	units     int64
	remainder int64
}

func projectDailyCostEntries(snapshots []contract.Snapshot, entries []int) (map[int]contract.Snapshot, error) {
	projected := map[int]contract.Snapshot{}
	weighted := make([]int, 0, len(entries))
	for _, index := range entries {
		units, err := costUnits(snapshots[index].CostUSD)
		if err != nil {
			return nil, err
		}
		snapshot := snapshots[index]
		snapshot.CostUSD = costFromUnits(units)
		projected[index] = snapshot
		if snapshot.TotalTokens > 0 {
			weighted = append(weighted, index)
		}
	}
	if len(weighted) == 0 {
		return projected, nil
	}

	totalTokens := int64(0)
	for _, index := range weighted {
		totalTokens += snapshots[index].TotalTokens
		if totalTokens > maxSafeInteger {
			return nil, errors.New("Codex daily token total cannot be projected safely")
		}
	}
	if totalTokens <= 0 {
		return nil, errors.New("Codex daily token total cannot be projected safely")
	}
	totalCostUsd := 0.0
	for _, index := range weighted {
		totalCostUsd += snapshots[index].CostUSD
	}
	totalCostUnits, err := costUnits(totalCostUsd)
	if err != nil {
		return nil, err
	}

	allocatedUnits := int64(0)
	shares := make([]costShare, 0, len(weighted))
	for _, index := range weighted {
		numerator := totalCostUnits * snapshots[index].TotalTokens
		units := numerator / totalTokens
		allocatedUnits += units
		shares = append(shares, costShare{
			index:     index,
			units:     units,
			remainder: numerator % totalTokens,
		})
	}
	remainderUnits := totalCostUnits - allocatedUnits
	if remainderUnits < 0 || remainderUnits >= int64(len(shares)) {
		return nil, errors.New("Codex daily cost projection produced an invalid remainder")
	}

	// Largest remainders first, ties by model name then original order, so the
	// same day always allocates the same way whichever batch it came from.
	ordered := make([]costShare, len(shares))
	copy(ordered, shares)
	sort.SliceStable(ordered, func(left, right int) bool {
		return compareCostShares(ordered[left], ordered[right], snapshots) < 0
	})
	for index := int64(0); index < remainderUnits; index++ {
		ordered[index].units++
	}
	adjusted := map[int]int64{}
	for _, share := range ordered {
		adjusted[share.index] = share.units
	}
	for _, share := range shares {
		snapshot := snapshots[share.index]
		snapshot.CostUSD = costFromUnits(adjusted[share.index])
		projected[share.index] = snapshot
	}
	return projected, nil
}

func compareCostShares(left, right costShare, snapshots []contract.Snapshot) int {
	if left.remainder != right.remainder {
		if left.remainder > right.remainder {
			return -1
		}
		return 1
	}
	leftModel := snapshots[left.index].Model
	rightModel := snapshots[right.index].Model
	if leftModel != rightModel {
		if leftModel < rightModel {
			return -1
		}
		return 1
	}
	return left.index - right.index
}

const maxSafeInteger = 1<<53 - 1

// costUnits converts a USD amount to millionths. A negative or non-finite
// amount cannot be projected and fails closed.
func costUnits(costUsd float64) (int64, error) {
	units := math.Round(costUsd * costUsdScale)
	if math.IsNaN(units) || math.IsInf(units, 0) || units < 0 || units > maxSafeInteger {
		return 0, errors.New("Codex daily cost cannot be projected at fixed precision")
	}
	return int64(units), nil
}

func costFromUnits(units int64) float64 {
	return float64(units) / costUsdScale
}
