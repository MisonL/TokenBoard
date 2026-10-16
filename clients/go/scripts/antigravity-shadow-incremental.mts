// Runs the TS Antigravity history reader across three carried-state phases so
// the incremental cursor/anchor path can be diffed against the Go side. Each
// appending phase first adds one row to the freshest *processed* database
// (cascade ...0005 in the fixture), then reads with the previous phase's state.
// Phase "reset" instead deletes the acknowledged row and records the error the
// fail-closed anchor check throws.
// Run with: npx tsx scripts/antigravity-shadow-incremental.mts <root> <first|second|third|reset>
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readAntigravityDbUsageEvents } from '../../../packages/collector/src/providers/antigravity-history-db.ts'

const root = process.argv[2]
const phase = process.argv[3] ?? 'all'
if (!root) {
  console.error('usage: tsx scripts/antigravity-shadow-incremental.mts <root> <first|second|third|reset>')
  process.exit(2)
}
const dir = join(root, 'conversations')
const phaseOrder = ['first', 'second', 'third'] as const

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

function fieldMessage(fieldNumber: number, value: Buffer) {
  return Buffer.concat([varint(fieldNumber * 8 + 2), varint(value.length), value])
}

function fieldVarint(fieldNumber: number, value: number) {
  return Buffer.concat([varint(fieldNumber * 8), varint(value)])
}

function fieldString(fieldNumber: number, value: string) {
  return fieldMessage(fieldNumber, Buffer.from(value))
}

function message(fields: Buffer[]) {
  return Buffer.concat(fields)
}

// A deterministic valid blob for the row an appending phase adds.
function appendedBlob(rowIndex: number) {
  const usage = message([
    fieldVarint(2, 100 * rowIndex + 21),
    fieldVarint(3, 10 * rowIndex + 5),
    fieldVarint(5, 7 * rowIndex),
    fieldString(11, `response-${rowIndex}`)
  ])
  const chatModel = message([
    fieldVarint(3, 1132),
    fieldMessage(4, usage),
    fieldMessage(9, message([fieldMessage(4, message([fieldVarint(1, 1_782_229_140 + rowIndex)]))])),
    fieldString(19, 'gemini-3-pro'),
    fieldString(21, 'Gemini 3 Pro')
  ])
  return message([fieldMessage(1, chatModel), fieldString(4, `execution-row-${rowIndex}`)])
}

function appendRow() {
  const db = new DatabaseSync(join(dir, '00000000-0000-0000-0000-000000000005.db'))
  const next = (
    db.prepare('SELECT COALESCE(MAX(idx), 0) + 1 AS next FROM gen_metadata').get() as {
      next: number
    }
  ).next
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(next, new Uint8Array(appendedBlob(next)))
  db.close()
  return next
}

function removeLastRow() {
  const db = new DatabaseSync(join(dir, '00000000-0000-0000-0000-000000000005.db'))
  db.exec('DELETE FROM gen_metadata WHERE idx = (SELECT MAX(idx) FROM gen_metadata)')
  db.close()
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function run(state: {
  lastSeenRowIndexByCascadeHash: Map<string, number>
  scanState: { nextSequence: number; files: Record<string, unknown> }
  detectRowCursorReset: boolean
}) {
  return readAntigravityDbUsageEvents({
    conversationDir: dir,
    maxDbFiles: 2,
    lastSeenRowIndexByCascadeHash: state.lastSeenRowIndexByCascadeHash,
    scanState: state.scanState as never,
    detectRowCursorReset: state.detectRowCursorReset
  })
}

function statePathOf(target: string) {
  return join(root, `ts-incremental-state-${target}.json`)
}

function loadCarriedState() {
  const previous =
    phase === 'reset' ? 'third' : phaseOrder[phaseOrder.indexOf(phase as (typeof phaseOrder)[number]) - 1]
  if (!previous) {
    return { lastSeenRowIndexByCascadeHash: [], scanState: { nextSequence: 0, files: {} } }
  }
  return JSON.parse(readFileSync(statePathOf(previous), 'utf8')) as {
    lastSeenRowIndexByCascadeHash: [string, number][]
    scanState: unknown
  }
}

if (phase === 'second' || phase === 'third') appendRow()
if (phase === 'reset') removeLastRow()

const state = loadCarriedState()
const runState = {
  lastSeenRowIndexByCascadeHash: new Map(state.lastSeenRowIndexByCascadeHash),
  scanState: state.scanState as { nextSequence: number; files: Record<string, unknown> },
  detectRowCursorReset: (state.lastSeenRowIndexByCascadeHash?.length ?? 0) > 0
}

try {
  const result = await run(runState)
  const summary = {
    events: result.events.map((event) => ({
      cascadeHash: event.cascadeHash,
      cascadeHashAliases: event.cascadeHashAliases ?? [],
      eventHash: event.eventHash,
      createdAt: event.createdAt,
      model: event.model,
      modelAliases: event.modelAliases ?? [],
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cacheReadTokens: event.cacheReadTokens
    })),
    lastReadRowIndexByCascade: Object.fromEntries(result.lastReadRowIndexByCascade ?? []),
    knownCascadeIds: [...(result.knownCascadeIds ?? [])].sort(),
    completeDirectoryScan: result.completeDirectoryScan
  }
  // Both phases persist the carried state, so the Go run can consume exactly
  // what TS left behind and the two sides' states can be compared in full.
  writeFileSync(join(root, `ts-incremental-${phase}.json`), JSON.stringify(summary, null, 2))
  writeFileSync(
    statePathOf(phase),
    JSON.stringify({
      // Sorted so the file can be diffed against the Go harness, which sorts
      // its map iteration.
      lastSeenRowIndexByCascadeHash: [...(result.lastReadRowIndexByCascade ?? new Map())]
        .map(([id, row]) => [hash(id), row])
        .sort(([left], [right]) => (left as string).localeCompare(right as string)),
      scanState: runState.scanState
    })
  )
  console.log(`phase ${phase}: wrote ${summary.events.length} events`)
} catch (error) {
  writeFileSync(
    join(root, `ts-incremental-${phase}.json`),
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)
  )
  console.log(`phase ${phase}: threw ${error instanceof Error ? error.message : String(error)}`)
}
