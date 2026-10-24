package antigravitymeta

import (
	"regexp"
	"time"
)

// isoDateTimePattern mirrors the TS validator's regex: an uppercase date-time
// with optional sub-second digits of 1-9 places and either a Z or a signed
// HH:MM numeric offset.
var isoDateTimePattern = regexp.MustCompile(
	`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$`)

// isValidISODateTime checks the calendar fields by hand rather than trusting a
// lenient parser: the TS validator rejects 2026-02-30, which time.Parse would
// roll forward into March.
func isValidISODateTime(value string) bool {
	match := isoDateTimePattern.FindStringSubmatch(value)
	if match == nil {
		return false
	}
	number := func(index int) int {
		parsed := 0
		for _, char := range match[index] {
			parsed = parsed*10 + int(char-'0')
		}
		return parsed
	}
	year, month, day := number(1), number(2), number(3)
	hour, minute, second := number(4), number(5), number(6)
	offsetHour, offsetMinute := 0, 0
	if match[8] != "" {
		offsetHour, offsetMinute = number(8), number(9)
	}
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) {
		return false
	}
	if hour > 23 || minute > 59 || second > 59 {
		return false
	}
	if offsetHour > 23 || offsetMinute > 59 {
		return false
	}
	// The field checks above already reject everything time.Parse would, so a
	// parse failure here is unreachable; it is kept as the belt-and-braces
	// equivalent of the TS `Number.isFinite(Date.parse(value))` guard.
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func daysInMonth(year, month int) int {
	if month == 2 {
		if isLeapYear(year) {
			return 29
		}
		return 28
	}
	switch month {
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

func isLeapYear(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}
