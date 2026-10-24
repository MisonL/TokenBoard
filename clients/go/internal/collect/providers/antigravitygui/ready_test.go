package antigravitygui

import "testing"

// TS reads this with Number.parseInt(…, 10), so a trailing suffix still
// yields a usable timeout. Atoi rejected those and silently used the default,
// which meant a machine could wait a different amount of time per client.
func TestReadReadyTimeoutReadsLikeParseInt(t *testing.T) {
	cases := []struct {
		value string
		want  int64 // milliseconds
	}{
		{"5000", 5000},
		{"5000ms", 5000},
		{" 5000", 5000},
		{"5000.9", 5000},
		{"0", defaultReadyTimeout.Milliseconds()},
		{"-1", defaultReadyTimeout.Milliseconds()},
		{"abc", defaultReadyTimeout.Milliseconds()},
	}
	for _, tc := range cases {
		t.Setenv("TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS", tc.value)
		if got := readReadyTimeout().Milliseconds(); got != tc.want {
			t.Errorf("readReadyTimeout(%q) = %dms, want %dms", tc.value, got, tc.want)
		}
	}
}
