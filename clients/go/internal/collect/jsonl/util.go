package jsonl

import (
	"encoding/json"
	"regexp"
)

var jsonNumberPattern = regexp.MustCompile(`^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$`)

func jsonUnmarshalString(quoted []byte, target *string) error {
	return json.Unmarshal(quoted, target)
}
