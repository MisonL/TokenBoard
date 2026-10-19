package upload

import (
	"testing"
	"time"
)

// The retry base is shared state through the environment: a value one client
// accepts and the other rejects makes the TS and Go collectors back off
// differently on the same machine. TS reads it with Number.parseInt(…, 10),
// which takes a leading run of digits and ignores a trailing suffix.
func TestRetryDelayReadsTheEnvironmentLikeParseInt(t *testing.T) {
	cases := []struct {
		value string
		want  time.Duration
	}{
		{"125", 125 * time.Millisecond},
		{"12abc", 12 * time.Millisecond}, // parseInt stops at the suffix
		{" 500", 500 * time.Millisecond}, // leading whitespace is skipped
		{"12.9", 12 * time.Millisecond},  // the fraction is ignored
		{"+7", 7 * time.Millisecond},
		{"0x10", 0}, // parseInt base 10 reads "0" and stops at "x"
		{"1e3", 1 * time.Millisecond},
		{"-5", defaultRetryDelayMs * time.Millisecond}, // negative falls back
		{"", defaultRetryDelayMs * time.Millisecond},
		{"abc", defaultRetryDelayMs * time.Millisecond},
	}
	for _, tc := range cases {
		t.Setenv("TOKENBOARD_FETCH_RETRY_DELAY_MS", tc.value)
		if got := retryDelay(nil, 0, 0); got != tc.want {
			t.Errorf("retryDelay with %q = %v, want %v", tc.value, got, tc.want)
		}
	}
}

// An oversized positive value is clamped to the ceiling, not discarded:
// parseInt returns the number however large it is, and everything above the
// ceiling collapses to the same delay. Falling back to the default here would
// make the two clients back off differently for the same input.
func TestRetryDelayClampsAnOversizedEnvironmentValue(t *testing.T) {
	t.Setenv("TOKENBOARD_FETCH_RETRY_DELAY_MS", "99999999999999999999")
	if got := retryDelay(nil, 0, 0); got != maxRetryDelayMs*time.Millisecond {
		t.Errorf("retryDelay = %v, want the %v ceiling", got, maxRetryDelayMs*time.Millisecond)
	}

	// A negative overflow stays negative in JS, so it takes the default.
	t.Setenv("TOKENBOARD_FETCH_RETRY_DELAY_MS", "-99999999999999999999")
	if got := retryDelay(nil, 0, 0); got != defaultRetryDelayMs*time.Millisecond {
		t.Errorf("retryDelay = %v, want the %v default", got, defaultRetryDelayMs*time.Millisecond)
	}
}

// An explicit Config override outranks the environment, and a non-zero
// override is the only way to express "zero" through the config.
func TestRetryDelayPrefersTheConfigOverride(t *testing.T) {
	t.Setenv("TOKENBOARD_FETCH_RETRY_DELAY_MS", "900")
	if got := retryDelay(nil, 0, 25); got != 25*time.Millisecond {
		t.Errorf("retryDelay with override = %v, want 25ms", got)
	}
}
