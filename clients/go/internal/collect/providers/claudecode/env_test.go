package claudecode

import "testing"

func envReader(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

// TS reads both of these with Number.parseInt(…, 10), which takes a leading
// run of digits and ignores a trailing suffix. Atoi rejects the whole value,
// so the two collectors would budget a different timeout and retry count for
// the same environment.
func TestCcusageEnvValuesReadLikeParseInt(t *testing.T) {
	cases := []struct {
		value      string
		wantTimout int
	}{
		{"1200", 1200},
		{"1200abc", 1200}, // parseInt stops at the suffix
		{" 1200", 1200},   // leading whitespace is skipped
		{"1200.9", 1200},  // the fraction is ignored
		{"+1200", 1200},
		{"0", DefaultCcusageTimeoutMs},  // not positive: default
		{"-1", DefaultCcusageTimeoutMs}, // not positive: default
		{"abc", DefaultCcusageTimeoutMs},
		{"", DefaultCcusageTimeoutMs},
	}
	for _, tc := range cases {
		env := envReader(map[string]string{"TOKENBOARD_CCUSAGE_TIMEOUT_MS": tc.value})
		if got := readCcusageTimeoutMs(env); got != tc.wantTimout {
			t.Errorf("readCcusageTimeoutMs(%q) = %d, want %d", tc.value, got, tc.wantTimout)
		}
	}
}

// Zero retries is a valid value, so only a negative or absent count falls back.
func TestPackageCommandRetriesReadLikeParseInt(t *testing.T) {
	cases := []struct {
		value string
		want  int
	}{
		{"0", 0},
		{"3abc", 3},
		{" 3", 3},
		{"-1", DefaultPackageCommandRetries},
		{"abc", DefaultPackageCommandRetries},
		{"", DefaultPackageCommandRetries},
	}
	for _, tc := range cases {
		env := envReader(map[string]string{"TOKENBOARD_PACKAGE_COMMAND_RETRIES": tc.value})
		if got := readPackageCommandRetries(env); got != tc.want {
			t.Errorf("readPackageCommandRetries(%q) = %d, want %d", tc.value, got, tc.want)
		}
	}
}
