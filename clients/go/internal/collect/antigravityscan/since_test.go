package antigravityscan

import (
	"strings"
	"testing"
	"time"
)

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func ptr(value string) *string { return &value }

func TestAcceptsSupportedSinceDateFormats(t *testing.T) {
	for _, since := range []string{"20260624", "2026-06-24"} {
		resolved, err := ResolveCollectionRange(ptr(since), "UTC", nil)
		if err != nil {
			t.Fatalf("since %q: %v", since, err)
		}
		if resolved.SinceDate != "2026-06-24" || resolved.HistoryScope != "2026-06-24@UTC" {
			t.Errorf("since %q: date=%q scope=%q", since, resolved.SinceDate, resolved.HistoryScope)
		}
		if resolved.FullHistory {
			t.Errorf("since %q: FullHistory = true", since)
		}
	}
}

func TestRejectsInvalidSinceDatesInsteadOfNormalizingThem(t *testing.T) {
	for _, since := range []string{"20260230", "2026-02-30", "2026--06-24", "2026/06/24"} {
		_, err := ResolveCollectionRange(ptr(since), "UTC", nil)
		if err == nil || !strings.Contains(err.Error(), "Invalid Antigravity since date: "+since) {
			t.Errorf("since %q: err = %v", since, err)
		}
	}
}

func TestFallsBackToTheDefaultSinceEnvValue(t *testing.T) {
	resolved, err := ResolveCollectionRange(nil, "UTC", envFrom(map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "20260501",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resolved.SinceDate != "2026-05-01" || resolved.HistoryScope != "2026-05-01@UTC" {
		t.Errorf("date=%q scope=%q", resolved.SinceDate, resolved.HistoryScope)
	}
}

// An empty since is a bounded run with no date bound, which is a different
// thing from an explicit "all": the former still writes a bounded cursor scope.
func TestDistinguishesBoundedEmptyConfigurationFromExplicitFullHistory(t *testing.T) {
	// An explicitly empty since does not consult the environment, so this is a
	// bounded run with no date bound rather than the env default.
	bounded, err := ResolveCollectionRange(ptr(""), "UTC", envFrom(map[string]string{"TOKENBOARD_DEFAULT_SINCE": "20260501"}))
	if err != nil {
		t.Fatal(err)
	}
	full, err := ResolveCollectionRange(ptr("all"), "UTC", nil)
	if err != nil {
		t.Fatal(err)
	}

	if bounded.FullHistory {
		t.Error("bounded run reported FullHistory")
	}
	if !full.FullHistory {
		t.Error("explicit all did not report FullHistory")
	}
	if bounded.SinceDate != "" || full.SinceDate != "" {
		t.Errorf("bounded.SinceDate=%q full.SinceDate=%q, want both empty", bounded.SinceDate, full.SinceDate)
	}
	if bounded.HistoryScope != "all" || full.HistoryScope != "all" {
		t.Errorf("bounded=%q full=%q, want all/all", bounded.HistoryScope, full.HistoryScope)
	}
	// The omitted spelling is the one that consults the environment.
	fromEnv, err := ResolveCollectionRange(nil, "UTC", envFrom(map[string]string{"TOKENBOARD_DEFAULT_SINCE": "20260501"}))
	if err != nil {
		t.Fatal(err)
	}
	if fromEnv.SinceDate != "2026-05-01" {
		t.Errorf("omitted since did not consult the environment: %q", fromEnv.SinceDate)
	}
}

func TestScopesBoundedCursorStateByTimezone(t *testing.T) {
	utc, err := ResolveCollectionRange(ptr("20260624"), "UTC", nil)
	if err != nil {
		t.Fatal(err)
	}
	shanghai, err := ResolveCollectionRange(ptr("20260624"), "Asia/Shanghai", nil)
	if err != nil {
		t.Fatal(err)
	}

	if utc.HistoryScope == shanghai.HistoryScope {
		t.Fatalf("both scopes are %q", utc.HistoryScope)
	}
	if IsReusableHistoryScope(utc.HistoryScope, shanghai.HistoryScope) {
		t.Error("a cursor from another timezone was reported reusable")
	}
}

// A cursor may only be reused when it already covers everything the new window
// asks for, which is the case when the new window starts no earlier than the
// one the cursor was built from.
func TestReusesAScopeOnlyWhenTheNewWindowIsCovered(t *testing.T) {
	cases := []struct {
		previous string
		current  string
		reusable bool
	}{
		{"2026-06-24@UTC", "2026-06-24@UTC", true},              // identical
		{"2026-06-01@UTC", "2026-06-24@UTC", true},              // cursor covers a wider window
		{"2026-06-24@UTC", "2026-06-01@UTC", false},             // new window reaches back further than the cursor
		{"2026-06-24@UTC", "2026-07-01@UTC", true},              // new window is narrower
		{"2026-06-24@UTC", "2026-06-24@Asia%2FShanghai", false}, // timezone changed
		{"all", "2026-06-24@UTC", false},                        // legacy scope carries no date
		{"2026-06-24@UTC", "all", false},
	}
	for _, testCase := range cases {
		if got := IsReusableHistoryScope(testCase.previous, testCase.current); got != testCase.reusable {
			t.Errorf("IsReusableHistoryScope(%q, %q) = %v, want %v",
				testCase.previous, testCase.current, got, testCase.reusable)
		}
	}
}

func TestIncludesTimestampComparesLocalDates(t *testing.T) {
	// 2026-06-23T17:30:00Z is still the 23rd in UTC but already the 24th in
	// Shanghai, so the same instant falls on either side of the window.
	utc, err := ResolveCollectionRange(ptr("20260624"), "UTC", nil)
	if err != nil {
		t.Fatal(err)
	}
	shanghai, err := ResolveCollectionRange(ptr("20260624"), "Asia/Shanghai", nil)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 6, 23, 17, 30, 0, 0, time.UTC)

	if utc.IncludesTimestamp(at) {
		t.Error("UTC window included 2026-06-23T17:30Z, which is the 23rd there")
	}
	if !shanghai.IncludesTimestamp(at) {
		t.Error("Shanghai window excluded 2026-06-23T17:30Z, which is the 24th there")
	}
}

// A file whose mtime cannot be read carries no date, so the window must keep
// it rather than silently drop usage.
func TestIncludesFileMtimeKeepsUnknownMtimes(t *testing.T) {
	resolved, err := ResolveCollectionRange(ptr("20260624"), "UTC", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.IncludesFileMtime(0) {
		t.Error("zero mtime was excluded")
	}
	before := float64(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	after := float64(time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	if resolved.IncludesFileMtime(before) {
		t.Error("an mtime before the window was included")
	}
	if !resolved.IncludesFileMtime(after) {
		t.Error("an mtime inside the window was excluded")
	}
}

func TestFullHistoryIncludesEverything(t *testing.T) {
	resolved, err := ResolveCollectionRange(ptr("all"), "UTC", nil)
	if err != nil {
		t.Fatal(err)
	}
	ancient := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if !resolved.IncludesTimestamp(ancient) || !resolved.IncludesFileMtime(1) {
		t.Error("a full-history range excluded old data")
	}
}

func TestResolveCollectionRangeWithNilEnvReadsTheProcessEnvironment(t *testing.T) {
	// The TS resolveAntigravityCollectionRange reads process.env when the
	// collection context threads none; nil must not silently mean "no since".
	t.Setenv("TOKENBOARD_SINCE", "20260601")
	rangeValue, err := ResolveCollectionRange(nil, "UTC", nil)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if rangeValue.SinceDate != "2026-06-01" {
		t.Fatalf("sinceDate = %q, want the process environment's 2026-06-01", rangeValue.SinceDate)
	}
}
