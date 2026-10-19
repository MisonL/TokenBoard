package upload

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func checkResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// The bound on an existing row's model id is the same one the snapshot schema
// applies — 160 UTF-16 code units, which is what JS `String#length` counts.
// Comparing bytes instead rejects ids that are perfectly valid and inside the
// bound as soon as they are non-ASCII: sixty Chinese characters are 60 units
// and 180 bytes.
func TestCheckResponseAcceptsANonASCIIModelInsideTheBound(t *testing.T) {
	model := strings.Repeat("模", 60)
	body := `{"existing":[{"source":"opencode","usageDate":"2026-01-01","model":"` + model +
		`","snapshotHash":"` + strings.Repeat("a", 64) + `"}]}`
	if _, err := parseCheckResponse(checkResponse(body)); err != nil {
		t.Fatalf("a 60-unit model id was rejected: %v", err)
	}
}

func TestCheckResponseRejectsAModelPastTheBound(t *testing.T) {
	model := strings.Repeat("模", 161)
	body := `{"existing":[{"source":"opencode","usageDate":"2026-01-01","model":"` + model +
		`","snapshotHash":"` + strings.Repeat("a", 64) + `"}]}`
	if _, err := parseCheckResponse(checkResponse(body)); err == nil {
		t.Fatal("a 161-unit model id was accepted")
	}
}
