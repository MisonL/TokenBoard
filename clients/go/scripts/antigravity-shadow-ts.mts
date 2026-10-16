// Runs the TS Antigravity history reader once over a fixture directory and
// writes the events as JSON, for the Go shadow diff. TB_MAX_DB bounds the
// per-run database budget, matching the Go harness's TB_MAX_DB.
// Run with: npx tsx scripts/antigravity-shadow-ts.mts <root>
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAntigravityDbUsageEvents } from '../../../packages/collector/src/providers/antigravity-history-db.ts'

const root = process.argv[2]
if (!root) {
  console.error('usage: tsx scripts/antigravity-shadow-ts.mts <root>')
  process.exit(2)
}

const maxDbFiles = process.env.TB_MAX_DB ? Number(process.env.TB_MAX_DB) : null
const result = await readAntigravityDbUsageEvents({
  conversationDir: join(root, 'conversations'),
  maxDbFiles,
  requireCompleteDirectoryScan: maxDbFiles === null
})

const events = result.events.map((event) => ({
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
}))

writeFileSync(
  join(root, maxDbFiles === null ? 'ts-events.json' : 'ts-events-bounded.json'),
  JSON.stringify(
    {
      events,
      lastReadRowIndexByCascade: Object.fromEntries(result.lastReadRowIndexByCascade ?? []),
      knownCascadeIds: [...(result.knownCascadeIds ?? [])].sort(),
      completeDirectoryScan: result.completeDirectoryScan
    },
    null,
    2
  )
)
console.log(`wrote ${events.length} events`)
