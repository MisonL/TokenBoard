package contract

import (
	"math"
	"strings"
	"testing"
)

// The expectations are the values Node's Number.parseInt and Number produce
// for the same strings; both collectors read the same environment.
func TestParseIntMatchesJavaScript(t *testing.T) {
	cases := []struct {
		value string
		want  int
		ok    bool
	}{
		{"12", 12, true},
		{"12abc", 12, true},
		{" 500", 500, true},
		{"500 ", 500, true},
		{"12.9", 12, true},
		{"+7", 7, true},
		{"-5", -5, true},
		{"0x10", 0, true},
		{"1e3", 1, true},
		{"", 0, false},
		{"abc", 0, false},
		{"-", 0, false},
		{"\n\t42", 42, true},
		{strings.Repeat("9", 40), math.MaxInt, true},
		{"-" + strings.Repeat("9", 40), -math.MaxInt, true},
	}
	for _, tc := range cases {
		got, ok := ParseInt(tc.value)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("ParseInt(%q) = %d, %v; want %d, %v", tc.value, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseNumberMatchesJavaScript(t *testing.T) {
	cases := []struct {
		value string
		want  float64
		ok    bool
	}{
		{"12.9", 12.9, true},
		{"0x10", 16, true},
		{"1e3", 1000, true},
		{" 50 ", 50, true},
		{"  0x1f  ", 31, true},
		{".5", 0.5, true},
		{"5.", 5, true},
		{"+3", 3, true},
		{"-1", -1, true},
		{"0b11", 3, true},
		{"0o17", 15, true},
		{"", 0, true},
		{"0", 0, true},
		// NaN: a trailing suffix is not a number to Number().
		{"50abc", 0, false},
		{"1_000", 0, false},
		{"NaN", 0, false},
		{"0x", 0, false},
	}
	for _, tc := range cases {
		got, ok := ParseNumber(tc.value)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("ParseNumber(%q) = %v, %v; want %v, %v", tc.value, got, ok, tc.want, tc.ok)
		}
	}

	infinite, ok := ParseNumber("Infinity")
	if !ok || !math.IsInf(infinite, 1) {
		t.Errorf("ParseNumber(\"Infinity\") = %v, %v", infinite, ok)
	}
}
