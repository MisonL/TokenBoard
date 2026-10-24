package cli

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/codex"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of warmHookCursors: after a full scan, advance the hook cursors'
// high-water mark so the next hook run does not rescan the whole session
// tree. A bounded or hook-mode run never warms — the high-water mark claims
// "everything up to here was covered", which is only true for a full scan.
func warmHookCursors(
	sources []string,
	stateDir string,
	startedAt time.Time,
	options Options,
	env Env,
	since, until string,
	stderr io.Writer,
) error {
	if options.HookMode {
		return nil
	}
	if !isAllDateFilter(since) || until != "" {
		return nil
	}
	for _, source := range sources {
		switch contract.Source(source) {
		case contract.SourceClaudeCode:
			if err := sessioncursor.WarmHookCursorHighWater(sessioncursor.WarmInput{
				StateDir:    stateDir,
				Source:      contract.SourceClaudeCode,
				HighWaterMs: float64(startedAt.UnixMilli()),
			}); err != nil {
				return fmt.Errorf("%s hook cursor warm failed: %w", source, err)
			}
		case contract.SourceCodex:
			// Codex warms one cursor per configured profile scope. The plan
			// decides whether that is the legacy cursor or a hashed profile
			// cursor, and it must be the same plan the hook runs use, or the
			// warm would advance a cursor nothing reads.
			if err := warmCodexHookCursors(stateDir, startedAt, env); err != nil {
				return fmt.Errorf("%s hook cursor warm failed: %w", source, err)
			}
		}
	}
	return nil
}

// warmCodexHookCursors ports the Codex branch of warmHookCursors: resolve the
// homes, resolve the cursor plan for this state directory, and advance each
// home's cursor.
func warmCodexHookCursors(stateDir string, startedAt time.Time, env Env) error {
	homes, err := codex.ResolveHomes(codex.ResolveHomesInput{
		JSONValue:   env("TOKENBOARD_CODEX_HOMES_JSON"),
		LegacyValue: env("CODEX_HOME"),
	})
	if err != nil {
		return err
	}
	plan, err := codex.ResolveHookCursorPlan(homes, stateDir)
	if err != nil {
		return err
	}
	for index := range homes {
		if err := sessioncursor.WarmHookCursorHighWater(sessioncursor.WarmInput{
			StateDir:    stateDir,
			Source:      contract.SourceCodex,
			CursorScope: plan.CursorScopes[index],
			HighWaterMs: float64(startedAt.UnixMilli()),
		}); err != nil {
			return err
		}
	}
	return nil
}

// isAllDateFilter ports iso-calendar-date.ts isAllDateFilter.
func isAllDateFilter(value string) bool {
	return strings.TrimSpace(value) == "all"
}

func sourceNames(sources []contract.Source) []string {
	names := make([]string, 0, len(sources))
	for _, source := range sources {
		names = append(names, string(source))
	}
	return names
}
