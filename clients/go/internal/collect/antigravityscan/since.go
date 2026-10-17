// Package antigravityscan ports antigravity-since.ts and
// antigravity-file-scan.ts: the two pieces of Antigravity collection that
// carry no I/O. All three Antigravity sources share them, so they live here
// rather than inside any one provider.
package antigravityscan

import (
	"errors"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
)

// CollectionRange is a resolved Antigravity collection window: whether the run
// scans all history, the scope string that keys the bounded cursor state, and
// the two predicates that decide whether a record or a file belongs to it.
type CollectionRange struct {
	FullHistory bool
	// HistoryScope keys the bounded cursor state, so a run under a different
	// window or timezone never reuses another run's high-water marks.
	HistoryScope string
	// SinceDate is the resolved local date, empty for a full-history run. An
	// empty value alone does not mean "all history" — a run with no explicit
	// window is bounded, and FullHistory distinguishes the two.
	SinceDate string
	// IncludesTimestamp reports whether a record created at value belongs.
	IncludesTimestamp func(value time.Time) bool
	// IncludesFileMtime reports whether a file with this mtime belongs. A zero
	// mtime is always included: the age is unknown, and excluding it would
	// silently drop usage.
	IncludesFileMtime func(mtimeMs float64) bool
}

// ResolveCollectionRange mirrors resolveAntigravityCollectionRange.
//
// since is a pointer because the TS option is `since?: string` and the two
// "absent" spellings differ: an omitted value falls back to the environment,
// while an explicitly empty one does not. Collapsing them would let a caller
// that deliberately passed "" pick up TOKENBOARD_DEFAULT_SINCE behind its back.
func ResolveCollectionRange(since *string, timezone string, env func(string) string) (CollectionRange, error) {
	var value string
	if since != nil {
		value = *since
	} else {
		value = firstNonEmpty(lookupEnv(env, "TOKENBOARD_SINCE"), lookupEnv(env, "TOKENBOARD_DEFAULT_SINCE"))
	}
	if value == "" {
		return CollectionRange{
			HistoryScope:      "all",
			IncludesTimestamp: alwaysIncludeTime,
			IncludesFileMtime: alwaysIncludeMtime,
		}, nil
	}
	if strings.TrimSpace(value) == "all" {
		return CollectionRange{
			FullHistory:       true,
			HistoryScope:      "all",
			IncludesTimestamp: alwaysIncludeTime,
			IncludesFileMtime: alwaysIncludeMtime,
		}, nil
	}

	sinceDate, err := parseCompactDate(value)
	if err != nil {
		return CollectionRange{}, err
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return CollectionRange{}, err
	}
	includesDate := func(at time.Time) bool {
		return at.In(location).Format("2006-01-02") >= sinceDate
	}
	return CollectionRange{
		HistoryScope:      boundedHistoryScope(sinceDate, timezone),
		SinceDate:         sinceDate,
		IncludesTimestamp: includesDate,
		IncludesFileMtime: func(mtimeMs float64) bool {
			return mtimeMs == 0 || includesDate(time.UnixMilli(int64(mtimeMs)))
		},
	}, nil
}

func alwaysIncludeTime(time.Time) bool { return true }
func alwaysIncludeMtime(float64) bool  { return true }

// IsReusableHistoryScope reports whether bounded cursor state written under
// previous may be reused for current: same timezone, and the new window starts
// no later than the old one.
//
// Reuse needs the new window to be a subset of the old one, which reads as
// previous.sinceDate <= current.sinceDate: a cursor built from a wider window
// already covers every record the narrower window would ask for. Widening the
// window (an earlier since) invalidates it, and so does a timezone change,
// because the same record would then land on a different local date.
func IsReusableHistoryScope(previous, current string) bool {
	if previous == current {
		return true
	}
	previousScope, ok := parseBoundedHistoryScope(previous)
	if !ok {
		return false
	}
	currentScope, ok := parseBoundedHistoryScope(current)
	if !ok {
		return false
	}
	return previousScope.timezone == currentScope.timezone && previousScope.sinceDate <= currentScope.sinceDate
}

func boundedHistoryScope(sinceDate, timezone string) string {
	return sinceDate + "@" + url.QueryEscape(timezone)
}

var boundedScopePattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})@(.+)$`)

func parseBoundedHistoryScope(value string) (boundedScope, bool) {
	match := boundedScopePattern.FindStringSubmatch(value)
	if match == nil {
		return boundedScope{}, false
	}
	timezone, err := url.QueryUnescape(match[2])
	if err != nil {
		return boundedScope{}, false
	}
	return boundedScope{sinceDate: match[1], timezone: timezone}, true
}

type boundedScope struct {
	sinceDate string
	timezone  string
}

var (
	compactDatePattern = regexp.MustCompile(`^\d{8}$`)
	dashedDatePattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// parseCompactDate validates and normalizes YYYYMMDD or YYYY-MM-DD. An
// impossible calendar date is rejected rather than rolled over: a since of
// 20260230 must be an error, not silently become March 2.
func parseCompactDate(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	invalid := func() error {
		return errors.New("Invalid Antigravity since date: " + value + ". Expected YYYYMMDD or YYYY-MM-DD.")
	}
	if !compactDatePattern.MatchString(trimmed) && !dashedDatePattern.MatchString(trimmed) {
		return "", invalid()
	}
	compact := strings.ReplaceAll(trimmed, "-", "")
	iso := compact[:4] + "-" + compact[4:6] + "-" + compact[6:8]
	parsed, err := time.ParseInLocation("2006-01-02", iso, time.UTC)
	if err != nil || parsed.Format("20060102") != compact {
		return "", invalid()
	}
	return iso, nil
}

// FormatDate resolves a local date exactly the way the session aggregate does.
func FormatDate(at time.Time, timezone string) string {
	return sessionusage.FormatDate(at, timezone)
}

func lookupEnv(env func(string) string, key string) string {
	if env == nil {
		// The TS side reads the process env when no override is threaded; an
		// absent fallback would silently drop TOKENBOARD_SINCE instead.
		return os.Getenv(key)
	}
	return env(key)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
