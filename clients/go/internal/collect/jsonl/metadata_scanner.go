// Package jsonl ports the session JSONL layer the hook-incremental providers
// read through (packages/collector/src/providers/session-jsonl-*.ts): a
// byte-level metadata scanner for oversized rows, the bounded line reader, and
// the per-source metric parser.
//
// The scanner exists because a single session row can be megabytes of prompt
// or attachment content. An oversized row is never buffered whole: the reader
// streams it through this scanner and fails closed if it might carry token or
// usage metadata, so an unreadable metric row can never be silently dropped.
package jsonl

import "github.com/MisonL/TokenBoard/clients/go/internal/contract"

// metadataScope mirrors the TS MetadataScope union: which part of the JSON
// document a container sits in. Only the scopes that decide relevance are
// modelled; everything else is scopeOther.
type metadataScope int

const (
	scopeRoot metadataScope = iota
	scopeRootMessage
	scopeRootPayload
	scopeRootPayloadMetadata
	scopeRootPayloadInfo
	scopeRootPayloadSource
	// scopeRootAttachment is Claude Code's `attachment` subtree. Its
	// `usage.totalTokens` is a task summary, not an uploadable usage object;
	// a key found here must not mark an oversized row as metric-bearing.
	scopeRootAttachment
	scopeClaudeUsage
	scopeCodexUsage
	scopeOther
)

type containerKind int

const (
	kindObject containerKind = iota
	kindArray
)

type containerPhase int

const (
	phaseKey containerPhase = iota
	phaseColon
	phaseValue
	phaseScalar
	phaseComma
)

type jsonContainer struct {
	canClose   bool
	kind       containerKind
	scope      metadataScope
	phase      containerPhase
	currentKey string
	scalar     string
}

type stringRole int

const (
	roleKey stringRole = iota
	roleValue
)

type jsonString struct {
	capture                 bool
	container               *jsonContainer
	escapeRemaining         int
	key                     string
	raw                     []byte
	role                    stringRole
	truncated               bool
	utf8ContinuationCount   int
	utf8FirstContinuationLo int // 0 = unset
	utf8FirstContinuationHi int // 0 = unset
}

// Scanner is the incremental metadata scanner. It is fed raw bytes of one
// oversized line and reports whether the line could carry usage metadata.
type Scanner struct {
	additionalRelevantKey   bool
	additionalRelevantKeys  map[string]bool
	claudeUsageObject       bool
	codexUsageOnly          bool
	codexTokenMetricKey     bool
	codexUsageObject        bool
	invalid                 bool
	rootFinished            bool
	rootType                string
	turnContextModel        string
	hasTurnContextModel     bool
	turnContextModelPrimary bool
	stack                   []*jsonContainer
	str                     *jsonString
}

// MetadataRecord is the bounded projection of an oversized turn_context row:
// only the model is retained, so following token rows can be attributed
// without buffering the row itself.
type MetadataRecord struct {
	Type    string
	Payload struct {
		Model string
	}
}

const (
	maxCapturedJSONStringBytes = 256
	maxJSONNesting             = 128
	maxJSONScalarBytes         = 128
)

var tokenMetricKeys = map[string]bool{
	"cache_creation_input_tokens": true,
	"cache_read_input_tokens":     true,
	"cacheCreationInputTokens":    true,
	"cacheCreationTokens":         true,
	"cacheReadInputTokens":        true,
	"cacheReadTokens":             true,
	"cached_input_tokens":         true,
	"cachedInputTokens":           true,
	"input_tokens":                true,
	"inputTokens":                 true,
	"output_tokens":               true,
	"outputTokens":                true,
	"total_tokens":                true,
	"totalTokens":                 true,
}

// NewScanner builds a scanner. codexUsageOnly narrows relevance to the Codex
// usage scopes, matching the TS option of the same name.
func NewScanner(additionalRelevantKeys []string, codexUsageOnly bool) *Scanner {
	keys := make(map[string]bool, len(additionalRelevantKeys))
	for _, key := range additionalRelevantKeys {
		keys[key] = true
	}
	return &Scanner{additionalRelevantKeys: keys, codexUsageOnly: codexUsageOnly}
}

// Scan feeds segments through the scanner. With stopOnRelevant set it stops
// at the first relevant signal, which is all the caller needs to fail closed.
func (s *Scanner) Scan(segments [][]byte, source contract.Source, stopOnRelevant bool) {
	for _, segment := range segments {
		for _, b := range segment {
			s.scanByte(b)
			if s.invalid || (stopOnRelevant && s.HasRelevantMetadata(source)) {
				return
			}
		}
	}
}

// HasRelevantMetadata mirrors hasRelevantSessionJsonlMetadata: whether the
// scanned bytes prove the row may carry token or usage data.
func (s *Scanner) HasRelevantMetadata(source contract.Source) bool {
	if s.additionalRelevantKey {
		return true
	}
	claudeRelevant := s.claudeUsageObject
	codexRelevant := s.codexUsageObject || s.codexTokenMetricKey
	switch source {
	case contract.SourceClaudeCode:
		return claudeRelevant
	case contract.SourceCodex:
		return codexRelevant
	}
	return claudeRelevant || codexRelevant
}

// RecordType returns the root `type` string, when the scanner saw one.
func (s *Scanner) RecordType() (string, bool) {
	return s.rootType, s.rootType != ""
}

// MetadataRecord projects an oversized turn_context row. Only a complete,
// valid scan of such a row yields a record.
func (s *Scanner) MetadataRecord() *MetadataRecord {
	if s.invalid || !s.rootFinished || s.rootType != "turn_context" || !s.hasTurnContextModel {
		return nil
	}
	record := &MetadataRecord{Type: "turn_context"}
	record.Payload.Model = s.turnContextModel
	return record
}

// Finish reports whether the scanned bytes form exactly one complete JSON
// value: valid, no open string or container, and the root closed.
func (s *Scanner) Finish() bool {
	return !s.invalid && s.str == nil && len(s.stack) == 0 && s.rootFinished
}

func (s *Scanner) scanByte(b byte) {
	if s.invalid || s.rootFinished {
		if !isJSONWhitespace(b) {
			s.invalid = true
		}
		return
	}
	if s.str != nil {
		s.scanStringByte(b)
		return
	}
	if isJSONWhitespace(b) {
		return
	}
	if len(s.stack) == 0 {
		if b == '{' {
			s.pushContainer(&jsonContainer{canClose: true, kind: kindObject, scope: scopeRoot, phase: phaseKey})
			return
		}
		s.invalid = true
		return
	}
	container := s.stack[len(s.stack)-1]
	if container.kind == kindObject {
		s.scanObjectByte(b, container)
		return
	}
	s.scanArrayByte(b, container)
}

func (s *Scanner) scanObjectByte(b byte, container *jsonContainer) {
	switch container.phase {
	case phaseKey:
		if b == '}' {
			if !container.canClose {
				s.invalid = true
				return
			}
			s.closeContainer(kindObject)
			return
		}
		if b == '"' {
			s.str = s.newJSONString(roleKey, container)
			return
		}
		s.invalid = true
	case phaseColon:
		if b == ':' {
			container.phase = phaseValue
			return
		}
		s.invalid = true
	case phaseValue:
		s.startJSONValue(b, container)
	case phaseScalar:
		s.finishScalarByte(b, container, kindObject)
	default: // phaseComma
		if b == ',' {
			container.phase = phaseKey
			container.canClose = false
			return
		}
		if b == '}' {
			s.closeContainer(kindObject)
			return
		}
		s.invalid = true
	}
}

func (s *Scanner) scanArrayByte(b byte, container *jsonContainer) {
	switch container.phase {
	case phaseValue:
		if b == ']' {
			if !container.canClose {
				s.invalid = true
				return
			}
			s.closeContainer(kindArray)
			return
		}
		s.startJSONValue(b, container)
	case phaseScalar:
		s.finishScalarByte(b, container, kindArray)
	default: // phaseComma
		if b == ',' {
			container.phase = phaseValue
			container.canClose = false
			return
		}
		if b == ']' {
			s.closeContainer(kindArray)
			return
		}
		s.invalid = true
	}
}

func (s *Scanner) startJSONValue(b byte, container *jsonContainer) {
	switch {
	case b == '{':
		scope := childScope(container, kindObject)
		s.recordUsageObject(scope)
		s.pushContainer(&jsonContainer{canClose: true, kind: kindObject, scope: scope, phase: phaseKey})
	case b == '[':
		s.pushContainer(&jsonContainer{canClose: true, kind: kindArray, scope: childScope(container, kindArray), phase: phaseValue})
	case b == '"':
		s.str = s.newJSONString(roleValue, container)
	case isJSONScalarStart(b):
		container.phase = phaseScalar
		container.scalar = string(b)
	default:
		s.invalid = true
	}
}

func (s *Scanner) finishScalarByte(b byte, container *jsonContainer, kind containerKind) {
	if isJSONWhitespace(b) {
		s.finishScalar(container)
		return
	}
	if b == ',' {
		s.finishScalar(container)
		finishContainerValue(container)
		if kind == kindObject {
			container.phase = phaseKey
		} else {
			container.phase = phaseValue
		}
		container.canClose = false
		return
	}
	closingByte := byte('}')
	if kind == kindArray {
		closingByte = ']'
	}
	if b == closingByte {
		s.finishScalar(container)
		s.closeContainer(kind)
		return
	}
	if len(container.scalar) >= maxJSONScalarBytes {
		s.invalid = true
		return
	}
	container.scalar += string(b)
}

func (s *Scanner) scanStringByte(b byte) {
	str := s.str
	if str.utf8ContinuationCount > 0 {
		if !isUTF8ContinuationByte(b) ||
			(str.utf8FirstContinuationLo != 0 && b < byte(str.utf8FirstContinuationLo)) ||
			(str.utf8FirstContinuationHi != 0 && b > byte(str.utf8FirstContinuationHi)) {
			s.invalid = true
			return
		}
		str.captureByte(b)
		str.utf8ContinuationCount--
		str.utf8FirstContinuationLo = 0
		str.utf8FirstContinuationHi = 0
		return
	}
	if str.escapeRemaining > 0 {
		if !isHexDigit(b) {
			s.invalid = true
			return
		}
		str.captureByte(b)
		str.escapeRemaining--
		return
	}
	if str.escapeRemaining == -1 {
		if b == 'u' {
			str.captureByte(b)
			str.escapeRemaining = 4
			return
		}
		if !isSimpleJSONEscape(b) {
			s.invalid = true
			return
		}
		str.captureByte(b)
		str.escapeRemaining = 0
		return
	}
	if b == '\\' {
		str.captureByte(b)
		str.escapeRemaining = -1
		return
	}
	if b != '"' {
		if b < 0x20 {
			s.invalid = true
			return
		}
		if b >= 0x80 {
			if !startUTF8Sequence(b, str) {
				s.invalid = true
				return
			}
		}
		str.captureByte(b)
		return
	}

	s.str = nil
	value, ok := str.capturedValue()
	if str.role == roleKey {
		if str.container == nil {
			s.invalid = true
			return
		}
		if !ok {
			if !str.truncated {
				s.invalid = true
				return
			}
			str.container.currentKey = ""
			str.container.phase = phaseColon
			return
		}
		str.container.currentKey = value
		str.container.phase = phaseColon
		if str.container.scope == scopeRoot && value == "type" {
			s.rootType = ""
		}
		if tokenMetricKeys[value] && str.container.scope != scopeRootAttachment &&
			(!s.codexUsageOnly || str.container.scope == scopeCodexUsage) {
			s.codexTokenMetricKey = true
		}
		if s.additionalRelevantKeys[value] && str.container.scope != scopeRootAttachment &&
			(!s.codexUsageOnly || isStrictCodexRelevantKey(str.container.scope, value)) {
			s.additionalRelevantKey = true
		}
		return
	}
	if str.container != nil {
		s.recordStringValue(str.container.scope, str.key, value, ok)
		finishContainerValue(str.container)
	}
}

func (s *Scanner) closeContainer(kind containerKind) {
	if len(s.stack) == 0 {
		s.invalid = true
		return
	}
	container := s.stack[len(s.stack)-1]
	if container.kind != kind {
		s.invalid = true
		return
	}
	s.stack = s.stack[:len(s.stack)-1]
	if len(s.stack) > 0 {
		finishContainerValue(s.stack[len(s.stack)-1])
		return
	}
	s.rootFinished = true
}

func (s *Scanner) pushContainer(container *jsonContainer) {
	if len(s.stack) >= maxJSONNesting {
		s.invalid = true
		return
	}
	s.stack = append(s.stack, container)
}

func (s *Scanner) newJSONString(role stringRole, container *jsonContainer) *jsonString {
	key := ""
	if role == roleValue && container != nil && container.kind == kindObject {
		key = container.currentKey
	}
	capture := role == roleKey || shouldCaptureValue(container, key)
	return &jsonString{capture: capture, container: container, key: key, role: role}
}

func (s *Scanner) recordUsageObject(scope metadataScope) {
	if scope == scopeClaudeUsage {
		s.claudeUsageObject = true
	}
	if scope == scopeCodexUsage {
		s.codexUsageObject = true
	}
}

func (s *Scanner) recordStringValue(scope metadataScope, key, value string, ok bool) {
	if !ok {
		return
	}
	if key == "type" && scope == scopeRoot {
		s.rootType = value
		return
	}
	if isTurnContextModelScope(scope) && isTurnContextModelKey(key) {
		isPrimary := scope == scopeRootPayload && key == "model"
		if isPrimary || (!s.turnContextModelPrimary && !s.hasTurnContextModel) {
			s.turnContextModel = value
			s.hasTurnContextModel = true
			s.turnContextModelPrimary = isPrimary
		}
	}
}

func (s *Scanner) finishScalar(container *jsonContainer) {
	value := container.scalar
	if value == "" || !isValidJSONScalar(value) {
		s.invalid = true
		return
	}
	container.scalar = ""
	container.phase = phaseComma
}

func finishContainerValue(container *jsonContainer) {
	container.canClose = true
	container.currentKey = ""
	container.scalar = ""
	container.phase = phaseComma
}

func shouldCaptureValue(container *jsonContainer, key string) bool {
	if container == nil {
		return false
	}
	return (key == "type" && container.scope == scopeRoot) ||
		(isTurnContextModelScope(container.scope) && isTurnContextModelKey(key))
}

func childScope(container *jsonContainer, kind containerKind) metadataScope {
	if container.scope == scopeClaudeUsage || container.scope == scopeCodexUsage {
		return container.scope
	}
	if container.scope == scopeRootAttachment {
		return scopeRootAttachment
	}
	if kind != kindObject {
		return scopeOther
	}
	switch container.scope {
	case scopeRoot:
		switch container.currentKey {
		case "message":
			return scopeRootMessage
		case "payload":
			return scopeRootPayload
		case "attachment":
			return scopeRootAttachment
		case "usage":
			return scopeClaudeUsage
		}
	case scopeRootMessage:
		if container.currentKey == "usage" {
			return scopeClaudeUsage
		}
	case scopeRootPayload:
		switch container.currentKey {
		case "info":
			return scopeRootPayloadInfo
		case "source":
			return scopeRootPayloadSource
		case "metadata":
			return scopeRootPayloadMetadata
		case "usage":
			return scopeCodexUsage
		}
	case scopeRootPayloadInfo:
		if container.currentKey == "total_token_usage" || container.currentKey == "last_token_usage" {
			return scopeCodexUsage
		}
	}
	return scopeOther
}

func isStrictCodexRelevantKey(scope metadataScope, key string) bool {
	if key == "subagent" {
		return scope == scopeRootPayloadSource
	}
	return (key == "total_token_usage" || key == "last_token_usage") &&
		(scope == scopeRootPayload || scope == scopeRootPayloadInfo)
}

func isTurnContextModelScope(scope metadataScope) bool {
	return scope == scopeRootPayload || scope == scopeRootPayloadInfo || scope == scopeRootPayloadMetadata
}

func isTurnContextModelKey(key string) bool {
	return key == "model" || key == "model_name" || key == "modelName"
}

func (str *jsonString) captureByte(b byte) {
	if !str.capture || str.truncated {
		return
	}
	if len(str.raw) >= maxCapturedJSONStringBytes {
		str.truncated = true
		str.raw = nil
		return
	}
	str.raw = append(str.raw, b)
}

// capturedValue decodes the captured string bytes the way the TS scanner
// does: JSON.parse of the quoted raw bytes, so escapes are resolved.
func (str *jsonString) capturedValue() (string, bool) {
	if !str.capture || str.truncated {
		return "", false
	}
	var value string
	quoted := make([]byte, 0, len(str.raw)+2)
	quoted = append(quoted, '"')
	quoted = append(quoted, str.raw...)
	quoted = append(quoted, '"')
	if err := jsonUnmarshalString(quoted, &value); err != nil {
		return "", false
	}
	return value, true
}

func isJSONScalarStart(b byte) bool {
	return b == '-' || (b >= '0' && b <= '9') || b == 'f' || b == 'n' || b == 't'
}

func isValidJSONScalar(value string) bool {
	if value == "true" || value == "false" || value == "null" {
		return true
	}
	return jsonNumberPattern.MatchString(value)
}

func isSimpleJSONEscape(b byte) bool {
	switch b {
	case '"', '/', '\\', 'b', 'f', 'n', 'r', 't':
		return true
	}
	return false
}

func isHexDigit(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'A' && b <= 'F') || (b >= 'a' && b <= 'f')
}

func startUTF8Sequence(b byte, str *jsonString) bool {
	switch {
	case b >= 0xc2 && b <= 0xdf:
		str.utf8ContinuationCount = 1
		return true
	case b == 0xe0:
		str.utf8ContinuationCount = 2
		str.utf8FirstContinuationLo = 0xa0
		return true
	case (b >= 0xe1 && b <= 0xec) || (b >= 0xee && b <= 0xef):
		str.utf8ContinuationCount = 2
		return true
	case b == 0xed:
		str.utf8ContinuationCount = 2
		str.utf8FirstContinuationHi = 0x9f
		return true
	case b == 0xf0:
		str.utf8ContinuationCount = 3
		str.utf8FirstContinuationLo = 0x90
		return true
	case b >= 0xf1 && b <= 0xf3:
		str.utf8ContinuationCount = 3
		return true
	case b == 0xf4:
		str.utf8ContinuationCount = 3
		str.utf8FirstContinuationHi = 0x8f
		return true
	}
	return false
}

func isUTF8ContinuationByte(b byte) bool {
	return b >= 0x80 && b <= 0xbf
}

func isJSONWhitespace(b byte) bool {
	return b == 0x09 || b == 0x0a || b == 0x0d || b == 0x20
}

// Invalid reports a malformed JSON document: the caller fails closed rather
// than treating an unparseable oversized row as safe to drop.
func (s *Scanner) Invalid() bool {
	return s.invalid
}
