package codex

// Session-row decoding for the Codex subagent correction.
//
// The TS correction receives `sessions` already parsed by JSON.parse, whose
// objects remember their insertion order; `extractModelRows` iterates
// `Object.entries(row.models)` and the order of that iteration decides which
// model absorbs the integer-split remainder when a corrected total is spread
// across models. Go maps have no order, so the input is decoded here into an
// order-preserving record. Raw JSON bytes keep document order; an
// already-decoded Go map cannot, and its keys are sorted so the result is at
// least deterministic (the same convention ccusage's normalizeDecodedValue
// uses).

import (
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
)

// subagentRecord is one JSON object with its key order.
type subagentRecord struct {
	keys   []string
	values map[string]any
}

// Get returns one field.
func (r *subagentRecord) Get(key string) (any, bool) {
	if r == nil {
		return nil, false
	}
	value, ok := r.values[key]
	return value, ok
}

// Keys returns the keys in document order.
func (r *subagentRecord) Keys() []string {
	if r == nil {
		return nil
	}
	out := make([]string, len(r.keys))
	copy(out, r.keys)
	return out
}

// Map exposes the record's fields to the shared accessors in jsonl_reader.go,
// so the record's token readers cannot drift from the JSONL reader's.
func (r *subagentRecord) Map() UnknownRecord {
	if r == nil {
		return nil
	}
	return r.values
}

func newSubagentRecord() *subagentRecord {
	return &subagentRecord{values: map[string]any{}}
}

func (r *subagentRecord) set(key string, value any) {
	if _, exists := r.values[key]; !exists {
		r.keys = append(r.keys, key)
	}
	r.values[key] = value
}

// subagentRecordOf ports isRecord: a JSON object, not an array or scalar.
func subagentRecordOf(value any) (*subagentRecord, bool) {
	switch typed := value.(type) {
	case *subagentRecord:
		if typed == nil {
			return nil, false
		}
		return typed, true
	case ccusage.OrderedObject:
		// The runner's decoded rows. Their key order is the document order the
		// TS correction iterates, so it must survive this projection.
		record := newSubagentRecord()
		for _, key := range typed.Keys() {
			value, _ := typed.Get(key)
			record.set(key, normalizeSubagentSessionValue(value))
		}
		return record, true
	case map[string]any:
		record := newSubagentRecord()
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		// A Go map has no document order; sort so repeated runs agree.
		sort.Slice(keys, func(left, right int) bool { return keys[left] < keys[right] })
		for _, key := range keys {
			record.set(key, typed[key])
		}
		return record, true
	}
	return nil, false
}

// NormalizeSubagentSessions accepts the shapes a Go caller can hand over for
// the TS `sessions: unknown` input: raw JSON bytes (order preserved), or an
// already-decoded value. A string is not decoded — the TS input is the parsed
// value, and a bare string is simply not a record.
func NormalizeSubagentSessions(input any) (any, error) {
	switch typed := input.(type) {
	case nil:
		return nil, nil
	case []byte:
		return decodeSubagentSessionsJSON(typed)
	case json.RawMessage:
		return decodeSubagentSessionsJSON(typed)
	case string:
		return typed, nil
	}
	return normalizeSubagentSessionValue(input), nil
}

func normalizeSubagentSessionValue(value any) any {
	switch typed := value.(type) {
	case ccusage.OrderedObject:
		record := newSubagentRecord()
		for _, key := range typed.Keys() {
			fieldValue, _ := typed.Get(key)
			record.set(key, normalizeSubagentSessionValue(fieldValue))
		}
		return record
	case map[string]any:
		record := newSubagentRecord()
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return keys[left] < keys[right] })
		for _, key := range keys {
			record.set(key, normalizeSubagentSessionValue(typed[key]))
		}
		return record
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, normalizeSubagentSessionValue(entry))
		}
		return out
	case []UnknownRecord:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, normalizeSubagentSessionValue(entry))
		}
		return out
	case *subagentRecord:
		return typed
	}
	return value
}

// decodeSubagentSessionsJSON ports JSON.parse with document order preserved:
// numbers become float64 (overflow to ±Infinity, as in JS), duplicate keys keep
// the last value.
func decodeSubagentSessionsJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	value, err := decodeSubagentSessionValue(decoder)
	if err != nil {
		return nil, errors.New("Invalid Codex subagent sessions JSON")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("Invalid Codex subagent sessions JSON")
	}
	return value, nil
}

func decodeSubagentSessionValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case json.Delim:
		switch typed {
		case '{':
			record := newSubagentRecord()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				value, err := decodeSubagentSessionValue(decoder)
				if err != nil {
					return nil, err
				}
				record.set(key, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return record, nil
		case '[':
			out := []any{}
			for decoder.More() {
				value, err := decodeSubagentSessionValue(decoder)
				if err != nil {
					return nil, err
				}
				out = append(out, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return out, nil
		}
		return nil, errors.New("unexpected delimiter")
	default:
		return jsonlNormalizeJSONValue(token), nil
	}
}

// extractSubagentRows ports extractRows: the row list inside a wrapper object,
// or the array itself.
func extractSubagentRows(input any) []*subagentRecord {
	switch typed := input.(type) {
	case []any:
		return subagentFilterRecords(typed)
	case *subagentRecord:
		for _, key := range []string{"sessions", "data", "rows", "items"} {
			if values, ok := typed.Get(key); ok {
				if list, ok := values.([]any); ok {
					return subagentFilterRecords(list)
				}
			}
		}
	}
	return nil
}

func subagentFilterRecords(values []any) []*subagentRecord {
	out := make([]*subagentRecord, 0, len(values))
	for _, value := range values {
		if record, ok := subagentRecordOf(value); ok {
			out = append(out, record)
		}
	}
	return out
}

// readString ports readString over an ordered record.
func (r *subagentRecord) readString(keys []string) string {
	return ReadString(r.Map(), keys)
}

// readNumber ports readNumber over an ordered record.
func (r *subagentRecord) readNumber(keys []string) float64 {
	return ReadNumber(r.Map(), keys)
}

func (r *subagentRecord) readCacheCreationTokens() float64 {
	return ReadCacheCreationTokens(r.Map())
}

func (r *subagentRecord) readCacheReadTokens() float64 {
	return ReadCacheReadTokens(r.Map())
}

func (r *subagentRecord) readTotalTokens() float64 {
	return ReadTotalTokens(r.Map())
}

// readFiniteNumber is the TS readCostNumber: the first key holding a finite,
// non-negative number.
func (r *subagentRecord) readFiniteNumber(keys []string) float64 {
	for _, key := range keys {
		value, ok := r.Get(key)
		if !ok {
			continue
		}
		if number, ok := subagentJSONNumber(value); ok && number >= 0 {
			return number
		}
	}
	return 0
}

func subagentJSONNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	}
	return 0, false
}
