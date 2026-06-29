import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createAntigravityLanguageServerClient,
  listAntigravityCascades,
  type AntigravityCascadeFileSystem
} from './antigravity-gui-client'

describe('createAntigravityLanguageServerClient', () => {
  test.skipIf(process.platform === 'win32')('closes the language server process when startup times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ls-'))
    const previousTimeout = process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS
    const previousPidFile = process.env.TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE
    try {
      const serverPath = join(root, 'server.mjs')
      const pidPath = join(root, 'server.pid')
      await writeFile(serverPath, [
        '#!/bin/sh',
        'printf "%s" "$$" > "$TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE"',
        'while :; do sleep 1; done'
      ].join('\n'))
      await chmod(serverPath, 0o700)
      process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS = '500'
      process.env.TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE = pidPath

      const client = createAntigravityLanguageServerClient({
        source: 'antigravity',
        languageServerPath: serverPath
      })
      const timeoutAssertion = expect(client).rejects.toThrow('Timed out starting Antigravity language server')
      const pid = await readPid(pidPath)

      await timeoutAssertion
      await expectProcessExited(pid)
    } finally {
      restoreEnv('TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS', previousTimeout)
      restoreEnv('TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE', previousPidFile)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('listAntigravityCascades', () => {
  test('selects newest requestable cascades before applying the limit', async () => {
    const statPaths: string[] = []
    const mtimes = new Map([
      [cascadeId(0), 100],
      [cascadeId(1), 300],
      [cascadeId(2), 200]
    ])
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function * () {
        for (const index of [0, 2, 1]) {
          const name = `${cascadeId(index)}.pb`
          yield {
            name,
            isFile: () => true
          }
        }
      },
      stat: async (path) => {
        statPaths.push(path)
        if (path.endsWith('.db')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        return { mtimeMs: mtimes.get(id ?? '') ?? 0, size: 20 }
      }
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-cascades',
      limit: 2,
      fileSystem
    })

    expect(cascades.map((cascade) => cascade.id)).toEqual([cascadeId(1), cascadeId(2)])
    expect(statPaths.some((path) => path.includes(cascadeId(0)))).toBe(true)
    expect(statPaths.some((path) => path.includes(cascadeId(1)))).toBe(true)
    expect(statPaths.some((path) => path.includes(cascadeId(2)))).toBe(true)
  })
})

async function readPid(path: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return Number(await readFile(path, 'utf8'))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Expected test language server to write a pid file')
}

async function expectProcessExited(pid: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
  throw new Error(`Expected process ${pid} to exit`)
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function cascadeId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}
