// Command tb-shadow-antigravity runs the Antigravity history reader over a
// fixture conversations directory and writes its events as JSON, for the
// TypeScript-vs-Go shadow diff. TB_MAX_DB bounds the per-run database budget;
// TB_STATE_IN/TB_STATE_OUT carry the cursor state so the incremental path can
// be compared against the TS harness's own state files.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
)

type event struct {
	CascadeHash         string   `json:"cascadeHash"`
	CascadeHashAliases  []string `json:"cascadeHashAliases"`
	EventHash           string   `json:"eventHash"`
	CreatedAt           string   `json:"createdAt"`
	Model               string   `json:"model"`
	ModelAliases        []string `json:"modelAliases"`
	InputTokens         int64    `json:"inputTokens"`
	OutputTokens        int64    `json:"outputTokens"`
	CacheCreationTokens int64    `json:"cacheCreationTokens"`
	CacheReadTokens     int64    `json:"cacheReadTokens"`
}

type summary struct {
	Events                    []event          `json:"events"`
	LastReadRowIndexByCascade map[string]int64 `json:"lastReadRowIndexByCascade"`
	KnownCascadeIDs           []string         `json:"knownCascadeIds"`
	CompleteDirectoryScan     bool             `json:"completeDirectoryScan"`
}

type carriedState struct {
	LastSeenRowIndexByCascadeHash [][2]any `json:"lastSeenRowIndexByCascadeHash"`
	ScanState                     any      `json:"scanState"`
}

func hashOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: tb-shadow-antigravity <conversationsDir> <outFile>")
		os.Exit(2)
	}
	dir, outFile := os.Args[1], os.Args[2]
	scanState := antigravityscan.NewFileScanState()
	options := antigravityhistory.Options{ConversationDir: dir, ScanState: &scanState}
	if raw := os.Getenv("TB_MAX_DB"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			fmt.Fprintln(os.Stderr, "bad TB_MAX_DB:", err)
			os.Exit(2)
		}
		options.MaxDbFiles = &value
	} else {
		options.UnboundedDbFiles = true
		options.RequireCompleteDirectoryScan = true
	}
	if stateIn := os.Getenv("TB_STATE_IN"); stateIn != "" {
		raw, err := os.ReadFile(stateIn)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		var carried carriedState
		if err := json.Unmarshal(raw, &carried); err != nil {
			fmt.Fprintln(os.Stderr, "state:", err)
			os.Exit(1)
		}
		lastSeen := map[string]int64{}
		for _, pair := range carried.LastSeenRowIndexByCascadeHash {
			id, _ := pair[0].(string)
			row, _ := pair[1].(float64)
			lastSeen[id] = int64(row)
		}
		options.LastSeenRowIndexByCascadeHash = lastSeen
		options.DetectRowCursorReset = len(lastSeen) > 0
		encoded, err := json.Marshal(carried.ScanState)
		if err != nil {
			fmt.Fprintln(os.Stderr, "state:", err)
			os.Exit(1)
		}
		var restored antigravityscan.FileScanState
		if err := json.Unmarshal(encoded, &restored); err != nil {
			fmt.Fprintln(os.Stderr, "state:", err)
			os.Exit(1)
		}
		if restored.Files == nil {
			restored = antigravityscan.NewFileScanState()
		}
		scanState = restored
		options.ScanState = &scanState
	}

	result, err := antigravityhistory.ReadUsageEvents(options)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	events := make([]event, 0, len(result.Events))
	for _, item := range result.Events {
		events = append(events, event{
			CascadeHash:         item.CascadeHash,
			CascadeHashAliases:  emptyIfNil(item.CascadeHashAliases),
			EventHash:           item.EventHash,
			CreatedAt:           item.CreatedAt,
			Model:               item.Model,
			ModelAliases:        emptyIfNil(item.ModelAliases),
			InputTokens:         item.InputTokens,
			OutputTokens:        item.OutputTokens,
			CacheCreationTokens: item.CacheCreationTokens,
			CacheReadTokens:     item.CacheReadTokens,
		})
	}
	known := make([]string, 0, len(result.KnownCascadeIDs))
	for id := range result.KnownCascadeIDs {
		known = append(known, id)
	}
	sort.Strings(known)
	if err := writeJSON(outFile, summary{
		Events:                    events,
		LastReadRowIndexByCascade: result.LastReadRowIndexByCascade,
		KnownCascadeIDs:           known,
		CompleteDirectoryScan:     result.CompleteDirectoryScan,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	if stateOut := os.Getenv("TB_STATE_OUT"); stateOut != "" {
		pairs := make([][2]any, 0, len(result.LastReadRowIndexByCascade))
		for id, row := range result.LastReadRowIndexByCascade {
			pairs = append(pairs, [2]any{hashOf(id), row})
		}
		sort.Slice(pairs, func(i, j int) bool {
			return pairs[i][0].(string) < pairs[j][0].(string)
		})
		if err := writeJSON(stateOut, carriedState{
			LastSeenRowIndexByCascadeHash: pairs,
			ScanState:                     scanState,
		}); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	}
	fmt.Printf("wrote %d events\n", len(events))
}

// emptyIfNil keeps the harness JSON shaped like the TS summary, which always
// prints an array for the alias lists.
func emptyIfNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func writeJSON(path string, payload any) error {
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0o644)
}
