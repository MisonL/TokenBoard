import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractStatuslineEvent } from './antigravity-statusline.mjs'

const scriptPath = fileURLToPath(new URL('./antigravity-statusline.mjs', import.meta.url))

test('extracts only sanitized Antigravity statusline usage fields', () => {
  const raw = JSON.stringify(statuslinePayload({
    conversation_id: 'raw-conversation-id',
    cwd: '/Users/example/private',
    email: 'user@example.com'
  }))

  const event = extractStatuslineEvent(raw, '2026-06-23T10:00:00.000Z')

  assert.equal(event.schemaVersion, 'antigravity-statusline/v1')
  assert.equal(event.capturedAt, '2026-06-23T10:00:00.000Z')
  assert.equal(event.model, 'Gemini 3.5 Flash (Medium)')
  assert.equal(event.usage.inputTokens, 100)
  assert.equal(event.usage.outputTokens, 12)
  assert.equal(event.usage.cacheCreationTokens, 3)
  assert.equal(event.usage.cacheReadTokens, 40)
  assert.notEqual(event.conversationHash, 'raw-conversation-id')
  assert.deepEqual(Object.keys(event).sort(), ['capturedAt', 'conversationHash', 'model', 'schemaVersion', 'usage'])
})

test('statusline CLI writes sanitized JSONL and preserves original command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const logPath = join(root, 'events.jsonl')
    await writeFile(originalPath, [
      'let raw = ""',
      'process.stdin.setEncoding("utf8")',
      'process.stdin.on("data", (chunk) => { raw += chunk })',
      'process.stdin.on("end", () => { process.stdout.write("original-statusline") })'
    ].join('\n'))
    await writeFile(backupPath, `${JSON.stringify({ command: `${process.execPath} ${originalPath}` })}\n`)

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--state-dir',
      root,
      '--log-path',
      logPath,
      '--original-command-file',
      backupPath
    ], {
      input: JSON.stringify(statuslinePayload({ conversation_id: 'raw-session-id' })),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'original-statusline')
    const event = JSON.parse(await readFile(logPath, 'utf8'))
    assert.equal(event.schemaVersion, 'antigravity-statusline/v1')
    assert.equal(event.model, 'Gemini 3.5 Flash (Medium)')
    assert.notEqual(event.conversationHash, 'raw-session-id')
    assert.match(event.conversationHash, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(await readFile(logPath, 'utf8'), /raw-session-id|\/Users\/example|user@example\.com/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI records malformed payload errors outside the usage JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const errorPath = join(root, 'errors.log')
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--state-dir',
      root,
      '--log-path',
      logPath,
      '--error-path',
      errorPath
    ], {
      input: '{bad json}',
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    await assert.rejects(readFile(logPath, 'utf8'))
    assert.match(await readFile(errorPath, 'utf8'), /Malformed Antigravity statusline payload/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI defaults missing cache token fields to zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const payload = statuslinePayload({
      context_window: {
        current_usage: {
          input_tokens: 100,
          output_tokens: 12
        }
      }
    })
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--state-dir',
      root,
      '--log-path',
      logPath
    ], {
      input: JSON.stringify(payload),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    const event = JSON.parse(await readFile(logPath, 'utf8'))
    assert.equal(event.usage.cacheCreationTokens, 0)
    assert.equal(event.usage.cacheReadTokens, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI records invalid token values outside the usage JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const errorPath = join(root, 'errors.log')
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--state-dir',
      root,
      '--log-path',
      logPath,
      '--error-path',
      errorPath
    ], {
      input: JSON.stringify(statuslinePayload({
        context_window: {
          current_usage: {
            input_tokens: -1,
            output_tokens: 12,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        }
      })),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    await assert.rejects(readFile(logPath, 'utf8'))
    assert.match(await readFile(errorPath, 'utf8'), /input_tokens must be a bounded nonnegative integer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function statuslinePayload(overrides = {}) {
  return {
    product: 'antigravity',
    version: '1.0.10',
    conversation_id: 'conversation-1',
    cwd: '/Users/example/private',
    email: 'user@example.com',
    model: {
      id: 'Gemini 3.5 Flash (Medium)',
      display_name: 'Gemini 3.5 Flash (Medium)'
    },
    context_window: {
      current_usage: {
        input_tokens: 100,
        output_tokens: 12,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 40
      }
    },
    ...overrides
  }
}
