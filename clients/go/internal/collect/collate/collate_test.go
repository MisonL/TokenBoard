package collate

import (
	"sort"
	"testing"
)

// nodeSorted is produced by Node, not by hand:
//
//	[...new Set(corpus)].sort((a, b) => a.localeCompare(b))
//
// with the default (en-US) locale. Regenerate rather than adjust when a case
// is added; hand-editing would turn this into a test of the implementation's
// own opinion.
var nodeSorted = []string{
	"_x", "~z", "$y",
	"2026-01-02", "2026-06-15", "2026-06-16",
	"a b", "a_1", "a_b", "a-1", "A-1", "a-b", "a.1", "a.b", "a1", "ab",
	"apple", "Apple",
	"claude", "Claude",
	"claude-3-5-haiku", "Claude-3-5-Haiku",
	"claude-opus-4-1", "claude-sonnet-4-5",
	"deepseek-v4-flash", "deepseek-v4-pro",
	"gemini-2.5-pro",
	"gpt-4_1", "gpt-4.1", "gpt-4o", "GPT-4o",
	"grok-4.5", "Grok-4.5",
	"model-x", "Model-X",
	"o3-mini",
	"pi-1", "Pi-1",
	"qwen3-coder",
	"unknown",
	"Zebra",
}

func TestMatchesNodeLocaleCompareOrder(t *testing.T) {
	shuffled := make([]string, len(nodeSorted))
	copy(shuffled, nodeSorted)
	// Reverse, so a passing sort cannot be the input order surviving.
	for left, right := 0, len(shuffled)-1; left < right; left, right = left+1, right-1 {
		shuffled[left], shuffled[right] = shuffled[right], shuffled[left]
	}

	sort.SliceStable(shuffled, func(i, j int) bool { return Less(shuffled[i], shuffled[j]) })

	for index := range nodeSorted {
		if shuffled[index] != nodeSorted[index] {
			t.Fatalf("order diverges at %d: got %q, want %q\n got: %v\nwant: %v",
				index, shuffled[index], nodeSorted[index], shuffled, nodeSorted)
		}
	}
}

// The specific pairs whose byte order and localeCompare disagree, so the
// regression this package exists to prevent is named rather than implied.
func TestCaseAndPunctuationOutrankByteOrder(t *testing.T) {
	cases := []struct {
		left, right string
		wantLess    bool
	}{
		{"gpt-4o", "GPT-4o", true},   // ICU: lowercase first; bytes say otherwise
		{"a_b", "a-b", true},         // ICU: '_' before '-'; bytes say otherwise
		{"a_b", "a.b", true},         // ICU: '_' before '.'
		{"a1", "a_b", false},         // ICU: punctuation outranks digits, so a_b < a1
		{"claude", "Claude", true},   // lowercase first
		{"claude", "Claude-3", true}, // prefix sorts first
		{"Zebra", "apple", false},    // primary 'z' > 'a'
	}

	for _, testCase := range cases {
		if got := Less(testCase.left, testCase.right); got != testCase.wantLess {
			t.Errorf("Less(%q, %q) = %v, want %v", testCase.left, testCase.right, got, testCase.wantLess)
		}
	}
}

func TestEqualStringsAreNotLess(t *testing.T) {
	for _, value := range []string{"", "ab", "model-x", "2026-06-15"} {
		if Less(value, value) {
			t.Errorf("Less(%q, %q) = true", value, value)
		}
	}
}

func TestCompareIsAntisymmetric(t *testing.T) {
	for _, left := range nodeSorted {
		for _, right := range nodeSorted {
			forward, backward := Compare(left, right), Compare(right, left)
			if forward != -backward {
				t.Fatalf("Compare(%q, %q) = %d but Compare(%q, %q) = %d", left, right, forward, right, left, backward)
			}
		}
	}
}
