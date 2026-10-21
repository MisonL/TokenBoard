package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// shadowTSInput is one TypeScript-side preview invocation.
type shadowTSInput struct {
	// RepoDir is the TokenBoard checkout root (packages/collector lives
	// under it).
	RepoDir string
	Source  string
	Since   string
	Until   string
	// StateDir is the temporary state directory this side owns.
	StateDir string
	Stderr   io.Writer
}

// runShadowTS runs the TypeScript collector's preview and parses its
// snapshots. It is a variable so tests can answer without node.
var runShadowTS = execShadowTS

// shadowReport is the JSON document `tokenboard shadow` prints.
type shadowReport struct {
	Status    string              `json:"status"`
	Snapshots int                 `json:"snapshots,omitempty"`
	OnlyInTS  []shadowSnapshotKey `json:"onlyInTs,omitempty"`
	OnlyInGo  []shadowSnapshotKey `json:"onlyInGo,omitempty"`
	Differing []shadowDifference  `json:"differing,omitempty"`
}

// shadowSnapshotKey identifies one snapshot row, matching the key both sides
// merge on: source, usage date, timezone and model.
type shadowSnapshotKey struct {
	Source    string `json:"source"`
	UsageDate string `json:"usageDate"`
	Timezone  string `json:"timezone"`
	Model     string `json:"model"`
}

type shadowDifference struct {
	Key    shadowSnapshotKey `json:"key"`
	Fields []shadowFieldDiff `json:"fields"`
}

type shadowFieldDiff struct {
	Field string `json:"field"`
	TS    any    `json:"ts"`
	Go    any    `json:"go"`
}

// runShadow implements `tokenboard shadow`: collect the same source with this
// client and with the TypeScript collector, normalize both result sets, and
// diff them. Each side gets its own temporary state directory, so neither can
// touch the machine's real cursors; preview never uploads on either side.
func runShadow(ctx context.Context, options Options, env Env, stdout, stderr io.Writer) int {
	repoDir := strings.TrimSpace(env("TOKENBOARD_COLLECTOR_DIR"))
	if repoDir == "" {
		fmt.Fprintln(stderr,
			"shadow requires TOKENBOARD_COLLECTOR_DIR pointing at a TokenBoard checkout (packages/collector)")
		return ExitUsage
	}
	collectorDir := filepath.Join(repoDir, "packages", "collector")
	if info, err := os.Stat(filepath.Join(collectorDir, "src", "cli.ts")); err != nil || !info.Mode().IsRegular() {
		fmt.Fprintf(stderr, "shadow: %s does not look like the collector checkout (src/cli.ts is missing)\n", collectorDir)
		return ExitUsage
	}

	goStateDir, err := os.MkdirTemp("", "tokenboard-shadow-go-")
	if err != nil {
		fmt.Fprintf(stderr, "shadow: %v\n", err)
		return ExitFailure
	}
	defer os.RemoveAll(goStateDir)
	tsStateDir, err := os.MkdirTemp("", "tokenboard-shadow-ts-")
	if err != nil {
		fmt.Fprintf(stderr, "shadow: %v\n", err)
		return ExitFailure
	}
	defer os.RemoveAll(tsStateDir)

	// Shadow always compares full preview semantics: an inherited
	// TOKENBOARD_HOOK_MODE would make the Go side collect only the two
	// hook-installed sources while the TS child (whose environment strips it)
	// runs the full scan.
	options.HookMode = false

	outcome, abortErr := collectAll(ctx, options, env, goStateDir, "", stderr)
	if abortErr != nil {
		fmt.Fprintf(stderr, "shadow: Go collection failed: %v\n", abortErr)
		return ExitFailure
	}
	if collectionFailed(outcome, options) {
		fmt.Fprintf(stderr, "shadow: Go collection reported failures: %s\n", formatSourceFailures(outcome.failures))
		return ExitFailure
	}

	tsSnapshots, err := runShadowTS(ctx, shadowTSInput{
		RepoDir:  repoDir,
		Source:   options.Source,
		Since:    options.Since,
		Until:    options.Until,
		StateDir: tsStateDir,
		Stderr:   stderr,
	})
	if err != nil {
		fmt.Fprintf(stderr, "shadow: TypeScript preview failed: %v\n", err)
		return ExitFailure
	}

	report := compareShadow(outcome.snapshots, tsSnapshots)
	payload, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "shadow: %v\n", err)
		return ExitFailure
	}
	fmt.Fprintln(stdout, string(payload))
	if report.Status != "match" {
		return ExitFailure
	}
	return ExitOK
}

// compareShadow normalizes both sides to a key-ordered map and reports the
// differences. collectedAt is wall clock, not semantics, and is excluded by
// comparing the hash payloads (which already omit it).
func compareShadow(goSnapshots, tsSnapshots []contract.Snapshot) shadowReport {
	goByKey := shadowSnapshotMap(goSnapshots)
	tsByKey := shadowSnapshotMap(tsSnapshots)

	keys := make([]string, 0, len(goByKey)+len(tsByKey))
	seen := map[string]bool{}
	for key := range goByKey {
		keys = append(keys, key)
		seen[key] = true
	}
	for key := range tsByKey {
		if !seen[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	report := shadowReport{Status: "match"}
	for _, key := range keys {
		goSnapshot, inGo := goByKey[key]
		tsSnapshot, inTS := tsByKey[key]
		switch {
		case inGo && !inTS:
			report.OnlyInGo = append(report.OnlyInGo, shadowKeyOf(goSnapshot))
		case inTS && !inGo:
			report.OnlyInTS = append(report.OnlyInTS, shadowKeyOf(tsSnapshot))
		default:
			if goSnapshot.HashPayload() == tsSnapshot.HashPayload() {
				report.Snapshots++
				continue
			}
			report.Differing = append(report.Differing, shadowDifference{
				Key:    shadowKeyOf(goSnapshot),
				Fields: shadowFieldDiffs(tsSnapshot, goSnapshot),
			})
		}
	}
	if len(report.OnlyInGo) > 0 || len(report.OnlyInTS) > 0 || len(report.Differing) > 0 {
		report.Status = "diff"
	}
	return report
}

func shadowSnapshotMap(snapshots []contract.Snapshot) map[string]contract.Snapshot {
	rows := make(map[string]contract.Snapshot, len(snapshots))
	for _, snapshot := range snapshots {
		rows[shadowKeyString(snapshot)] = snapshot
	}
	return rows
}

func shadowKeyString(snapshot contract.Snapshot) string {
	return string(snapshot.Source) + "\x00" + snapshot.UsageDate + "\x00" +
		snapshot.Timezone + "\x00" + snapshot.Model
}

func shadowKeyOf(snapshot contract.Snapshot) shadowSnapshotKey {
	return shadowSnapshotKey{
		Source:    string(snapshot.Source),
		UsageDate: snapshot.UsageDate,
		Timezone:  snapshot.Timezone,
		Model:     snapshot.Model,
	}
}

// shadowFieldDiffs lists the fields two same-key snapshots disagree on. The
// fields are the ones the upload contract carries; collectedAt is excluded
// because it is wall clock.
func shadowFieldDiffs(tsSnapshot, goSnapshot contract.Snapshot) []shadowFieldDiff {
	fields := []struct {
		name string
		ts   any
		goV  any
	}{
		{"inputTokens", tsSnapshot.InputTokens, goSnapshot.InputTokens},
		{"outputTokens", tsSnapshot.OutputTokens, goSnapshot.OutputTokens},
		{"cacheCreationTokens", tsSnapshot.CacheCreation, goSnapshot.CacheCreation},
		{"cacheReadTokens", tsSnapshot.CacheRead, goSnapshot.CacheRead},
		{"totalTokens", tsSnapshot.TotalTokens, goSnapshot.TotalTokens},
		{"costUsd", tsSnapshot.CostUSD, goSnapshot.CostUSD},
		{"sessionCount", tsSnapshot.SessionCount, goSnapshot.SessionCount},
		{"correction", string(tsSnapshot.Correction), string(goSnapshot.Correction)},
	}
	diffs := make([]shadowFieldDiff, 0, len(fields))
	for _, field := range fields {
		if field.ts != field.goV {
			diffs = append(diffs, shadowFieldDiff{Field: field.name, TS: field.ts, Go: field.goV})
		}
	}
	return diffs
}

// execShadowTS runs `node --import tsx src/cli.ts preview` in the checkout
// and parses the snapshot array it prints. The child sees the process
// environment with its own state directory, and never sees hook mode: shadow
// always compares full preview semantics.
func execShadowTS(ctx context.Context, input shadowTSInput) ([]contract.Snapshot, error) {
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, fmt.Errorf("node not found on PATH: %w", err)
	}
	args := []string{"--import", "tsx", "src/cli.ts", "preview", "--source", input.Source}
	if input.Since != "" {
		args = append(args, "--since", input.Since)
	}
	if input.Until != "" {
		args = append(args, "--until", input.Until)
	}
	cmd := exec.CommandContext(ctx, node, args...)
	cmd.Dir = filepath.Join(input.RepoDir, "packages", "collector")
	cmd.Env = shadowChildEnv(input.StateDir)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if input.Stderr != nil {
		cmd.Stderr = input.Stderr
	}
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	var snapshots []contract.Snapshot
	if err := json.Unmarshal(stdout.Bytes(), &snapshots); err != nil {
		return nil, fmt.Errorf("preview output is not a snapshot array: %w", err)
	}
	return snapshots, nil
}

// shadowChildEnv is the process environment with the TypeScript side's state
// directory swapped in and hook mode removed: a shadow run is always a full
// preview, and the two sides must not share cursors.
func shadowChildEnv(stateDir string) []string {
	parent := os.Environ()
	out := make([]string, 0, len(parent)+1)
	for _, entry := range parent {
		if strings.HasPrefix(entry, "TOKENBOARD_STATE_DIR=") ||
			strings.HasPrefix(entry, "TOKENBOARD_HOOK_MODE=") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "TOKENBOARD_STATE_DIR="+stateDir)
}
