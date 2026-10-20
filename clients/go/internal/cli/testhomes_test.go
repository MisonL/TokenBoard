package cli

import "encoding/json"

// encodeJSONHomes builds the TOKENBOARD_CODEX_HOMES_JSON value for a set of
// homes. A raw `"..."` concatenation is not valid JSON on Windows, where a
// temporary path contains backslashes (`\U` is an invalid escape), so the
// encoder has to do the quoting.
func encodeJSONHomes(homes ...string) string {
	encoded, err := json.Marshal(homes)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}
