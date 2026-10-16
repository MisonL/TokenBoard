package mtime

import (
	"testing"
	"time"
)

// The nanosecond value fs.statSync reported for a fixture database whose
// mtimeMs was 1792153999246.4922, where dividing the whole epoch by 1e6 in
// one step lands one ulp lower.
const fixtureNanos = 1792153999246492248

func TestMillisMatchesNodeMtimeMs(t *testing.T) {
	value := Millis(time.Unix(0, fixtureNanos))
	if value != 1792153999246.4922 {
		t.Fatalf("Millis = %.4f, want 1792153999246.4922", value)
	}
}

func TestMillisKeepsSubMillisecondPrecision(t *testing.T) {
	if got := Millis(time.Unix(1000, 1000)); got != 1000000.001 {
		t.Fatalf("Millis = %v, want 1000000.001", got)
	}
	if got := Millis(time.Unix(-3, 500000000)); got != -2500 {
		t.Fatalf("Millis = %v, want -2500", got)
	}
}
