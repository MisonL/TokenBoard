import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { isSkippedOversizedSessionJsonlLine, readSessionJsonlLines } from './session-jsonl-line-reader'

describe('readSessionJsonlLines', () => {
  test('preserves LF, CRLF, and CR JSONL separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'separators.jsonl')

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, '{"type":"session_meta"}\n{"type":"summary"}\r\n{"type":"progress"}\r')

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toEqual(['{"type":"session_meta"}', '{"type":"summary"}', '{"type":"progress"}'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects invalid UTF-8 before a short JSONL row can be decoded with replacement characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'invalid-short-utf8.jsonl')
    const malformed = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n')
    ])

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, malformed)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains invalid UTF-8')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('yields a bounded skip marker for a non-usage line and continues with later records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: { text: 'x'.repeat(512) }
    })
    const later = JSON.stringify({ type: 'session_meta' })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n${later}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(2)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
      expect(isSkippedOversizedSessionJsonlLine(lines[0]) && lines[0].byteLength).toBe(Buffer.byteLength(oversized))
      expect(lines[1]).toBe(later)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recognizes a known non-usage record type after an oversized content field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'late-type.jsonl')
    const oversized = `{"payload":{"text":"${'x'.repeat(512)}"},"type":"response_item"}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips a known non-usage record with a valid oversized irrelevant key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-key.jsonl')
    const oversized = JSON.stringify({
      ['x'.repeat(512)]: 'irrelevant',
      type: 'response_item'
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('still detects usage metadata after a valid oversized irrelevant key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-key-with-usage.jsonl')
    const oversized = JSON.stringify({
      ['x'.repeat(512)]: 'irrelevant',
      type: 'event_msg',
      payload: { info: { last_token_usage: { input_tokens: 1 } } }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024,
          source: 'codex'
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when usage metadata appears after the in-memory line limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'usage-after-limit.jsonl')
    const oversized = JSON.stringify({
      type: 'event_msg',
      padding: 'x'.repeat(128 * 1024),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1 } }
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips a non-metric usage string without treating it as an upload usage object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'usage-string.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: {
        usage: 'render diagnostics only',
        text: 'x'.repeat(512)
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not treat token-shaped text inside a large content string as metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'token-text.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: {
        text: `${'x'.repeat(256)} {"usage":{"input_tokens":1}} ${'y'.repeat(256)}`
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when an oversized usage object is split across stream chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'usage-object.jsonl')
    const oversized = `{"type":"assistant","padding":"${'x'.repeat(128 * 1024)}","usage" : {"input_tokens":1}}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails for an oversized empty usage object because the parser treats it as a metric row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'empty-usage.jsonl')
    const oversized = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-22T02:00:00.000Z',
      padding: 'x'.repeat(128 * 1024),
      usage: {}
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024,
          source: 'claude-code'
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips an oversized Codex row with token fields outside the usage object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'unparsed-token.jsonl')
    const oversized = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        padding: 'x'.repeat(128 * 1024),
        unrelated: { input_tokens: 1 }
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 256 * 1024,
        source: 'codex'
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails for an oversized Codex row with payload-level total usage metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'payload-total-usage.jsonl')
    const oversized = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        total_token_usage: { input_tokens: 1, total_tokens: 1 },
        padding: 'x'.repeat(128 * 1024)
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024,
          source: 'codex'
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip a malformed oversized row after the line limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'malformed.jsonl')
    const malformed = `{"type":"response_item","payload":"${'x'.repeat(512)}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with a trailing comma', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'trailing-comma.jsonl')
    const malformed = `{"type":"response_item","payload":{"text":"${'x'.repeat(512)}"},}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with a trailing comma after a scalar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'scalar-trailing-comma.jsonl')
    const malformed = `{"type":"response_item","payload":"${'x'.repeat(512)}","count":1,}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with a trailing comma in an array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'array-trailing-comma.jsonl')
    const malformed = `{"type":"response_item","payload":["${'x'.repeat(512)}",]}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips an oversized row with valid scalar fields after a comma', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'scalar-fields.jsonl')
    const oversized = `{"type":"response_item","payload":"${'x'.repeat(512)}","count":1,"next":2}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips an oversized known record with valid multibyte UTF-8 content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'utf8.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: `${'x'.repeat(512)}${String.fromCodePoint(0x4e2d)}`
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with invalid UTF-8 content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'invalid-utf8.jsonl')
    const malformed = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":"'),
      Buffer.from('x'.repeat(512)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n')
    ])

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, malformed)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the final root type value when an oversized record repeats the type key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'repeated-type.jsonl')
    const unknownFinalType = `{"type":"response_item","payload":"${'x'.repeat(512)}","type":1}`
    const knownFinalType = `{"type":"unknown_record","payload":"${'x'.repeat(512)}","type":"response_item"}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${unknownFinalType}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with an unknown record type')

      await writeFile(filePath, `${knownFinalType}\n`)
      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('caps discarded non-usage line scanning without retaining the full row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'discard-limit.jsonl')

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'response_item',
          payload: { text: 'x'.repeat(65) }
        })}\n`
      )

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 32,
          maxDiscardedLineBytes: 64
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a non-usage line exceeding the 64-byte discard limit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Claude Code writes `attachment` rows for hook output, listings and queued prompts. They carry
  // no usage, but a queued command can embed base64 images and push one row past the in-memory
  // line limit. Left off the discard list, that single row fails the whole source: a 1.1 MB
  // `attachment` row stopped every claude-code hook sync for a week.
  test('skips an oversized attachment row that carries no usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-attachment.jsonl')
    const oversized = JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'x'.repeat(512) }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `attachment.usage` is a subagent task summary ({totalTokens, toolUses, durationMs}), not an
  // uploadable usage object. Only a root-level `usage` is a metric row, so an oversized
  // attachment carrying this nested object must still be skipped rather than parsed as usage.
  test('skips an oversized attachment row whose nested usage is a task summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-attachment-usage.jsonl')
    const oversized = JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        usage: { totalTokens: 493090, toolUses: 199, durationMs: 2164518 },
        prompt: 'x'.repeat(512)
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `result` rows carry a subagent result key and no usage or message. Same shape of risk as
  // `attachment`: invisible until one grows past the limit, then fatal for the whole source.
  test('skips an oversized result row that carries no usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-result.jsonl')
    const oversized = JSON.stringify({
      type: 'result',
      key: 'v2:abc',
      agentId: 'a1ba4da2eec27c917',
      result: 'x'.repeat(512)
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Being on the discard list must not make a type's rows blanket-trusted: the list says the
  // *type* is not a metric row, but usage in a shape the parser actually reads still makes the
  // row billable. `readClaudeMetric` reads `record.message.usage`, so an oversized `attachment`
  // carrying one is a real usage row past the in-memory limit and must fail loudly. Both shapes
  // the parser reads are pinned — a `message.usage`-only exemption would let usage vanish.
  for (const usageLocation of ['root', 'message'] as const) {
    test(`fails closed on an oversized attachment row with usage under ${usageLocation}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
      const filePath = join(root, 'sessions', `oversized-attachment-usage-${usageLocation}.jsonl`)
      const oversized = JSON.stringify({
        type: 'attachment',
        ...(usageLocation === 'root' ? { usage: { input_tokens: 10, output_tokens: 5 } } : {}),
        ...(usageLocation === 'message' ? { message: { usage: { input_tokens: 10, output_tokens: 5 } } } : {}),
        attachment: { prompt: 'x'.repeat(512) }
      })

      try {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, `${oversized}\n`)

        await expect(async () => {
          for await (const _line of readSessionJsonlLines({
            filePath,
            startOffsetBytes: 0,
            source: 'claude-code',
            maxLineBytes: 64,
            maxDiscardedLineBytes: 1024
          })) {
          }
        }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test('does not silently skip an oversized row with an unknown record type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'unknown-type.jsonl')

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'unknown_record',
          payload: { text: 'x'.repeat(512) }
        })}\n`
      )

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with an unknown record type')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
