package jsonl

// Ports the scanner-level half of packages/collector/src/providers/
// hook-oversized-jsonl.test.ts. The TS suite drives the Codex and Claude hook
// end to end; the Go Codex provider is M5 work that does not exist yet, so the
// cases are pinned at the layer that does exist: the metadata scanner's
// "row carries usage metadata vs not" verdict, and the bounded reader's
// diagnostic for the row (sessionfile/line_reader_test.go).
//
// The fixtures mirror the oversized rows the TS suite builds (a 1 MiB+ filler
// plus a payload), because the verdict depends on where in the document the
// usage metadata sits relative to the part that would be dropped.

import (
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func scanRow(t *testing.T, row string, source contract.Source, codexUsageOnly bool) *Scanner {
	t.Helper()
	scanner := NewScanner(nil, codexUsageOnly)
	scanner.Scan([][]byte{[]byte(row)}, source, true)
	return scanner
}

func requireRelevant(t *testing.T, row string, source contract.Source, codexUsageOnly bool) {
	t.Helper()
	scanner := scanRow(t, row, source, codexUsageOnly)
	if scanner.Invalid() {
		t.Fatalf("row %q must scan as valid JSON", row)
	}
	if !scanner.HasRelevantMetadata(source) {
		t.Fatalf("row %q must be reported as carrying token or usage metadata", row)
	}
}

func requireNotRelevant(t *testing.T, row string, source contract.Source, codexUsageOnly bool) {
	t.Helper()
	scanner := scanRow(t, row, source, codexUsageOnly)
	if scanner.Invalid() {
		t.Fatalf("row %q must scan as valid JSON", row)
	}
	if scanner.HasRelevantMetadata(source) {
		t.Fatalf("row %q must be safe to drop, but the scanner reports usage metadata", row)
	}
}

// TestScannerSkipsNonUsageCodexRowWithoutRelevantMetadata is the first TS
// case: a 1 MiB `response_item` row with a plain text payload. It carries no
// usage, so the scanner must let the reader drop it (the reader then advances
// the cursor and reports the content-free diagnostic).
func TestScannerSkipsNonUsageCodexRowWithoutRelevantMetadata(t *testing.T) {
	row := `{"type":"response_item","payload":{"text":"` + strings.Repeat("x", 1024*1024+64) + `"}}`
	requireNotRelevant(t, row, contract.SourceCodex, true)

	scanner := scanRow(t, row, contract.SourceCodex, true)
	if recordType, ok := scanner.RecordType(); !ok || recordType != "response_item" {
		t.Fatalf("record type = %q, %v; want response_item", recordType, ok)
	}
	if !scanner.Finish() {
		t.Fatal("the scanner must see one complete JSON value")
	}
}

// TestScannerFailsClosedOnCodexUsageMetadataAfterLineLimit is the second TS
// case: the row is padded past the line limit before the `token_count` payload
// arrives, so a reader that stopped scanning early would drop a billable row.
// The scanner must report relevance even when the metadata sits after 1 MiB of
// filler.
func TestScannerFailsClosedOnCodexUsageMetadataAfterLineLimit(t *testing.T) {
	row := `{"type":"event_msg","padding":"` + strings.Repeat("x", 1024*1024+64) +
		`","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1}}}}`
	requireRelevant(t, row, contract.SourceCodex, true)

	// The Codex provider narrows the scanner to the Codex usage scopes; the
	// verdict must not depend on which source label is passed.
	requireRelevant(t, row, contract.SourceCodex, false)
}

// TestScannerReportsInvalidUTF8InShortRow is the third TS case at the scanner
// layer: a short row with a malformed UTF-8 sequence inside a string value.
// The scanner does its own UTF-8 validation, so it must flag the row invalid
// (the reader then refuses the file with the "invalid UTF-8" diagnostic).
func TestScannerReportsInvalidUTF8InShortRow(t *testing.T) {
	row := append([]byte(`{"type":"response_item","payload":"`), 0xc3, 0x28)
	row = append(row, []byte(`"}`)...)

	scanner := NewScanner(nil, true)
	scanner.Scan([][]byte{row}, contract.SourceCodex, true)
	if !scanner.Invalid() {
		t.Fatal("a row with an invalid UTF-8 continuation must scan as invalid")
	}
	if scanner.Finish() {
		t.Fatal("an invalid row is never a complete JSON value")
	}
}

// TestScannerSkipsClaudeAssistantRowWithoutUsage is the fourth TS case at the
// scanner layer: an oversized `assistant` row whose `message` holds only
// content. It carries no `usage` object, so it must be safe to drop.
func TestScannerSkipsClaudeAssistantRowWithoutUsage(t *testing.T) {
	row := `{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z","message":{"content":"` +
		strings.Repeat("x", 1024*1024+64) + `"}}`
	requireNotRelevant(t, row, contract.SourceClaudeCode, false)

	scanner := scanRow(t, row, contract.SourceClaudeCode, false)
	if recordType, ok := scanner.RecordType(); !ok || recordType != "assistant" {
		t.Fatalf("record type = %q, %v; want assistant", recordType, ok)
	}
	if !scanner.Finish() {
		t.Fatal("the scanner must see one complete JSON value")
	}
}

// TestScannerDistinguishesClaudeAndCodexUsageScopes pins the source-gated
// verdict behind both TS hook cases: the same row is relevant to one source
// and irrelevant to the other, so a Codex-shaped row never blocks a Claude
// read and vice versa. The flags mirror what sessionfile.Read passes: source
// codex implies codexUsageOnly.
func TestScannerDistinguishesClaudeAndCodexUsageScopes(t *testing.T) {
	codexRow := `{"type":"event_msg","payload":{"info":{"last_token_usage":{"input_tokens":1}}}}`
	requireRelevant(t, codexRow, contract.SourceCodex, true)
	requireNotRelevant(t, codexRow, contract.SourceClaudeCode, false)

	claudeRow := `{"type":"assistant","message":{"usage":{"input_tokens":1}}}`
	requireRelevant(t, claudeRow, contract.SourceClaudeCode, false)
	requireNotRelevant(t, claudeRow, contract.SourceCodex, true)
}
