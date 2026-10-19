package contract

import (
	"math"
	"strconv"
	"strings"
)

// Number parsing with the exact semantics of the JavaScript the TS collector
// uses. The two clients share their environment, so a value one of them reads
// differently is a value that makes them disagree on a timeout or a batch size.

// ParseInt reads value the way Number.parseInt(value, 10) does: leading
// whitespace is skipped, an optional sign is read, and the digits that follow
// are taken on their own — a trailing suffix ("12abc", "12.9") is ignored
// rather than making the whole value unreadable. A base prefix is not honoured,
// because base 10 stops at the "x" in "0x10".
//
// A value too large for an int saturates in the sign's direction instead of
// failing: JS has no overflow at these magnitudes, so the number it returns is
// merely huge. Reporting "unreadable" would send the caller to a default the
// TS side never uses.
func ParseInt(value string) (int, bool) {
	text := strings.TrimLeftFunc(value, isJSSpace)
	negative := false
	if text != "" && (text[0] == '+' || text[0] == '-') {
		negative = text[0] == '-'
		text = text[1:]
	}
	digits := 0
	for digits < len(text) && text[digits] >= '0' && text[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	parsed, err := strconv.Atoi(text[:digits])
	if err != nil {
		if negative {
			return -math.MaxInt, true
		}
		return math.MaxInt, true
	}
	if negative {
		parsed = -parsed
	}
	return parsed, true
}

// ParseNumber reads value the way Number(value) does for the forms an
// environment variable can hold: surrounding whitespace is ignored, and the
// whole remaining string must be a number — decimals, exponents and 0x/0o/0b
// prefixes included. An empty string is 0, as in JS. Anything with a trailing
// suffix is NaN, which the caller must treat as "unset".
//
// The result is exact only up to 2^53; callers that need a safe integer check
// it themselves, because that is what the TS side does.
func ParseNumber(value string) (float64, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, true
	}
	lowered := strings.ToLower(text)
	negative := false
	unsigned := lowered
	if unsigned != "" && (unsigned[0] == '+' || unsigned[0] == '-') {
		negative = unsigned[0] == '-'
		unsigned = unsigned[1:]
	}
	if length, base := numberPrefixBase(unsigned); length > 0 {
		digits := unsigned[length:]
		if digits == "" {
			return 0, false
		}
		parsed, err := strconv.ParseInt(digits, base, 64)
		if err != nil {
			return 0, false
		}
		number := float64(parsed)
		if negative {
			number = -number
		}
		return number, true
	}
	if strings.EqualFold(unsigned, "infinity") {
		if negative {
			return math.Inf(-1), true
		}
		return math.Inf(1), true
	}
	// Go's ParseFloat accepts digit-separating underscores and the literal
	// "NaN"; Number() accepts neither, so both are rejected before parsing.
	if strings.ContainsRune(text, '_') {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) {
		return 0, false
	}
	return parsed, true
}

// numberPrefixBase reports the length of an explicit radix prefix and the
// radix itself, for the three forms JS accepts.
func numberPrefixBase(value string) (int, int) {
	switch {
	case strings.HasPrefix(value, "0x"):
		return 2, 16
	case strings.HasPrefix(value, "0o"):
		return 2, 8
	case strings.HasPrefix(value, "0b"):
		return 2, 2
	}
	return 0, 0
}

// isJSSpace matches the whitespace String.prototype.trim removes.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x85, 0xA0, 0x1680,
		0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
		0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return false
}
