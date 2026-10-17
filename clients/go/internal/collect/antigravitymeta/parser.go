// Package antigravitymeta ports antigravity-gui-parser.ts and
// antigravity-history-protobuf.ts: turning Antigravity's generator metadata —
// whether it arrives as a language-server JSON response or as a protobuf blob
// in SQLite — into usage events.
//
// Both routes read only token counts, a model identity, a timestamp and the
// identifiers needed to deduplicate. The blobs and responses also carry
// prompts, replies and paths; none of those is projected, and the tests assert
// that the parsed event carries nothing beyond the fields declared here.
package antigravitymeta

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	maxTokenValue          = 1_000_000_000
	maxModelLength         = 160
	maxMetadataIdentityLen = 4_096
	maxMetadataStepIndices = 512
	// maxSafeInteger is the largest exactly-representable integer. The TS side
	// bounds timestamp and identity values by it, so a larger value must be
	// rejected rather than rounded into a plausible-looking one.
	maxSafeInteger         = int64(1)<<53 - 1
	placeholderModelPrefix = "MODEL_PLACEHOLDER_"
	// MaxGeneratorMetadataItems caps a language-server response's item list.
	MaxGeneratorMetadataItems = 8_192
)

// UsageEvent is one model call's usage, as both routes produce it.
type UsageEvent struct {
	CascadeHash string
	// CascadeHashAliases carries alternative hashes for the same conversation,
	// used when a language-server route and a SQLite route disagree on the id.
	CascadeHashAliases  []string
	EventHash           string
	CreatedAt           string
	Model               string
	ModelAliases        []string
	InputTokens         int64
	OutputTokens        int64
	CacheCreationTokens int64
	CacheReadTokens     int64
}

// hashStrings is the shared SHA-256-of-UTF-8 helper both hashes use.
func hashStrings(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// Hash is exported because the cursor layer hashes conversation ids the same
// way when it needs a key the parser did not supply.
func Hash(value string) string { return hashStrings(value) }

// jsNumber renders an integer the way JSON.stringify does — decimal, no
// exponent, no sign for zero.
func jsNumber(value int64) string { return strconv.FormatInt(value, 10) }

// jsJSONArray joins already-encoded JSON values into an array literal. Elements
// are pre-encoded because the two hashes put nulls, strings and numbers in the
// same array, and JSON.stringify has no whitespace.
func jsJSONArray(elements []string) string {
	return "[" + strings.Join(elements, ",") + "]"
}

// jsNullableIdentity encodes a responseId/executionId that may be a string, a
// number or absent.
func jsNullableIdentity(value any) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "null", nil
	case string:
		return contract.QuoteJSONString(typed), nil
	case int64:
		return jsNumber(typed), nil
	case float64:
		return contract.FormatJSONFloat(typed), nil
	default:
		return "", fmt.Errorf("unsupported identity type %T", value)
	}
}

// jsStepIndices encodes a stepIndices array or null.
func jsStepIndices(value any) (string, error) {
	if value == nil {
		return "null", nil
	}
	indices, ok := value.([]int64)
	if !ok {
		return "", errors.New("stepIndices is not an integer array")
	}
	encoded := make([]string, 0, len(indices))
	for _, index := range indices {
		encoded = append(encoded, jsNumber(index))
	}
	return jsJSONArray(encoded), nil
}

// UsageEventHash ports usageEventHash from the language-server route.
func UsageEventHash(identity EventIdentity, model, createdAt string, tokens TokenCounts) (string, error) {
	responseID, err := jsNullableIdentity(identity.ResponseID)
	if err != nil {
		return "", err
	}
	executionID, err := jsNullableIdentity(identity.ExecutionID)
	if err != nil {
		return "", err
	}
	stepIndices, err := jsStepIndices(identity.StepIndices)
	if err != nil {
		return "", err
	}
	return hashStrings(jsJSONArray([]string{
		responseID,
		executionID,
		stepIndices,
		contract.QuoteJSONString(model),
		contract.QuoteJSONString(createdAt),
		jsNumber(tokens.InputTokens),
		jsNumber(tokens.OutputTokens),
		jsNumber(tokens.CacheCreationTokens),
		jsNumber(tokens.CacheReadTokens),
	})), nil
}

// EventIdentity is the dedup identity a language-server item carries. Each
// field is nil when the response omitted it.
type EventIdentity struct {
	ResponseID  any
	ExecutionID any
	StepIndices any
}

// TokenCounts is the four-bucket token tuple both parse routes produce.
type TokenCounts struct {
	InputTokens         int64
	OutputTokens        int64
	CacheCreationTokens int64
	CacheReadTokens     int64
}

func (t TokenCounts) total() int64 {
	return t.InputTokens + t.OutputTokens + t.CacheCreationTokens + t.CacheReadTokens
}

// ParseGeneratorMetadata ports parseGeneratorMetadata: a language-server
// response's generatorMetadata items become usage events.
func ParseGeneratorMetadata(response any, cascadeID string) ([]UsageEvent, error) {
	record, ok := asRecord(response)
	if !ok {
		return nil, errors.New("Invalid Antigravity generator metadata response")
	}
	items, ok := record["generatorMetadata"].([]any)
	if !ok {
		return nil, errors.New("Invalid Antigravity generator metadata response")
	}
	if len(items) > MaxGeneratorMetadataItems {
		return nil, fmt.Errorf(
			"Antigravity generator metadata response exceeded the %d-item limit", MaxGeneratorMetadataItems)
	}
	cascadeHash := hashStrings(cascadeID)
	events := make([]UsageEvent, 0, len(items))
	for index, item := range items {
		event, ok, err := parseGeneratorMetadataItem(item, cascadeHash, index)
		if err != nil {
			return nil, err
		}
		if ok {
			events = append(events, event)
		}
	}
	return events, nil
}

func parseGeneratorMetadataItem(item any, cascadeHash string, index int) (UsageEvent, bool, error) {
	itemRecord, ok := asRecord(item)
	if !ok {
		return UsageEvent{}, false, nil
	}
	chatModel, ok := asRecord(itemRecord["chatModel"])
	if !ok {
		return UsageEvent{}, false, nil
	}
	usage, ok := asRecord(chatModel["usage"])
	if !ok || len(usage) == 0 {
		return UsageEvent{}, false, nil
	}
	tokens, ok, err := readUsageTokens(usage, index)
	if err != nil {
		return UsageEvent{}, false, err
	}
	if !ok {
		return UsageEvent{}, false, nil
	}
	startMetadata, _ := asRecord(chatModel["chatStartMetadata"])
	createdAt, err := readISODateTime(startMetadata["createdAt"], index)
	if err != nil {
		return UsageEvent{}, false, err
	}
	model, err := readModel(usage, chatModel, index)
	if err != nil {
		return UsageEvent{}, false, err
	}
	identity, err := readUsageEventIdentity(itemRecord, usage, index)
	if err != nil {
		return UsageEvent{}, false, err
	}
	eventHash, err := UsageEventHash(identity, model, createdAt, tokens)
	if err != nil {
		return UsageEvent{}, false, err
	}
	return UsageEvent{
		CascadeHash:         cascadeHash,
		EventHash:           eventHash,
		CreatedAt:           createdAt,
		Model:               model,
		InputTokens:         tokens.InputTokens,
		OutputTokens:        tokens.OutputTokens,
		CacheCreationTokens: tokens.CacheCreationTokens,
		CacheReadTokens:     tokens.CacheReadTokens,
	}, true, nil
}

func readUsageTokens(usage map[string]any, index int) (TokenCounts, bool, error) {
	read := func(key string) (int64, error) {
		value, present := usage[key]
		if !present || value == nil {
			return 0, nil
		}
		return readToken(value, key, index)
	}
	input, err := read("inputTokens")
	if err != nil {
		return TokenCounts{}, false, err
	}
	output, err := read("outputTokens")
	if err != nil {
		return TokenCounts{}, false, err
	}
	cacheCreation, err := read("cacheCreationTokens")
	if err != nil {
		return TokenCounts{}, false, err
	}
	cacheRead, err := read("cacheReadTokens")
	if err != nil {
		return TokenCounts{}, false, err
	}
	tokens := TokenCounts{
		InputTokens:         input,
		OutputTokens:        output,
		CacheCreationTokens: cacheCreation,
		CacheReadTokens:     cacheRead,
	}
	return tokens, tokens.total() != 0, nil
}

// readToken accepts a bounded non-negative integer, and a numeric string
// because the language server sometimes reports counts that way.
func readToken(value any, field string, index int) (int64, error) {
	invalid := func() error {
		return fmt.Errorf("Invalid Antigravity generator metadata item %d: %s must be a bounded nonnegative integer",
			index, field)
	}
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil || parsed < 0 || parsed > maxTokenValue {
			return 0, invalid()
		}
		return parsed, nil
	case float64:
		if typed != float64(int64(typed)) || typed < 0 || typed > maxTokenValue {
			return 0, invalid()
		}
		return int64(typed), nil
	case int64:
		if typed < 0 || typed > maxTokenValue {
			return 0, invalid()
		}
		return typed, nil
	case string:
		if !digitsOnly(typed) {
			return 0, invalid()
		}
		parsed, err := strconv.ParseInt(typed, 10, 64)
		if err != nil || parsed < 0 || parsed > maxTokenValue {
			return 0, invalid()
		}
		return parsed, nil
	}
	return 0, invalid()
}

func digitsOnly(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// readModel prefers a resolved model over a placeholder, matching the TS rule:
// a placeholder is real data (the ID Antigravity stored) but names no model,
// so it is only used when nothing better exists.
func readModel(usage, chatModel map[string]any, index int) (string, error) {
	candidates := []any{chatModel["responseModel"], usage["model"], chatModel["model"]}
	var placeholder string
	for _, candidate := range candidates {
		text, ok := candidate.(string)
		if !ok || text == "" {
			continue
		}
		if strings.HasPrefix(text, placeholderModelPrefix) {
			if placeholder == "" {
				placeholder = text
			}
			continue
		}
		return readBoundedString(text, "model", index)
	}
	if placeholder != "" {
		return readBoundedString(placeholder, "model", index)
	}
	return "", fmt.Errorf("Invalid Antigravity generator metadata item %d: model must be a non-empty string", index)
}

func readBoundedString(value, field string, index int) (string, error) {
	if value == "" || contract.UTF16Length(value) > maxModelLength {
		return "", fmt.Errorf("Invalid Antigravity generator metadata item %d: %s must be a non-empty string",
			index, field)
	}
	return value, nil
}

func readUsageEventIdentity(item, usage map[string]any, index int) (EventIdentity, error) {
	responseID, err := readOptionalIdentity(usage["responseId"], "responseId", index)
	if err != nil {
		return EventIdentity{}, err
	}
	executionID, err := readOptionalIdentity(item["executionId"], "executionId", index)
	if err != nil {
		return EventIdentity{}, err
	}
	stepIndices, err := readStepIndices(item["stepIndices"], index)
	if err != nil {
		return EventIdentity{}, err
	}
	return EventIdentity{ResponseID: responseID, ExecutionID: executionID, StepIndices: stepIndices}, nil
}

func readOptionalIdentity(value any, field string, index int) (any, error) {
	if value == nil {
		return nil, nil
	}
	invalid := func() error {
		return fmt.Errorf("Invalid Antigravity generator metadata item %d: %s must be a bounded identifier",
			index, field)
	}
	switch typed := value.(type) {
	case string:
		if contract.UTF16Length(typed) > maxMetadataIdentityLen {
			return nil, invalid()
		}
		return typed, nil
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return nil, invalid()
		}
		return parsed, nil
	case float64:
		if typed != float64(int64(typed)) {
			return nil, invalid()
		}
		return int64(typed), nil
	case int64:
		return typed, nil
	}
	return nil, invalid()
}

func readStepIndices(value any, index int) (any, error) {
	if value == nil {
		return nil, nil
	}
	invalid := func() error {
		return fmt.Errorf(
			"Invalid Antigravity generator metadata item %d: stepIndices must be a bounded integer array", index)
	}
	items, ok := value.([]any)
	if !ok || len(items) > maxMetadataStepIndices {
		return nil, invalid()
	}
	indices := make([]int64, 0, len(items))
	for _, item := range items {
		number, err := toNonNegativeInt64(item)
		if err != nil {
			return nil, invalid()
		}
		indices = append(indices, number)
	}
	return indices, nil
}

func toNonNegativeInt64(value any) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil || parsed < 0 {
			return 0, errors.New("not a non-negative integer")
		}
		return parsed, nil
	case float64:
		if typed != float64(int64(typed)) || typed < 0 {
			return 0, errors.New("not a non-negative integer")
		}
		return int64(typed), nil
	case int64:
		if typed < 0 {
			return 0, errors.New("not a non-negative integer")
		}
		return typed, nil
	}
	return 0, errors.New("not a non-negative integer")
}

// readISODateTime validates the timestamp's calendar fields by hand rather than
// trusting time.Parse: the TS validator rejects 2026-02-30, which a lenient
// parser would roll forward.
func readISODateTime(value any, index int) (string, error) {
	text, ok := value.(string)
	if !ok || !isValidISODateTime(text) {
		return "", fmt.Errorf("Invalid Antigravity generator metadata item %d: createdAt must be an ISO datetime", index)
	}
	return text, nil
}

func asRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}
