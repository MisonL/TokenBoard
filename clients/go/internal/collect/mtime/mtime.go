// Package mtime reproduces the millisecond timestamp Node's fs stat reports,
// for the values persisted in cursor files shared with the TypeScript
// collector.
package mtime

import "time"

// Millis returns t as Node's fs.Stats#mtimeMs would: whole seconds scaled to
// milliseconds first, then the sub-second part, then the two added. Dividing
// the nanosecond epoch in one step instead rounds differently in the last bit
// for present-day timestamps, and a cursor written by one client would then
// not compare equal to the same file read by the other.
func Millis(t time.Time) float64 {
	return float64(t.Unix())*1e3 + float64(t.Nanosecond())/1e6
}
