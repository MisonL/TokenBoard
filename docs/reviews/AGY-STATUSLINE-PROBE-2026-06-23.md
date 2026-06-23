# AGY Status Line Probe - 2026-06-23

## Scope

- Branch: `research/agy-token-support-plan`.
- Purpose: verify whether Antigravity CLI status line JSON can support TokenBoard token snapshots before implementing upload.
- Method: temporarily set `~/.gemini/antigravity-cli/settings.json` `statusLine.command` to a local probe command, run `agy -p` and `agy -c -p`, then restore the original settings file with a shell trap.
- Privacy boundary: probe output stored only sanitized fields. It did not persist raw `cwd`, `workspace`, `email`, `plan_tier`, `transcript_path`, prompt text, completion text, or raw conversation ID.

## Environment

- `agy` path: `/Users/mison/.local/bin/agy`.
- `agy --version`: `1.0.10`.
- Probe directory: `~/.tokenboard/agy-statusline-probe-20260623214831`.
- Settings restoration check: `jq 'has("statusLine")' ~/.gemini/antigravity-cli/settings.json` returned `false` after the probe.

## Samples

### Fresh Conversation 1

- Command shape: `agy -p "Reply with exactly: tokenboard-agy-probe-one"`.
- Captured events: 17.
- Conversation hash: `e22cee90f84744dc`.
- Final observed model: `Gemini 3.5 Flash (Medium)`.
- Final observed state: `working`.
- Final `context_window.total_input_tokens`: 161.
- Final `context_window.total_output_tokens`: 1405.
- Final `context_window.current_usage`: input 22924, output 1399, cache creation 0, cache read 0.

### Fresh Conversation 2 And Resume 1

- Command shape: `agy -p "Reply with exactly: tokenboard-agy-probe-two"`.
- Resume command shape: `agy -c -p "Reply with exactly: tokenboard-agy-probe-resumed"`.
- Shared conversation hash after resume: `d3cd5137369b5241`.
- Captured events for this conversation before the next resume: 20.
- Final observed model: `Gemini 3.5 Flash (Medium)`.
- Distinct totals: `0/0`, `161/1878`, `161/1884`.
- Final `context_window.current_usage`: input 23727, output 1878, cache creation 0, cache read 0.

### Resume 2

- Command shape: `agy -c -p "Reply with exactly: tokenboard-agy-probe-resumed-two"`.
- Conversation hash: `d3cd5137369b5241`.
- Final observed total: input 35429, output 1924.
- Final `context_window.current_usage`: input 26111, output 40, cache creation 0, cache read 0.

### Resume 3

- Command shape: `agy -c -p "Reply with exactly: tokenboard-agy-probe-session-id"`.
- Conversation hash: `d3cd5137369b5241`.
- Observed `session_id` hash matched the conversation hash in this mode.
- Final observed total: input 35568, output 1967.
- Final `context_window.current_usage`: input 5801, output 43, cache creation 0, cache read 20701.

## Interpretation

- `statusLine.command` does run in non-interactive `agy -p` mode.
- The payload includes sensitive fields such as `cwd`, `workspace`, `email`, and `plan_tier` in some states, so the production handler must sanitize before local persistence.
- `context_window.total_input_tokens` and `total_output_tokens` behave like context-window state. They can jump on resumed conversations and are not a clean billable usage delta.
- `context_window.current_usage` changes per generation and includes cache read tokens. It is the best available token usage signal for first-version TokenBoard support.
- Status line events repeat the same `current_usage` tuple across several agent states, so collector logic must dedupe repeated status updates before creating `UsageSnapshot` rows.
- There is no distinct generation ID in the observed sanitized payload. First-version dedupe should count a valid non-null `current_usage` tuple once per conversation/model until the tuple changes, and document the residual risk that two consecutive generations with identical token counts are indistinguishable.

## Gate Decision

Proceed with a forward-only implementation using sanitized status line JSONL and `current_usage` as the token source. Do not use `.db`, `.pb`, `/credits`, `/usage`, or logs for TokenBoard uploads.
