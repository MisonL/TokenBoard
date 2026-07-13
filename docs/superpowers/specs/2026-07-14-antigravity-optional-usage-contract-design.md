# Antigravity Optional Usage Contract Design

## Goal

Strengthen the Antigravity SQLite metadata parser contract so optional nested
usage projection tolerates structural Protobuf damage without silently
discarding semantically invalid usage data.

## Context

`field 4` and nested `[17, 2]` can represent distinct usage events from one
SQLite row. A truncated nested projection is optional metadata and must not
discard a valid primary usage. In contrast, a decoded token value above the
shared `1_000_000_000` limit is invalid source data. All Antigravity collection
paths reject that condition so that incomplete usage is observable and the row
is retried instead of advancing its cursor.

The existing parser already catches only `MalformedProtobufError` while reading
the nested projection. The remaining improvement is to document that boundary
precisely and lock it with a real nested oversized-token regression test.

## Alternatives

### Recommended: structural-only optional recovery

Keep the existing runtime behavior. The optional nested projection returns no
usage only when decoding it raises `MalformedProtobufError`. Semantic token
validation errors continue to fail the record. Add a regression test with a
valid primary usage and an oversized nested usage, and clarify the nearby
comment.

This preserves both valid primary data after damaged optional wire data and
the visibility of an invalid independent usage event.

### Rejected: suppress all nested usage failures

Expanding the catch block around `readUsage()` would preserve the primary usage
after an oversized nested token, but it would silently omit a possibly distinct
event. That violates the collector's strict input and no-silent-degradation
rules.

### Rejected: introduce partial-result diagnostics

A partial-result API could retain valid events while reporting rejected nested
events, but it requires a new diagnostic contract, cursor semantics, and caller
handling. No current consumer requires that broader behavior, so it is out of
scope for this focused hardening task.

## Design

`readOptionalNestedUsageMessage()` remains responsible only for structural
Protobuf recovery. Its comment will explicitly distinguish structural decode
failures from semantic validation failures. `readUsage()` remains outside that
catch boundary and continues to validate every present token field against the
shared maximum.

The test suite will retain the narrow synchronous `Map.prototype.get` seam that
proves unexpected exceptions inside the optional catch block are rethrown. A
new fixture-based test will separately prove that a real nested usage with
`inputTokens` equal to `1_000_000_001` throws the existing invalid-token error,
even when `field 4` is valid.

## Scope Boundaries

- Do not change runtime recovery behavior for semantic errors.
- Do not change reconnect error mapping: the generic final consume failure is
  not normally reachable and mapping it to a client credential error would hide
  D1 or schema invariant failures.
- Do not alter the recorded Node `DEP0205` warning without evidence that it
  originates in repository code.

## Acceptance Criteria

- A truncated `[17, 2]` projection still preserves valid `field 4` usage.
- An unexpected non-structural exception inside the optional projection still
  propagates.
- A nested `[17, 2]` token above the maximum fails with `token field 2 is
  invalid`.
- Targeted collector tests, workspace type checking, the full workspace test
  suite, build, script tests, audit, and `git diff --check` pass.
