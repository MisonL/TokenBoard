package antigravitymeta

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// decodeResponse round-trips a fixture through the JSON decoder, so the parser
// sees json.Number (what a real language-server response produces) rather than
// hand-written Go numbers.
func decodeResponse(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

// --- protobuf fixture builders, mirroring the TS test helpers ---

func tag(field, wireType int) []byte { return varint(uint64(field*8 + wireType)) }

func varint(value uint64) []byte {
	var out []byte
	for value >= 128 {
		out = append(out, byte(value&127)|128)
		value >>= 7
	}
	return append(out, byte(value))
}

func fieldVarint(field int, value uint64) []byte {
	return append(tag(field, 0), varint(value)...)
}

func fieldString(field int, value string) []byte {
	out := append(tag(field, 2), varint(uint64(len(value)))...)
	return append(out, []byte(value)...)
}

func fieldMessage(field int, value []byte) []byte {
	out := append(tag(field, 2), varint(uint64(len(value)))...)
	return append(out, value...)
}

func message(fields ...[]byte) []byte {
	var out []byte
	for _, field := range fields {
		out = append(out, field...)
	}
	return out
}

type usageSpec struct {
	inputTokens  uint64
	outputTokens *uint64
	cacheRead    *uint64
	responseID   string
}

func usageMessage(spec usageSpec) []byte {
	fields := [][]byte{fieldVarint(2, spec.inputTokens)}
	if spec.outputTokens != nil {
		fields = append(fields, fieldVarint(3, *spec.outputTokens))
	}
	if spec.cacheRead != nil && *spec.cacheRead != 0 {
		fields = append(fields, fieldVarint(5, *spec.cacheRead))
	}
	if spec.responseID != "" {
		fields = append(fields, fieldString(11, spec.responseID))
	}
	return message(fields...)
}

func u64(value uint64) *uint64 { return &value }

func timestampField(seconds uint64, nanos *uint64) []byte {
	fields := [][]byte{fieldVarint(1, seconds)}
	if nanos != nil {
		fields = append(fields, fieldVarint(2, *nanos))
	}
	return fieldMessage(4, message(fields...))
}

// metadataBlob builds the root → chatModel → {usage, timestamp, model} shape.
func metadataBlob(usage []byte, timestamp []byte, modelFields ...[]byte) []byte {
	chatModelFields := [][]byte{fieldMessage(4, usage)}
	if timestamp != nil {
		chatModelFields = append(chatModelFields, fieldMessage(9, message(timestamp)))
	}
	chatModelFields = append(chatModelFields, modelFields...)
	return message(fieldMessage(1, message(chatModelFields...)), fieldString(4, "execution-a"))
}

func TestExtractsTokenMetadataFromGeneratorBlobs(t *testing.T) {
	shared := usageMessage(usageSpec{
		inputTokens: 25_908, outputTokens: u64(551), cacheRead: u64(24_454), responseID: "response-a",
	})
	blob := message(
		fieldMessage(1, message(
			fieldVarint(3, 1132),
			fieldMessage(4, shared),
			fieldMessage(9, message(timestampField(1_782_229_139, u64(863_115_000)))),
			fieldMessage(17, message(fieldMessage(2, shared))),
			fieldString(19, "gemini-3-flash-a"),
			fieldString(21, "Gemini 3.5 Flash (High)"),
		)),
		fieldString(4, "execution-a"),
	)

	event, ok, err := ParseGeneratorMetadataBlob(blob, BlobOptions{CascadeID: "conversation-a", RowIndex: 0})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no event parsed")
	}
	if event.CreatedAt != "2026-06-23T15:38:59.863Z" {
		t.Errorf("createdAt = %q", event.CreatedAt)
	}
	if event.Model != "gemini-3-flash-a" {
		t.Errorf("model = %q", event.Model)
	}
	if len(event.ModelAliases) != 1 || event.ModelAliases[0] != "Gemini 3.5 Flash (High)" {
		t.Errorf("modelAliases = %v", event.ModelAliases)
	}
	if event.InputTokens != 25_908 || event.OutputTokens != 551 ||
		event.CacheCreationTokens != 0 || event.CacheReadTokens != 24_454 {
		t.Errorf("tokens = %+v", event)
	}
	if len(event.CascadeHash) != 64 || len(event.EventHash) != 64 {
		t.Errorf("hashes not sha256: %q %q", event.CascadeHash, event.EventHash)
	}
}

func TestRejectsAnOversizedDisplayModelAlias(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2)}),
		timestampField(1_782_229_139, nil),
		fieldString(19, "gemini-3-flash-a"),
		fieldString(21, strings.Repeat("x", 161)),
	)
	_, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{CascadeID: "conversation-a"})
	if err == nil || !strings.Contains(err.Error(), "model is invalid") {
		t.Errorf("err = %v, want 'model is invalid'", err)
	}
}

func TestEmitsDistinctUsageBlocksFromTheSameRow(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
		nil,
		fieldString(19, "gemini-3-flash-a"),
	)
	// Splice in the optional nested block at 17.2 with different counts.
	nested := fieldMessage(17, message(fieldMessage(2,
		usageMessage(usageSpec{inputTokens: 11, cacheRead: u64(5), responseID: "response-b"}))))
	blob = message(
		fieldMessage(1, message(
			fieldMessage(4, usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"})),
			nested,
			fieldMessage(9, message(timestampField(1_782_229_139, nil))),
			fieldString(19, "gemini-3-flash-a"),
		)),
		fieldString(4, "execution-a"),
	)

	events, err := ParseGeneratorMetadataBlobEvents(blob, BlobOptions{CascadeID: "conversation-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2: %+v", len(events), events)
	}
	if events[0].InputTokens != 10 || events[0].OutputTokens != 2 || events[0].CacheReadTokens != 0 {
		t.Errorf("first = %+v", events[0])
	}
	if events[1].InputTokens != 11 || events[1].OutputTokens != 0 || events[1].CacheReadTokens != 5 {
		t.Errorf("second = %+v", events[1])
	}
}

func TestDedupesIdenticalUsageBlocks(t *testing.T) {
	shared := usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"})
	blob := message(
		fieldMessage(1, message(
			fieldMessage(4, shared),
			fieldMessage(17, message(fieldMessage(2, shared))),
			fieldMessage(9, message(timestampField(1_782_229_139, nil))),
			fieldString(19, "gemini-3-flash-a"),
		)),
		fieldString(4, "execution-a"),
	)
	events, err := ParseGeneratorMetadataBlobEvents(blob, BlobOptions{CascadeID: "conversation-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Errorf("events = %d, want 1 (identical blocks dedupe)", len(events))
	}
}

func TestKeepsPrimaryUsageWhenOptionalNestedBlockIsTruncated(t *testing.T) {
	// 17.2 is a length-delimited field whose inner varint is cut short.
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-primary"}),
		nil,
		fieldString(19, "gemini-3-flash-a"),
	)
	blob = message(
		fieldMessage(1, message(
			fieldMessage(4, usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-primary"})),
			fieldMessage(17, message(fieldMessage(2, []byte{0x08, 0x80}))),
			fieldString(19, "gemini-3-flash-a"),
		)),
		fieldString(4, "execution-a"),
	)

	events, err := ParseGeneratorMetadataBlobEvents(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err != nil {
		t.Fatalf("a truncated optional block must not fail the parse: %v", err)
	}
	if len(events) != 1 || events[0].InputTokens != 10 || events[0].OutputTokens != 2 {
		t.Errorf("events = %+v", events)
	}
}

func TestRejectsAnOversizedTokenInAnOptionalNestedBlock(t *testing.T) {
	blob := message(
		fieldMessage(1, message(
			fieldMessage(4, usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-primary"})),
			fieldMessage(17, message(fieldMessage(2, usageMessage(usageSpec{
				inputTokens: 1_000_000_001, responseID: "response-nested",
			})))),
			fieldString(19, "gemini-3-flash-a"),
		)),
		fieldString(4, "execution-a"),
	)
	_, err := ParseGeneratorMetadataBlobEvents(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err == nil || !strings.Contains(err.Error(), "token field 2 is invalid") {
		t.Errorf("err = %v, want 'token field 2 is invalid'", err)
	}
}

func TestKeepsPlaceholderModelIDs(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
		nil,
		fieldString(19, "MODEL_PLACEHOLDER_M12"),
	)
	event, ok, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if event.Model != "MODEL_PLACEHOLDER_M12" {
		t.Errorf("model = %q, want the placeholder", event.Model)
	}
}

func TestKeepsSparseUsageBlocksWithoutOutputTokens(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 8901, cacheRead: u64(89_389), responseID: "response-a"}),
		nil,
		fieldString(19, "gemini-3-flash-c"),
	)
	event, ok, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if event.InputTokens != 8901 || event.OutputTokens != 0 || event.CacheReadTokens != 89_389 {
		t.Errorf("event = %+v", event)
	}
}

func TestRejectsOversizedTokenVarints(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 1_000_000_001, outputTokens: u64(2), responseID: "response-a"}),
		nil,
		fieldString(19, "gemini-3-flash-c"),
	)
	_, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err == nil || !strings.Contains(err.Error(), "token field 2 is invalid") {
		t.Errorf("err = %v, want 'token field 2 is invalid'", err)
	}
}

func TestRejectsAnInvalidTimestampInsteadOfFallingBackToFileMtime(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
		timestampField(1<<53+1000, nil),
		fieldString(19, "gemini-3-flash-c"),
	)
	_, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err == nil || !strings.Contains(err.Error(), "createdAt is invalid") {
		t.Errorf("err = %v, want 'createdAt is invalid'", err)
	}
}

func TestRejectsATruncatedNestedTimestamp(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
		[]byte{0x08, 0x80}, // cut-short varint
		fieldString(19, "gemini-3-flash-c"),
	)
	_, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err == nil || !strings.Contains(err.Error(), "Truncated protobuf varint") {
		t.Errorf("err = %v, want 'Truncated protobuf varint'", err)
	}
}

func TestRejectsMalformedTimestampShapes(t *testing.T) {
	cases := map[string][]byte{
		"an empty timestamp":                   fieldMessage(4, nil),
		"a timestamp with the wrong wire type": fieldVarint(4, 1),
		"seconds with the wrong wire type":     fieldMessage(4, message(fieldString(1, "invalid"))),
		"nanos but no seconds":                 fieldMessage(4, message(fieldVarint(2, 1))),
	}
	for name, timestampField := range cases {
		blob := metadataBlob(
			usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
			timestampField,
			fieldString(19, "gemini-3-flash-c"),
		)
		if _, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
			CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
		}); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}
}

func TestRejectsInvalidTimestampNanos(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
		timestampField(1_782_229_139, u64(1_000_000_000)),
		fieldString(19, "gemini-3-flash-c"),
	)
	_, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{
		CascadeID: "conversation-a", FallbackCreatedAt: "2026-06-24T00:00:00.000Z",
	})
	if err == nil || !strings.Contains(err.Error(), "createdAt is invalid") {
		t.Errorf("err = %v, want 'createdAt is invalid'", err)
	}
}

func TestRejectsAReservedProtobufWireType(t *testing.T) {
	blob := append(tag(1, 3), 0x00) // wire type 3 is reserved
	if _, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{CascadeID: "c"}); err == nil {
		t.Error("a reserved wire type was accepted")
	}
}

func TestEventHashIsStableAcrossRepeatedParses(t *testing.T) {
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 10, outputTokens: u64(2), responseID: "response-a"}),
		timestampField(1_782_229_139, nil),
		fieldString(19, "gemini-3-flash-a"),
	)
	options := BlobOptions{CascadeID: "conversation-a", RowIndex: 7}
	first, _, err := ParseGeneratorMetadataBlob(blob, options)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := ParseGeneratorMetadataBlob(blob, options)
	if err != nil {
		t.Fatal(err)
	}
	if first.EventHash != second.EventHash {
		t.Errorf("event hash drifted: %q vs %q", first.EventHash, second.EventHash)
	}
	// A different row index is a different event.
	other, _, err := ParseGeneratorMetadataBlob(blob, BlobOptions{CascadeID: "conversation-a", RowIndex: 8})
	if err != nil {
		t.Fatal(err)
	}
	if other.EventHash == first.EventHash {
		t.Error("row index did not affect the event hash")
	}
}

// --- language-server route ---

func TestParsesGeneratorMetadataResponse(t *testing.T) {
	response := map[string]any{
		"generatorMetadata": []any{
			map[string]any{
				"executionId": "exec-1",
				"stepIndices": []any{0, 1},
				"chatModel": map[string]any{
					"responseModel":     "served-model",
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T15:38:59.863Z"},
					"usage": map[string]any{
						"inputTokens":         100,
						"outputTokens":        20,
						"cacheCreationTokens": 5,
						"cacheReadTokens":     50,
						"responseId":          "resp-1",
					},
				},
			},
		},
	}
	events, err := ParseGeneratorMetadata(decodeResponse(t, response), "conversation-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %+v", events)
	}
	event := events[0]
	if event.Model != "served-model" || event.CreatedAt != "2026-06-23T15:38:59.863Z" {
		t.Errorf("event = %+v", event)
	}
	if event.InputTokens != 100 || event.OutputTokens != 20 ||
		event.CacheCreationTokens != 5 || event.CacheReadTokens != 50 {
		t.Errorf("tokens = %+v", event)
	}
}

func TestRejectsAnInvalidGeneratorMetadataResponse(t *testing.T) {
	for name, response := range map[string]any{
		"not an object":      []any{1, 2},
		"missing the list":   map[string]any{},
		"list is not a list": map[string]any{"generatorMetadata": "nope"},
	} {
		if _, err := ParseGeneratorMetadata(decodeResponse(t, response), "c"); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}
}

func TestRejectsAnOversizedGeneratorMetadataResponse(t *testing.T) {
	items := make([]any, MaxGeneratorMetadataItems+1)
	for index := range items {
		items[index] = map[string]any{}
	}
	_, err := ParseGeneratorMetadata(decodeResponse(t, map[string]any{"generatorMetadata": items}), "c")
	if err == nil || !strings.Contains(err.Error(), "item limit") {
		t.Errorf("err = %v, want the item-limit error", err)
	}
}

func TestRejectsAnInvalidCalendarDate(t *testing.T) {
	response := map[string]any{
		"generatorMetadata": []any{
			map[string]any{
				"chatModel": map[string]any{
					"responseModel":     "m",
					"chatStartMetadata": map[string]any{"createdAt": "2026-02-30T00:00:00Z"},
					"usage":             map[string]any{"inputTokens": 1},
				},
			},
		},
	}
	if _, err := ParseGeneratorMetadata(decodeResponse(t, response), "c"); err == nil {
		t.Error("2026-02-30 was accepted")
	}
}

func TestPrefersAResolvedModelOverAPlaceholder(t *testing.T) {
	response := map[string]any{
		"generatorMetadata": []any{
			map[string]any{
				"chatModel": map[string]any{
					"responseModel":     "MODEL_PLACEHOLDER_X",
					"model":             "real-model",
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T15:38:59Z"},
					"usage":             map[string]any{"inputTokens": 1},
				},
			},
		},
	}
	events, err := ParseGeneratorMetadata(decodeResponse(t, response), "c")
	if err != nil {
		t.Fatal(err)
	}
	if events[0].Model != "real-model" {
		t.Errorf("model = %q, want real-model", events[0].Model)
	}
}

func TestAcceptsNumericStringTokens(t *testing.T) {
	response := map[string]any{
		"generatorMetadata": []any{
			map[string]any{
				"chatModel": map[string]any{
					"responseModel":     "m",
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T15:38:59Z"},
					"usage":             map[string]any{"inputTokens": "3272"},
				},
			},
		},
	}
	events, err := ParseGeneratorMetadata(decodeResponse(t, response), "c")
	if err != nil {
		t.Fatal(err)
	}
	if events[0].InputTokens != 3272 {
		t.Errorf("inputTokens = %d, want 3272", events[0].InputTokens)
	}
}

// The parser must never carry content fields into the event, whatever the
// response holds: a blob or response with prompts, replies and paths produces
// an event whose serialization contains none of them.
func TestNeverCarriesContentFieldsIntoTheEvent(t *testing.T) {
	secrets := []string{"a real prompt", "the assistant reply", "/home/user/secret/project"}
	response := map[string]any{
		"generatorMetadata": []any{
			map[string]any{
				"executionId": "exec-1",
				"prompt":      secrets[0],
				"chatModel": map[string]any{
					"responseModel":     "m",
					"content":           secrets[1],
					"path":              secrets[2],
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T15:38:59Z"},
					"usage":             map[string]any{"inputTokens": 10, "outputTokens": 2},
				},
			},
		},
	}
	events, err := ParseGeneratorMetadata(decodeResponse(t, response), "conversation-a")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range secrets {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Errorf("event serialization leaked %q: %s", secret, encoded)
		}
	}
}

func TestRawContentInADatabaseBlobNeverReachesTheEvent(t *testing.T) {
	// A gen_metadata row's protobuf carries prompt and path fields beside the
	// usage block; the projection must keep only the usage metadata.
	secrets := []string{"a real prompt", "/Users/someone/secret/project"}
	blob := metadataBlob(
		usageMessage(usageSpec{inputTokens: 120, outputTokens: u64(24), responseID: "response-a"}),
		message(timestampField(1_782_229_139, u64(863_115_000))),
		fieldString(19, "gemini-3-flash-a"),
		fieldString(3, secrets[0]),
		fieldString(12, secrets[1]),
	)
	event, ok, err := ParseGeneratorMetadataBlob(blob, BlobOptions{CascadeID: "conversation-a", RowIndex: 0})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no event parsed from the blob")
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range secrets {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("blob-derived event leaked %q: %s", secret, encoded)
		}
	}
}
