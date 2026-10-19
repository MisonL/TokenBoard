package antigravitymeta

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// protoField is one decoded protobuf field value. Only the wire types the
// generator-metadata schema uses are modelled; an unknown wire type is a
// malformed blob rather than something to skip, because silently ignoring it
// would shift every following field.
type protoField struct {
	wireType int
	varint   uint64
	bytes    []byte
}

// protoMessage groups a message's fields by field number, keeping every
// occurrence because the schema stores repeated fields.
type protoMessage map[int][]protoField

// malformedProtobuf marks wire-level damage. The caller distinguishes it from
// a semantic error: an optional block that is merely truncated is ignored,
// while a present-but-invalid value propagates.
type malformedProtobuf struct{ message string }

func (e malformedProtobuf) Error() string { return e.message }

// BlobOptions configures one blob parse.
type BlobOptions struct {
	CascadeID         string
	RowIndex          int64
	FallbackCreatedAt string
}

// ParseGeneratorMetadataBlob returns the first usage event in a blob, or false
// when the blob carries none.
func ParseGeneratorMetadataBlob(blob []byte, options BlobOptions) (UsageEvent, bool, error) {
	events, err := ParseGeneratorMetadataBlobEvents(blob, options)
	if err != nil || len(events) == 0 {
		return UsageEvent{}, false, err
	}
	return events[0], true, nil
}

// ParseGeneratorMetadataBlobEvents returns every distinct usage block in a
// blob. A single SQLite row can carry more than one: the primary block at
// field 4, and an optional nested one at 17.2 that a newer schema adds.
func ParseGeneratorMetadataBlobEvents(blob []byte, options BlobOptions) ([]UsageEvent, error) {
	root, err := parseProtoMessage(blob)
	if err != nil {
		return nil, err
	}
	chatModel, ok, err := readMessage(root, 1)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	usages, err := readUsages(chatModel)
	if err != nil {
		return nil, err
	}
	if len(usages) == 0 {
		return nil, nil
	}
	createdAt, err := readCreatedAt(chatModel, options.FallbackCreatedAt)
	if err != nil {
		return nil, err
	}
	model, modelAliases, err := readProtoModel(chatModel)
	if err != nil {
		return nil, err
	}
	executionID := readProtoStringOrEmpty(root, 4)
	events := make([]UsageEvent, 0, len(usages))
	for _, usage := range usages {
		eventHash, err := protoEventHash(root, usage, options, createdAt, model, executionID)
		if err != nil {
			return nil, err
		}
		events = append(events, UsageEvent{
			CascadeHash:         hashStrings(options.CascadeID),
			EventHash:           eventHash,
			CreatedAt:           createdAt,
			Model:               model,
			ModelAliases:        modelAliases,
			InputTokens:         usage.inputTokens,
			OutputTokens:        usage.outputTokens,
			CacheCreationTokens: 0,
			CacheReadTokens:     usage.cacheReadTokens,
		})
	}
	return events, nil
}

type rawUsage struct {
	inputTokens     int64
	outputTokens    int64
	cacheReadTokens int64
	responseID      string
}

// protoEventHash ports historyEventHash. It hashes the cascade id, row index,
// the root's field-4 string, the response id, the timestamp, the model and the
// three token counts — the identity a repeated read of the same row must
// reproduce exactly.
func protoEventHash(
	root protoMessage,
	usage rawUsage,
	options BlobOptions,
	createdAt string,
	model string,
	executionID string,
) (string, error) {
	// The TS uses root field 4 for the hash, which is the same field the
	// execution id is read from above; it is re-read here rather than threaded
	// through so the hash inputs match the TS expression one for one.
	field4 := readProtoStringOrEmpty(root, 4)
	return hashStrings(jsJSONArray([]string{
		contract.QuoteJSONString(options.CascadeID),
		jsNumber(options.RowIndex),
		contract.QuoteJSONString(field4),
		contract.QuoteJSONString(usage.responseID),
		contract.QuoteJSONString(createdAt),
		contract.QuoteJSONString(model),
		jsNumber(usage.inputTokens),
		jsNumber(usage.outputTokens),
		jsNumber(usage.cacheReadTokens),
	})), nil
}

func readUsages(chatModel protoMessage) ([]rawUsage, error) {
	var usages []rawUsage
	primaryMessage, _, err0 := readMessage(chatModel, 4)
	if err0 != nil {
		return nil, err0
	}
	primary, ok, err := readUsage(primaryMessage)
	if err != nil {
		return nil, err
	}
	if ok {
		usages = append(usages, primary)
	}
	// Only malformed optional wire data may be ignored; a semantic validation
	// error (an out-of-range token) must propagate.
	nested, ok, err := readOptionalNestedUsage(chatModel)
	if err != nil {
		return nil, err
	}
	if ok {
		usages = append(usages, nested)
	}
	return dedupeUsages(usages), nil
}

func readOptionalNestedUsage(chatModel protoMessage) (rawUsage, bool, error) {
	message, ok, err := readNestedMessage(chatModel, []int{17, 2})
	if err != nil {
		var malformed malformedProtobuf
		if errors.As(err, &malformed) {
			return rawUsage{}, false, nil
		}
		return rawUsage{}, false, err
	}
	if !ok {
		return rawUsage{}, false, nil
	}
	return readUsage(message)
}

func dedupeUsages(usages []rawUsage) []rawUsage {
	result := make([]rawUsage, 0, len(usages))
	for _, usage := range usages {
		duplicate := false
		for _, existing := range result {
			if existing == usage {
				duplicate = true
				break
			}
		}
		if !duplicate {
			result = append(result, usage)
		}
	}
	return result
}

func readUsage(message protoMessage) (rawUsage, bool, error) {
	if message == nil {
		return rawUsage{}, false, nil
	}
	input, err := readOptionalToken(message, 2)
	if err != nil {
		return rawUsage{}, false, err
	}
	output, err := readOptionalToken(message, 3)
	if err != nil {
		return rawUsage{}, false, err
	}
	cacheRead, err := readOptionalToken(message, 5)
	if err != nil {
		return rawUsage{}, false, err
	}
	usage := rawUsage{
		inputTokens:     input,
		outputTokens:    output,
		cacheReadTokens: cacheRead,
		responseID:      readProtoStringOrEmpty(message, 11),
	}
	if usage.inputTokens+usage.outputTokens+usage.cacheReadTokens == 0 {
		return rawUsage{}, false, nil
	}
	return usage, true, nil
}

// readOptionalToken returns 0 for an absent field, and rejects a present one
// that is out of range: an absent count means "not reported", while an
// implausible one means the blob is corrupt.
func readOptionalToken(message protoMessage, field int) (int64, error) {
	value, ok := findVarint(message, field)
	if !ok {
		return 0, nil
	}
	if value > maxTokenValue {
		return 0, fmt.Errorf("Invalid Antigravity generator metadata blob: token field %d is invalid", field)
	}
	return int64(value), nil
}

// readCreatedAt reads the timestamp from chatModel.9.4, falling back to the
// caller's timestamp only when the blob carries none. A present but invalid
// timestamp is an error: falling back there would misdate the usage to the
// file's mtime.
func readCreatedAt(chatModel protoMessage, fallback string) (string, error) {
	timestamp, ok, err := readTimestamp(chatModel)
	if err != nil {
		return "", err
	}
	if ok {
		seconds, hasSeconds, err := readTimestampNumber(timestamp, 1)
		if err != nil {
			return "", err
		}
		nanos, hasNanos, err := readTimestampNumber(timestamp, 2)
		if err != nil {
			return "", err
		}
		if !hasSeconds {
			return "", errors.New("Invalid Antigravity generator metadata blob: createdAt is invalid")
		}
		if hasNanos && nanos >= 1_000_000_000 {
			return "", errors.New("Invalid Antigravity generator metadata blob: createdAt is invalid")
		}
		millis := seconds*1000 + nanos/1_000_000
		// TS rejects a timestamp whose Date is not finite (the JS date range
		// ends at ±8.64e15 ms). A blob can carry a seconds value inside the
		// safe-integer guard but past that range; formatting it would date the
		// usage in the far future instead of failing closed.
		if millis > maxJSMilliseconds || millis < -maxJSMilliseconds {
			return "", errors.New("Invalid Antigravity generator metadata blob: createdAt is invalid")
		}
		return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z"), nil
	}
	if fallback != "" {
		if _, err := time.Parse(time.RFC3339Nano, fallback); err == nil {
			return fallback, nil
		}
	}
	return "", errors.New("Invalid Antigravity generator metadata blob: createdAt is required")
}

func readTimestamp(chatModel protoMessage) (protoMessage, bool, error) {
	startMetadata, ok, err := readMessageAt(chatModel, 9)
	if err != nil || !ok {
		return nil, false, err
	}
	return readTimestampPathMessage(startMetadata, 4)
}

// readTimestampPathMessage requires the field to be present and to be a
// length-delimited message. A field present with the wrong wire type is a
// structural error, not an absent timestamp.
func readTimestampPathMessage(message protoMessage, field int) (protoMessage, bool, error) {
	fields, ok := message[field]
	if !ok {
		return nil, false, nil
	}
	for _, candidate := range fields {
		if candidate.wireType == 2 {
			parsed, err := parseProtoMessage(candidate.bytes)
			if err != nil {
				return nil, false, err
			}
			return parsed, true, nil
		}
	}
	return nil, false, errors.New("Invalid Antigravity generator metadata blob: createdAt is invalid")
}

func readTimestampNumber(message protoMessage, field int) (int64, bool, error) {
	fields, ok := message[field]
	if !ok {
		return 0, false, nil
	}
	for _, candidate := range fields {
		if candidate.wireType == 0 {
			// The TS guard is Number.MAX_SAFE_INTEGER, not int64's limit: a
			// value above it cannot survive the Number() conversion the TS
			// side performs, so accepting it here would date the usage to a
			// rounded instant instead of rejecting the blob.
			if candidate.varint > uint64(maxSafeInteger) {
				return 0, false, errors.New("Invalid Antigravity generator metadata blob: createdAt is invalid")
			}
			return int64(candidate.varint), true, nil
		}
	}
	return 0, false, errors.New("Invalid Antigravity generator metadata blob: createdAt is invalid")
}

// readProtoModel picks a resolved model over a placeholder and collects the
// non-placeholder alternatives as aliases.
func readProtoModel(chatModel protoMessage) (string, []string, error) {
	candidates := make([]string, 0, 2)
	for _, field := range []int{19, 21} {
		if value, ok := readProtoString(chatModel, field); ok && value != "" {
			candidates = append(candidates, value)
		}
	}
	for _, candidate := range candidates {
		if contract.UTF16Length(candidate) > maxModelLength {
			return "", nil, errors.New("Invalid Antigravity generator metadata blob: model is invalid")
		}
	}
	selected := ""
	for _, candidate := range candidates {
		if !strings.HasPrefix(candidate, placeholderModelPrefix) {
			selected = candidate
			break
		}
	}
	if selected == "" && len(candidates) > 0 {
		selected = candidates[0]
	}
	if selected == "" {
		return "", nil, errors.New("Invalid Antigravity generator metadata blob: model is required")
	}
	var aliases []string
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if candidate == selected || strings.HasPrefix(candidate, placeholderModelPrefix) || seen[candidate] {
			continue
		}
		seen[candidate] = true
		aliases = append(aliases, candidate)
	}
	return selected, aliases, nil
}

func readNestedMessage(message protoMessage, path []int) (protoMessage, bool, error) {
	current := message
	for _, field := range path {
		next, ok, err := readMessageAt(current, field)
		if err != nil || !ok {
			return nil, false, err
		}
		current = next
	}
	return current, true, nil
}

// readMessage returns a field's first length-delimited value parsed as a
// message, reporting false when absent or of another wire type. A malformed
// payload is an error, not an absence: the TS readMessage calls
// parseProtoMessage without catching, so wire damage there propagates too.
func readMessage(message protoMessage, field int) (protoMessage, bool, error) {
	return readMessageAt(message, field)
}

func readMessageAt(message protoMessage, field int) (protoMessage, bool, error) {
	for _, candidate := range message[field] {
		if candidate.wireType != 2 {
			continue
		}
		parsed, err := parseProtoMessage(candidate.bytes)
		if err != nil {
			return nil, false, err
		}
		return parsed, true, nil
	}
	return nil, false, nil
}

// readProtoString returns a field's length-delimited value as text, and false
// when it is absent or not text. A non-text field is treated as absent rather
// than an error, matching the TS isText gate.
func readProtoString(message protoMessage, field int) (string, bool) {
	for _, candidate := range message[field] {
		if candidate.wireType != 2 {
			continue
		}
		if !isText(candidate.bytes) {
			return "", false
		}
		return string(candidate.bytes), true
	}
	return "", false
}

func readProtoStringOrEmpty(message protoMessage, field int) string {
	value, _ := readProtoString(message, field)
	return value
}

func findVarint(message protoMessage, field int) (uint64, bool) {
	for _, candidate := range message[field] {
		if candidate.wireType == 0 {
			return candidate.varint, true
		}
	}
	return 0, false
}

// isText mirrors the TS isText: non-empty, no replacement character, and only
// printable ASCII plus tab/newline/carriage return.
func isText(bytes []byte) bool {
	if len(bytes) == 0 {
		return false
	}
	for _, char := range string(bytes) {
		if char == '�' {
			return false
		}
		if char == '\t' || char == '\n' || char == '\r' {
			continue
		}
		if char < 0x20 || char > 0x7e {
			return false
		}
	}
	return true
}

func parseProtoMessage(input []byte) (protoMessage, error) {
	fields := protoMessage{}
	offset := 0
	for offset < len(input) {
		tag, next, err := readVarint(input, offset)
		if err != nil {
			return nil, err
		}
		offset = next
		field := int(tag >> 3)
		wireType := int(tag & 7)
		offset, err = readProtoField(input, offset, field, wireType, fields)
		if err != nil {
			return nil, err
		}
	}
	return fields, nil
}

func readProtoField(input []byte, offset, field, wireType int, fields protoMessage) (int, error) {
	if field <= 0 {
		return 0, malformedProtobuf{"Invalid protobuf field number"}
	}
	switch wireType {
	case 0:
		value, next, err := readVarint(input, offset)
		if err != nil {
			return 0, err
		}
		fields[field] = append(fields[field], protoField{wireType: 0, varint: value})
		return next, nil
	case 1, 5:
		width := 4
		if wireType == 1 {
			width = 8
		}
		end := offset + width
		if end > len(input) {
			return 0, malformedProtobuf{"Invalid protobuf fixed-width field"}
		}
		fields[field] = append(fields[field], protoField{wireType: wireType, bytes: input[offset:end]})
		return end, nil
	case 2:
		length, next, err := readVarint(input, offset)
		if err != nil {
			return 0, err
		}
		start := next
		end := start + int(length)
		if end > len(input) || end < start {
			return 0, malformedProtobuf{"Invalid protobuf length-delimited field"}
		}
		fields[field] = append(fields[field], protoField{wireType: 2, bytes: input[start:end]})
		return end, nil
	}
	return 0, malformedProtobuf{fmt.Sprintf("Unsupported protobuf wire type: %d", wireType)}
}

// readVarint reads a base-128 varint. The shift cap matches the TS guard: past
// 70 bits the encoding is malformed rather than merely large.
func readVarint(input []byte, offset int) (uint64, int, error) {
	var value uint64
	var shift uint
	for index := offset; index < len(input); index++ {
		current := input[index]
		value |= uint64(current&127) << shift
		if current&128 == 0 {
			return value, index + 1, nil
		}
		shift += 7
		if shift > 70 {
			return 0, 0, malformedProtobuf{"Invalid protobuf varint"}
		}
	}
	return 0, 0, malformedProtobuf{"Truncated protobuf varint"}
}

// maxJSMilliseconds is the largest magnitude a JS Date can represent
// (±100,000,000 days from the epoch); Number.isFinite(date.getTime()) is false
// beyond it.
const maxJSMilliseconds = int64(8_640_000_000_000_000)
