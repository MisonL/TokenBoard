import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexSubagentUsageWorkerPool } from './codex-subagent-usage-worker-pool'

// The pool close path must terminate every worker thread; a run whose collectors all
// finish should never leave live worker threads behind to hold the process open.
describe('codex subagent usage worker pool close', () => {
  test('terminates all workers so a finished run can exit', async () => {
    const pool = createCodexSubagentUsageWorkerPool(2)
    const stateDir = mkdtempSync(join(tmpdir(), 'tb-pool-'))
    // Run one real task so the worker spins up and imports its child module; the missing
    // file surfaces as a rejection from the child, which is the point — the task went
    // through the real worker round trip.
    await expect(pool.read(join(stateDir, 'missing.jsonl'), '2026-10-14T00:00:00Z', 'Asia/Shanghai')).rejects.toThrow(
      /ENOENT|no such file/i
    )
    await pool.close()
  })
})
