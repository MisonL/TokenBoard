// Builds a fixture conversations directory for the Antigravity shadow diff.
// Run with: npx tsx scripts/antigravity-fixture.mts
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: tsx scripts/antigravity-fixture.mts <root>')
  process.exit(2)
}

function varint(value: number) {
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 128) {
    bytes.push((remaining & 127) | 128)
    remaining = Math.floor(remaining / 128)
  }
  bytes.push(remaining)
  return Buffer.from(bytes)
}

function tag(field: number, wireType: number) {
  return varint(field * 8 + wireType)
}

function fieldVarint(field: number, value: number) {
  return Buffer.concat([tag(field, 0), varint(value)])
}

function fieldString(field: number, value: string) {
  const bytes = Buffer.from(value)
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes])
}

function fieldMessage(field: number, value: Buffer) {
  return Buffer.concat([tag(field, 2), varint(value.length), value])
}

function message(fields: Buffer[]) {
  return Buffer.concat(fields)
}

function usageMessage(input: {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  thinkingOutputTokens?: number
  responseOutputTokens?: number
  responseId?: string
}) {
  return message([
    fieldVarint(2, input.inputTokens),
    ...(input.outputTokens !== undefined ? [fieldVarint(3, input.outputTokens)] : []),
    ...(input.cacheReadTokens ? [fieldVarint(5, input.cacheReadTokens)] : []),
    ...(input.thinkingOutputTokens ? [fieldVarint(9, input.thinkingOutputTokens)] : []),
    ...(input.responseOutputTokens ? [fieldVarint(10, input.responseOutputTokens)] : []),
    ...(input.responseId ? [fieldString(11, input.responseId)] : [])
  ])
}

function timestampMessage(seconds: number, nanos: number) {
  return message([fieldVarint(1, seconds), ...(nanos ? [fieldVarint(2, nanos)] : [])])
}

function blob(input: {
  executionId?: string
  model?: string
  displayModel?: string
  timestampSeconds: number
  timestampNanos?: number
  usage: {
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    thinkingOutputTokens?: number
    responseOutputTokens?: number
    responseId?: string
  }
  nestedUsage?: {
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    thinkingOutputTokens?: number
    responseOutputTokens?: number
    responseId?: string
  }
}) {
  const chatModel = [
    fieldVarint(3, 1132),
    fieldMessage(4, usageMessage(input.usage)),
    fieldMessage(9, message([fieldMessage(4, timestampMessage(input.timestampSeconds, input.timestampNanos ?? 0))])),
    ...(input.model ? [fieldString(19, input.model)] : []),
    ...(input.displayModel ? [fieldString(21, input.displayModel)] : [])
  ]
  if (input.nestedUsage) {
    chatModel.push(fieldMessage(17, message([fieldMessage(2, usageMessage(input.nestedUsage))])))
  }
  return message([
    fieldMessage(1, message(chatModel)),
    ...(input.executionId ? [fieldString(4, input.executionId)] : [])
  ])
}

const dir = join(root, 'conversations')
await mkdir(dir, { recursive: true })

// The shapes the TS tests pin: a resolved model with a display alias, a
// placeholder-only model, sparse usage (no output), a duplicate nested block,
// a truncated/empty blob, and a null blob.
const rows: Record<number, Buffer[]> = {
  1: [
    blob({
      executionId: 'execution-a',
      model: 'gemini-3-flash-a',
      displayModel: 'Gemini 3.5 Flash (High)',
      timestampSeconds: 1_782_229_139,
      timestampNanos: 863_115_000,
      usage: {
        inputTokens: 25_908,
        outputTokens: 551,
        cacheReadTokens: 24_454,
        thinkingOutputTokens: 502,
        responseOutputTokens: 49,
        responseId: 'response-a'
      },
      nestedUsage: {
        inputTokens: 25_908,
        outputTokens: 551,
        cacheReadTokens: 24_454,
        thinkingOutputTokens: 502,
        responseOutputTokens: 49,
        responseId: 'response-a'
      }
    })
  ],
  2: [
    blob({
      executionId: 'execution-b',
      model: 'MODEL_PLACEHOLDER_abc123',
      timestampSeconds: 1_782_229_140,
      timestampNanos: 1,
      usage: { inputTokens: 10, outputTokens: 2, responseId: 'response-b' }
    })
  ],
  3: [
    // Sparse: no output tokens at all.
    blob({
      executionId: 'execution-c',
      model: 'gemini-3-pro',
      timestampSeconds: 1_782_229_141,
      usage: { inputTokens: 7, responseId: 'response-c' }
    }),
    blob({
      executionId: 'execution-d',
      model: 'gemini-3-pro',
      displayModel: 'Gemini 3 Pro',
      timestampSeconds: 1_782_229_142,
      timestampNanos: 999_999_999,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        responseId: 'response-d'
      }
    })
  ],
  4: [Buffer.alloc(0), null as unknown as Buffer, Buffer.from('0A020801', 'hex')],
  5: []
}

for (const [index, rowList] of Object.entries(rows)) {
  const dbPath = join(dir, `00000000-0000-0000-0000-${String(index).padStart(12, '0')}.db`)
  const seed = new DatabaseSync(dbPath)
  seed.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);')
  const insert = seed.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
  for (let rowIndex = 0; rowIndex < rowList.length; rowIndex++) {
    const row = rowList[rowIndex]
    if (row === null) {
      insert.run(rowIndex + 1, null)
    } else {
      insert.run(rowIndex + 1, new Uint8Array(row))
    }
  }
  seed.close()
}

// A database whose name does not match the cascade-id pattern must be ignored.
const ignored = new DatabaseSync(join(dir, 'not-a-cascade-id.db'))
ignored.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);')
ignored.close()

// A non-database file alongside them.
await writeFile(join(dir, 'README.txt'), 'not a database')

console.log('fixture written to', dir)
