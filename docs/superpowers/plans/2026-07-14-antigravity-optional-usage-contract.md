# Antigravity Optional Usage Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the structural-versus-semantic optional usage boundary explicit and protect it with a fixture-based regression test.

**Architecture:** The parser keeps its existing runtime behavior: malformed nested Protobuf structure is optional, while decoded token values still obey the shared strict validation limit. The change adds no new recovery path or public API. It documents the narrow catch boundary and tests a real nested semantic failure.

**Tech Stack:** TypeScript, Vitest, Node.js, pnpm workspace tooling.

---

### Task 1: Lock the nested usage validation boundary

**Files:**
- Modify: `packages/collector/src/providers/antigravity-history-protobuf.ts:88-95`
- Modify: `packages/collector/src/providers/antigravity-history-protobuf.test.ts:101-158`

- [ ] **Step 1: Add the fixture-based semantic failure regression test**

Insert this test after the truncated nested usage test. It uses the existing
`message`, `fieldMessage`, `usageMessage`, and `fieldString` fixtures.

```ts
test('rejects an oversized token in an optional nested usage block', () => {
  const blob = message([
    fieldMessage(1, message([
      fieldMessage(4, usageMessage({
        inputTokens: 10,
        outputTokens: 2,
        responseId: 'response-primary'
      })),
      fieldMessage(17, message([
        fieldMessage(2, usageMessage({
          inputTokens: 1_000_000_001,
          responseId: 'response-nested'
        }))
      ])),
      fieldString(19, 'gemini-3-flash-a')
    ])),
    fieldString(4, 'execution-a')
  ])

  expect(() => parseAntigravityGeneratorMetadataBlobEvents(blob, {
    cascadeId: 'conversation-a',
    rowIndex: 0,
    fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
  })).toThrow('token field 2 is invalid')
})
```

- [ ] **Step 2: Run the targeted test before documentation-only code change**

Run:

```bash
pnpm --filter @tokenboard/collector test -- src/providers/antigravity-history-protobuf.test.ts
```

Expected: PASS. The runtime behavior is deliberately already strict; this is a
characterization regression test, not a new behavior change.

- [ ] **Step 3: Clarify the optional recovery comment**

Replace the comment in `readOptionalNestedUsageMessage()` with:

```ts
// Only malformed optional wire data may be ignored; semantic validation errors must propagate.
```

Do not expand the `try/catch` block to include `readUsage()`.

- [ ] **Step 4: Re-run targeted collector validation**

Run:

```bash
pnpm --filter @tokenboard/collector test -- src/providers/antigravity-history-protobuf.test.ts
pnpm --filter @tokenboard/collector typecheck
```

Expected: all targeted tests and collector type checking pass.

- [ ] **Step 5: Run repository quality gates**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
node --test skills/tokenboard/scripts/*.test.mjs
pnpm audit --audit-level=high
git diff --check
```

Expected: every command exits with status 0 and `git diff --check` emits no
output.

- [ ] **Step 6: Commit the focused implementation**

```bash
git add packages/collector/src/providers/antigravity-history-protobuf.ts \
  packages/collector/src/providers/antigravity-history-protobuf.test.ts \
  docs/superpowers/plans/2026-07-14-antigravity-optional-usage-contract.md
git commit -m "test(collector): lock nested usage validation boundary"
```

Expected: one commit containing only the parser comment, regression test, and
implementation plan.
