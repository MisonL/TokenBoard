package sessioncursor

import (
	"sort"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// MergeSnapshots ports mergeSnapshots from session-cursor.ts: fold snapshots
// that share a (source, date, timezone, model) key, then sort.
//
// A key collision adds rather than replaces. The distinction matters where
// callers combine freshly collected snapshots with ones carried in the cursor:
// replacing would silently drop usage the two sources both saw, while adding
// double-counts only if the same call was genuinely collected twice — which
// the cursor's own file identity check already prevents.
func MergeSnapshots(snapshots []contract.Snapshot) []contract.Snapshot {
	rows := map[string]*contract.Snapshot{}
	order := make([]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		key := snapshotKey(snapshot)
		current, ok := rows[key]
		if !ok {
			copied := snapshot
			rows[key] = &copied
			order = append(order, key)
			continue
		}
		current.InputTokens += snapshot.InputTokens
		current.OutputTokens += snapshot.OutputTokens
		current.CacheCreation += snapshot.CacheCreation
		current.CacheRead += snapshot.CacheRead
		current.TotalTokens += snapshot.TotalTokens
		current.CostUSD += snapshot.CostUSD
		current.SessionCount += snapshot.SessionCount
	}
	merged := make([]contract.Snapshot, 0, len(order))
	for _, key := range order {
		merged = append(merged, *rows[key])
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].UsageDate != merged[j].UsageDate {
			return collate.Less(merged[i].UsageDate, merged[j].UsageDate)
		}
		return collate.Less(merged[i].Model, merged[j].Model)
	})
	return merged
}

func snapshotKey(snapshot contract.Snapshot) string {
	return string(snapshot.Source) + "\x00" + snapshot.UsageDate + "\x00" +
		snapshot.Timezone + "\x00" + snapshot.Model
}
