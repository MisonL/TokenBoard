// Package cli wires the tokenboard subcommands: argument/env parsing, the
// preview/sync/warm-hooks dispatch, and the exit-code contract
// (0 ok, 1 failure, 2 usage, 75 transient retry) the skill scripts mirror.
package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
	"github.com/MisonL/TokenBoard/clients/go/internal/upload"
)

// Exit codes shared with the TS collector. 75 is the scheduler retry
// contract: a transient failure the launchd/systemd/schtasks wrapper may
// re-run.
const (
	ExitOK        = 0
	ExitFailure   = 1
	ExitUsage     = 2
	ExitTransient = collect.TransientSyncExitCode
)

// Env abstracts the process environment so tests can drive it.
type Env func(string) string

// Options is the parsed invocation.
type Options struct {
	Command         string
	Source          string
	Timezone        string
	Endpoint        string
	UploadToken     string
	Since           string
	Until           string
	HookMode        bool
	FailOnSourceErr bool
}

// Run executes one CLI invocation and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	return RunWithEnv(context.Background(), args, os.Getenv, stdout, stderr)
}

// RunWithEnv is Run with an injectable environment, for tests.
func RunWithEnv(ctx context.Context, args []string, env Env, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usageLine())
		return ExitUsage
	}
	switch args[0] {
	case "version":
		fmt.Fprintln(stdout, versionString())
		return ExitOK
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, usageLine())
		return ExitOK
	}

	options, err := parseArgs(args, env)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitUsage
	}
	return dispatch(ctx, options, env, stdout, stderr)
}

func dispatch(ctx context.Context, options Options, env Env, stdout, stderr io.Writer) int {
	home, _ := os.UserHomeDir()
	stateDir := state.ResolveDir(env, home)

	switch options.Command {
	case "warm-hooks":
		// No provider registers a hook cursor yet; report the sources that
		// would be warmed, like the TS collector reports its plan.
		sources := expandWarmHookSources(options.Source)
		payload, _ := json.MarshalIndent(map[string]any{"warmed": sources}, "", "  ")
		fmt.Fprintln(stdout, string(payload))
		return ExitOK
	case "preview":
		snapshots, failures := collectAll(ctx, options, env)
		if snapshots == nil {
			snapshots = []contract.Snapshot{}
		}
		payload, _ := json.MarshalIndent(snapshots, "", "  ")
		fmt.Fprintln(stdout, string(payload))
		if len(failures) > 0 {
			fmt.Fprintf(stderr, "One or more sources failed: %s\n", strings.Join(failures, "; "))
			return ExitFailure
		}
		return ExitOK
	case "sync":
		return runSync(ctx, options, env, stateDir, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", options.Command)
		return ExitUsage
	}
}

func runSync(ctx context.Context, options Options, env Env, stateDir string, stdout, stderr io.Writer) int {
	missing := requiredSyncConfig(options)
	if len(missing) > 0 {
		fmt.Fprintf(stderr, "Missing required config for sync: %s\n", strings.Join(missing, ", "))
		return ExitFailure
	}

	lock, err := state.Acquire(filepath.Join(stateDir, "collector-run.lock"), 35*time.Second)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitFailure
	}
	if lock == nil {
		fmt.Fprintln(stderr, "TokenBoard collector lock timed out")
		return ExitFailure
	}
	defer func() { _ = lock.Release() }()

	snapshots, failures := collectAll(ctx, options, env)
	collectionFailed := len(failures) > 0 && (options.FailOnSourceErr || options.Source != "all")

	if pausedUntil, paused := upload.IsPaused(stateDir, time.Now()); paused {
		fmt.Fprintf(stderr,
			"TokenBoard upload paused until %s after repeated non-transient failures; collected snapshots remain queued in the cursor\n",
			pausedUntil)
		if collectionFailed {
			return ExitFailure
		}
		return ExitOK
	}

	config := upload.Config{Endpoint: options.Endpoint, UploadToken: options.UploadToken}
	result, uploadErr := upload.UploadSnapshots(ctx, config, snapshots, nil)
	if uploadErr == nil {
		upload.RecordSuccess(stateDir)
	} else {
		if !collect.IsTransientNetworkError(uploadErr) {
			recorded := upload.RecordFailure(stateDir, uploadErr, time.Now())
			suffix := ""
			if recorded.PausedUntil != "" {
				suffix = fmt.Sprintf("; pausing uploads until %s", recorded.PausedUntil)
			}
			fmt.Fprintf(stderr, "TokenBoard upload failed (%d consecutive non-transient failures%s)\n",
				recorded.ConsecutiveFailures, suffix)
		}
		// The TS collector prints the failure itself before classifying it;
		// keep that so the scheduled runner's log names the cause.
		fmt.Fprintln(stderr, uploadErr.Error())
		return classifyFailure(uploadErr, options, env)
	}

	payload, _ := json.MarshalIndent(map[string]any{"upserted": result.Upserted, "skipped": result.Skipped}, "", "  ")
	fmt.Fprintln(stdout, string(payload))
	if collectionFailed {
		fmt.Fprintf(stderr, "One or more sources failed: %s\n", strings.Join(failures, "; "))
		return ExitFailure
	}
	return ExitOK
}

// classifyFailure applies the exit-code contract: only a non-hook sync run
// can be deferred (75); preview and warm-hooks report a plain failure, and
// hook syncs are never retried by the scheduler.
func classifyFailure(cause error, options Options, env Env) int {
	if options.Command == "sync" && !options.HookMode && collect.IsTransientNetworkError(cause) {
		return ExitTransient
	}
	return ExitFailure
}

// collectAll gathers snapshots from the registered providers. No provider is
// registered yet, so every source reports as unavailable — the same outcome
// as a source whose tool is not installed on this machine.
func collectAll(ctx context.Context, options Options, env Env) ([]contract.Snapshot, []string) {
	sources := expandSources(options.Source, options.HookMode)
	_ = ctx
	var snapshots []contract.Snapshot
	var failures []string
	for _, source := range sources {
		provider, ok := collect.Lookup(source)
		if !ok {
			continue // unavailable, not a failure
		}
		collected, err := provider.Collect(ctx, collect.Options{
			Timezone: options.Timezone,
			Since:    options.Since,
			Until:    options.Until,
		})
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", source, err))
			continue
		}
		snapshots = append(snapshots, collected...)
	}
	return snapshots, failures
}

func expandSources(source string, hookMode bool) []contract.Source {
	if source != "all" {
		return []contract.Source{contract.Source(source)}
	}
	if hookMode {
		// Hook mode reads only the two hook-installed sources; the others
		// have no hook cursor and must not be scanned.
		return []contract.Source{contract.SourceClaudeCode, contract.SourceCodex}
	}
	return contract.AllSources()
}

func expandWarmHookSources(source string) []string {
	if source == "all" {
		return []string{string(contract.SourceClaudeCode), string(contract.SourceCodex)}
	}
	if source == string(contract.SourceClaudeCode) || source == string(contract.SourceCodex) {
		return []string{source}
	}
	return nil
}

func requiredSyncConfig(options Options) []string {
	var missing []string
	if options.Endpoint == "" {
		missing = append(missing, "TOKENBOARD_ENDPOINT")
	}
	if options.UploadToken == "" {
		missing = append(missing, "TOKENBOARD_UPLOAD_TOKEN")
	}
	return missing
}

func parseArgs(args []string, env Env) (Options, error) {
	command := args[0]
	switch command {
	case "preview", "sync", "warm-hooks":
	default:
		return Options{}, fmt.Errorf("Usage: tokenboard <preview|sync|warm-hooks> [--source %s]",
			strings.Join(sourceChoices(), "|"))
	}
	flags, err := readFlags(args[1:])
	if err != nil {
		return Options{}, err
	}
	source := firstNonEmpty(flags["source"], env("TOKENBOARD_SOURCE"), "all")
	if !isValidSource(source) {
		return Options{}, fmt.Errorf("Invalid source: %s", source)
	}
	timezone := firstNonEmpty(flags["timezone"], env("TOKENBOARD_TIMEZONE"), localTimezone())
	if err := assertValidTimezone(timezone); err != nil {
		return Options{}, err
	}
	options := Options{
		Command:         command,
		Source:          source,
		Timezone:        strings.TrimSpace(timezone),
		Endpoint:        firstNonEmpty(flags["endpoint"], env("TOKENBOARD_ENDPOINT")),
		UploadToken:     firstNonEmpty(flags["token"], env("TOKENBOARD_UPLOAD_TOKEN")),
		Since:           firstNonEmpty(flags["since"], env("TOKENBOARD_SINCE"), env("TOKENBOARD_DEFAULT_SINCE")),
		HookMode:        env("TOKENBOARD_HOOK_MODE") == "1",
		FailOnSourceErr: env("TOKENBOARD_FAIL_ON_SOURCE_ERROR") == "1",
	}
	options.Until = flags["until"]
	if options.Until == "" && supportsUntil(options) {
		options.Until = env("TOKENBOARD_UNTIL")
	}
	if err := assertSupportedUntil(options); err != nil {
		return Options{}, err
	}
	return options, nil
}

func assertSupportedUntil(options Options) error {
	if options.Until == "" {
		return nil
	}
	if options.Command == "warm-hooks" {
		return fmt.Errorf("--until is not supported for warm-hooks; the command does not collect usage")
	}
	if options.HookMode {
		return fmt.Errorf("--until is not supported in hook mode; hook sync computes its own incremental window")
	}
	if !supportsUntil(options) {
		return fmt.Errorf("--until is only supported for Claude Code and Codex sources")
	}
	return nil
}

func supportsUntil(options Options) bool {
	return options.Command != "warm-hooks" && !options.HookMode &&
		(options.Source == string(contract.SourceClaudeCode) || options.Source == string(contract.SourceCodex))
}

// readFlags accepts `--key value`, `--key=value` and `--key` (bare boolean,
// ignored here since the CLI has no boolean flags that need a value).
func readFlags(args []string) (map[string]string, error) {
	flags := map[string]string{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			return nil, fmt.Errorf("unexpected argument: %s", arg)
		}
		body := strings.TrimPrefix(arg, "--")
		if key, value, found := strings.Cut(body, "="); found {
			flags[key] = value
			continue
		}
		if index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
			flags[body] = args[index+1]
			index++
			continue
		}
		flags[body] = ""
	}
	return flags, nil
}

func isValidSource(source string) bool {
	return source == "all" || contract.IsValidSource(source)
}

func sourceChoices() []string {
	choices := []string{}
	for _, source := range contract.AllSources() {
		choices = append(choices, string(source))
	}
	return append(choices, "all")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func localTimezone() string {
	if name := os.Getenv("TZ"); name != "" {
		return name
	}
	return "UTC"
}

// assertValidTimezone mirrors timezone.ts: trim, require non-empty, and
// require that the runtime can resolve it.
func assertValidTimezone(value string) error {
	timezone := strings.TrimSpace(value)
	if timezone == "" {
		return fmt.Errorf("Invalid timezone")
	}
	if !contract.IsValidTimezone(timezone) {
		return fmt.Errorf(
			"Invalid timezone: %s. If the zone is spelled correctly, this build may lack timezone data; set TOKENBOARD_TIMEZONE explicitly",
			timezone)
	}
	return nil
}

func usageLine() string {
	return fmt.Sprintf("Usage: tokenboard <preview|sync|warm-hooks> [--source %s]", strings.Join(sourceChoices(), "|"))
}

func versionString() string {
	return "tokenboard (go) " + Version
}

// Version is stamped at build time via -ldflags; "dev" otherwise.
var Version = "dev"
