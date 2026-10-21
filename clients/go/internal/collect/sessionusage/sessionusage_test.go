package sessionusage

import (
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// TS truncates with String#slice, which counts UTF-16 code units. Counting
// runes instead lets an astral-plane model id through at 160 runes (up to 320
// UTF-16 units), and the upload-time contract check — which counts UTF-16 —
// then rejects the whole snapshot. The bounded model must satisfy the same
// bound it is bounded for.
func TestBoundedModelTruncatesByUTF16Units(t *testing.T) {
	model := BoundedModel(strings.Repeat("😀", 200))
	if length := len([]rune(model)); length > 160 {
		t.Fatalf("rune length = %d, want <= 160", length)
	}
	snapshot := contract.Snapshot{
		Source:      contract.Source("opencode"),
		UsageDate:   "2026-01-01",
		Timezone:    "UTC",
		Model:       model,
		CollectedAt: "2026-01-01T00:00:00Z",
	}
	if err := snapshot.Validate(); err != nil {
		t.Fatalf("bounded model fails the contract it exists to satisfy: %v", err)
	}
}

// A cut that lands between the halves of a surrogate pair drops the half
// rather than storing a lone surrogate, which a Go string cannot hold. JS's
// slice keeps the half; the two can differ only for an id over 160 units with
// a pair straddling the cut, and keeping the whole pair instead would break
// the bound.
func TestBoundedModelKeepsABoundaryCharacterWhole(t *testing.T) {
	// 159 ASCII units leave room for one code unit of a surrogate pair.
	model := BoundedModel(strings.Repeat("a", 159) + "😀" + "tail")
	if length := len([]rune(model)); length != 159 {
		t.Errorf("rune length = %d, want 159 (the pair is cut, not half-kept)", length)
	}
	if !strings.HasPrefix(model, strings.Repeat("a", 159)) {
		t.Errorf("model = %q, want the 159 ASCII prefix", model)
	}
}

// An offset zone must attribute dates the way Intl does: the local calendar
// day in that offset, not UTC. TS accepts "+08:00" everywhere it formats a
// date, so a session that crosses midnight UTC has to land on the next day
// here too.
func TestAggregateAttributesDatesUnderAnOffsetTimezone(t *testing.T) {
	aggregate, err := NewAggregate(contract.Source("pi"), "+08:00", "2026-10-21T00:00:00Z", true)
	if err != nil {
		t.Fatalf("NewAggregate: %v", err)
	}
	if got := FormatDate(time.Date(2026, 10, 20, 17, 0, 0, 0, time.UTC), "+08:00"); got != "2026-10-21" {
		t.Errorf("FormatDate = %q, want 2026-10-21 (01:00 in +08:00)", got)
	}
	if got := FormatDate(time.Date(2026, 10, 20, 15, 59, 0, 0, time.UTC), "+08:00"); got != "2026-10-20" {
		t.Errorf("FormatDate = %q, want 2026-10-20 (23:59 in +08:00)", got)
	}
	if aggregate == nil {
		t.Fatal("aggregate is nil")
	}
}
