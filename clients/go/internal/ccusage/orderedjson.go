package ccusage

import (
	"encoding/json"
	"fmt"
	"io"
)

// orderedRecord is a JSON object that remembers its key order. ccusage's
// breakdown objects are iterated in insertion order by the TS normalizer, and
// the session-count attribution keeps the first model on a token tie — Go's
// unordered maps would silently change that choice.
type orderedRecord struct {
	keys   []string
	values map[string]any
}

func newOrderedRecord() *orderedRecord {
	return &orderedRecord{values: map[string]any{}}
}

func (r *orderedRecord) set(key string, value any) {
	if _, exists := r.values[key]; !exists {
		r.keys = append(r.keys, key)
	}
	r.values[key] = value
}

// Get returns one value.
func (r *orderedRecord) Get(key string) (any, bool) {
	if r == nil {
		return nil, false
	}
	value, ok := r.values[key]
	return value, ok
}

// Keys returns the keys in document order.
func (r *orderedRecord) Keys() []string {
	if r == nil {
		return nil
	}
	out := make([]string, len(r.keys))
	copy(out, r.keys)
	return out
}

func (r *orderedRecord) Len() int {
	if r == nil {
		return 0
	}
	return len(r.keys)
}

// decodeOrdered decodes JSON with json.Number numbers and ordered objects.
func decodeOrdered(data []byte) (any, error) {
	decoder := json.NewDecoder(newByteReader(data))
	decoder.UseNumber()
	value, err := decodeValue(decoder)
	if err != nil {
		return nil, err
	}
	// Reject trailing content the way JSON.parse does.
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected trailing JSON content")
	}
	return value, nil
}

func decodeValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case json.Delim:
		switch typed {
		case '{':
			record := newOrderedRecord()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key must be a string")
				}
				value, err := decodeValue(decoder)
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
			values := []any{}
			for decoder.More() {
				value, err := decodeValue(decoder)
				if err != nil {
					return nil, err
				}
				values = append(values, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return values, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", typed)
	}
	return token, nil
}

type byteReader struct {
	data   []byte
	offset int
}

func newByteReader(data []byte) *byteReader {
	return &byteReader{data: data}
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.offset >= len(r.data) {
		return 0, io.EOF
	}
	read := copy(p, r.data[r.offset:])
	r.offset += read
	return read, nil
}
