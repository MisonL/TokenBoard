// Package collate mirrors JavaScript's default localeCompare for the strings
// this collector sorts: usage dates and model ids.
//
// The ordering is not byte order. ICU compares case-insensitively at the
// primary level and only then puts lowercase before uppercase, so
// "gpt-4o".localeCompare("GPT-4o") is -1 while the byte comparison says the
// opposite. Punctuation carries its own primary weights too, which is why
// "a-b" sorts after "a_b" even though '-' is the lower byte. Where a Go sort
// and a TypeScript sort disagree, the two implementations emit the same
// snapshots in a different order — which the cursor contract compares
// byte-for-byte, so the divergence is real rather than cosmetic.
//
// primaryOrder below is the collation order of printable ASCII as ICU
// produces it, derived from Node rather than from memory:
//
//	[...Array(94).keys()].map(i => String.fromCharCode(33 + i))
//	  .sort((a, b) => a.localeCompare(b)).join('')
//
// Characters outside it (space is handled separately; anything above ASCII,
// such as CJK model names) sort after every ASCII character, in code-point
// order. ICU interleaves Latin-1 accents with their base letters and orders
// CJK by radical-stroke, so those names can still tie-break differently; the
// ids real providers report are ASCII.
package collate

// primaryOrder is every printable ASCII character in ICU primary order:
// punctuation first, then digits, then letters. Letters appear once — their
// case is a secondary weight, not a primary one.
const primaryOrder = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"

var primaryRanks = func() map[rune]int {
	ranks := make(map[rune]int, len(primaryOrder))
	for index, char := range primaryOrder {
		ranks[char] = index
	}
	return ranks
}()

// outsidePrimary sorts after every character in primaryOrder, in code-point
// order.
const outsidePrimary = len(primaryOrder)

func primaryWeight(char rune) int {
	if rank, ok := primaryRanks[lower(char)]; ok {
		return rank
	}
	return outsidePrimary + int(char)
}

// secondaryWeight is the case tie-break: lowercase before uppercase.
func secondaryWeight(char rune) int {
	if char >= 'A' && char <= 'Z' {
		return 1
	}
	return 0
}

func lower(char rune) rune {
	if char >= 'A' && char <= 'Z' {
		return char + ('a' - 'A')
	}
	return char
}

// Less reports whether a sorts before b, matching `a.localeCompare(b) < 0`.
func Less(a, b string) bool {
	if primary := comparePrimary(a, b); primary != 0 {
		return primary < 0
	}
	return compareSecondary(a, b) < 0
}

// comparePrimary compares the two strings with case folded away. A prefix
// sorts before the string that continues it.
func comparePrimary(a, b string) int {
	left, right := []rune(a), []rune(b)
	shared := len(left)
	if len(right) < shared {
		shared = len(right)
	}
	for index := 0; index < shared; index++ {
		lw, rw := primaryWeight(left[index]), primaryWeight(right[index])
		if lw != rw {
			if lw < rw {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(left) < len(right):
		return -1
	case len(left) > len(right):
		return 1
	}
	return 0
}

// compareSecondary breaks a primary tie by case, position by position. The
// two strings are the same length here: a primary tie means neither is a
// prefix of the other unless they are equal.
func compareSecondary(a, b string) int {
	left, right := []rune(a), []rune(b)
	for index := range left {
		lw, rw := secondaryWeight(left[index]), secondaryWeight(right[index])
		if lw != rw {
			if lw < rw {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Compare is Less as a sort comparator.
func Compare(a, b string) int {
	switch {
	case Less(a, b):
		return -1
	case Less(b, a):
		return 1
	}
	return 0
}
