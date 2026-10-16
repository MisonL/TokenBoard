// Package cli wires the tokenboard subcommands: argument/env parsing, the
// preview/sync/warm-hooks dispatch, and the exit-code contract
// (0 ok, 1 failure, 2 usage, 75 transient retry) the skill scripts mirror.
package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
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
	home, err := os.UserHomeDir()
	if err != nil {
		// A missing home directory would silently turn the state dir into a
		// relative path — locks and cursors would land in the working
		// directory instead. Refuse instead.
		fmt.Fprintf(stderr, "Cannot resolve the home directory: %v\n", err)
		return ExitFailure
	}
	stateDir := state.ResolveDir(env, home)

	switch options.Command {
	case "warm-hooks":
		return withRunLock(stateDir, stderr, func() int {
			// No provider registers a hook cursor yet; report the sources the
			// TS collector would report as warmed — every concrete source,
			// not just the hook-installed two.
			sources := expandWarmHookSources(options.Source)
			payload, _ := json.MarshalIndent(map[string]any{"warmed": sources}, "", "  ")
			fmt.Fprintln(stdout, string(payload))
			return ExitOK
		})
	case "preview":
		return withRunLock(stateDir, stderr, func() int {
			snapshots, failures := collectAll(ctx, options, env, "")
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
		})
	case "sync":
		return runSync(ctx, options, env, stateDir, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", options.Command)
		return ExitUsage
	}
}

// withRunLock serializes the command on collector-run.lock. The TS CLI takes
// this lock for all three commands, not just sync, so a preview cannot race
// a running sync's cursor writes.
func withRunLock(stateDir string, stderr io.Writer, body func() int) int {
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
	return body()
}

func runSync(ctx context.Context, options Options, env Env, stateDir string, stdout, stderr io.Writer) int {
	missing := requiredSyncConfig(options)
	if len(missing) > 0 {
		fmt.Fprintf(stderr, "Missing required config for sync: %s\n", strings.Join(missing, ", "))
		return ExitFailure
	}
	return withRunLock(stateDir, stderr, func() int {
		return syncLocked(ctx, options, env, stateDir, stdout, stderr)
	})
}

func syncLocked(ctx context.Context, options Options, env Env, stateDir string, stdout, stderr io.Writer) int {
	cursorScope, err := cursorScopeFromEndpoint(options.Endpoint)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitFailure
	}
	snapshots, failures := collectAll(ctx, options, env, cursorScope)
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
		// keep that so the scheduled runner's log names the cause. URLs are
		// reduced to their origin: the scheduled log is long-lived and a
		// transport error's full URL may carry query parameters.
		fmt.Fprintln(stderr, upload.RedactURLs(uploadErr.Error()))
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
// as a source whose tool is not installed on this machine. The cursor scope
// is the endpoint origin for sync (empty for preview), mirroring the TS
// collection context.
func collectAll(ctx context.Context, options Options, env Env, cursorScope string) ([]contract.Snapshot, []string) {
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
			Timezone:    options.Timezone,
			Since:       options.Since,
			Until:       options.Until,
			CursorScope: cursorScope,
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

// expandWarmHookSources mirrors the TS expandSources for warm-hooks: every
// concrete source is reported as warmed, including the non-hook sources
// whose warm step is currently a no-op. Only "all" narrows to the two
// hook-installed sources.
func expandWarmHookSources(source string) []string {
	if source == "all" {
		return []string{string(contract.SourceClaudeCode), string(contract.SourceCodex)}
	}
	return []string{source}
}

// cursorScopeFromEndpoint mirrors the TS cursorScopeFromEndpoint: the
// endpoint URL's origin — lowercased host, default port dropped, IPv6 hosts
// kept in brackets, port normalized — or empty when there is no endpoint. An
// endpoint that does not parse is a failure; the TS new URL() throws and
// aborts the run the same way. (The TS side would continue with the literal
// origin "null" for scheme-less or file:// endpoints; refusing is the
// fail-closed equivalent.)
func cursorScopeFromEndpoint(endpoint string) (string, error) {
	if endpoint == "" {
		return "", nil
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("Invalid endpoint URL: %s", endpoint)
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // url.Hostname strips IPv6 brackets
	}
	if port := parsed.Port(); port != "" && !isDefaultPort(parsed.Scheme, port) {
		host = host + ":" + port
	}
	return parsed.Scheme + "://" + host, nil
}

// isDefaultPort normalizes before comparing so a leading-zero port
// ("https://h:0443") is recognized as default and dropped, the way the TS
// URL parser canonicalizes it.
func isDefaultPort(scheme, port string) bool {
	normalized, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	return (scheme == "https" && normalized == 443) || (scheme == "http" && normalized == 80)
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

// readFlags mirrors the TS readFlags: non-flag arguments are silently
// ignored, every flag must be followed by a value, and a flag at the end of
// the line or right before another flag is a usage error ("Missing value
// for --key") — a bare flag must never fall back to the environment default.
// `--key=value` is a deliberate Go extension the TS parser does not accept.
func readFlags(args []string) (map[string]string, error) {
	flags := map[string]string{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		body := strings.TrimPrefix(arg, "--")
		if key, value, found := strings.Cut(body, "="); found {
			flags[key] = value
			continue
		}
		if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
			return nil, fmt.Errorf("Missing value for --%s", body)
		}
		flags[body] = args[index+1]
		index++
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

// localTimezone mirrors the TS default: the machine's IANA zone (TS reads it
// from Intl, which honors TZ or the system zone). time.Local resolves TZ or
// /etc/localtime the same way but reports the literal "Local" when the zone
// has no name, so the conventional system locations are consulted directly
// before giving up — a silent UTC fallback would shift usageDate and fork the
// server's dedup key against a TS collector on the same machine.
func localTimezone() string {
	if name := strings.TrimSpace(os.Getenv("TZ")); name != "" {
		return name // validated by assertValidTimezone, like the TS path
	}
	if name := time.Local.String(); name != "" && name != "Local" && contract.IsValidTimezone(name) {
		return name
	}
	if name := systemTimezoneName(); name != "" {
		return name
	}
	return "UTC"
}

// systemTimezoneName reads the host zone name from the conventional
// locations: /etc/timezone (Debian and derivatives) and the /etc/localtime
// symlink into a zoneinfo tree (macOS, most Linux). Windows has neither, so
// it falls through to the caller's UTC fallback.
func systemTimezoneName() string {
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		if name := strings.TrimSpace(string(data)); contract.IsValidTimezone(name) {
			return name
		}
	}
	target, err := os.Readlink("/etc/localtime")
	if err != nil {
		return ""
	}
	if index := strings.LastIndex(target, "zoneinfo/"); index >= 0 {
		if name := target[index+len("zoneinfo/"):]; contract.IsValidTimezone(name) {
			return name
		}
	}
	return ""
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
			"Invalid timezone: %s. If the zone is spelled correctly, the runtime may lack ICU timezone data; set TOKENBOARD_TIMEZONE explicitly or use a full-icu runtime",
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
