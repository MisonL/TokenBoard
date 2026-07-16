import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildNotifyHandler } from './hooks.mjs'

const backgroundResultTimeoutMs = 5_000
const backgroundResultRetryMs = 25

test('notify handler does not forward payload args to the TokenBoard background process', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT, "--source", source\]/)
  assert.doesNotMatch(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT, "--source", source, \.\.\.payloadArgs\]/)
})

test('notify handler preserves payload source args for the original Codex notify command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const originalScript = join(root, 'original.mjs')
  const backgroundArgsPath = join(root, 'background-args.json')
  const originalArgsPath = join(root, 'original-args.json')

  try {
    await writeFile(backgroundScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(backgroundArgsPath)}, JSON.stringify(process.argv.slice(2)))`
    ].join('\n'))
    await writeFile(originalScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(originalArgsPath)}, JSON.stringify(process.argv.slice(2)))`
    ].join('\n'))
    await writeFile(join(root, 'codex_notify_original.json'), `${JSON.stringify({
      notify: [process.execPath, originalScript]
    })}\n`)
    await writeFile(handlerPath, buildNotifyHandler({
      stateDir: root,
      notifyScriptPath: backgroundScript,
      nodePath: process.execPath
    }))

    const result = spawnSync(process.execPath, [
      handlerPath,
      '--source=codex',
      '--source',
      'payload-source',
      '--payload',
      'value'
    ])

    assert.equal(result.status, 0)
    assert.match(await readFile(join(root, 'notify.signal'), 'utf8'), /"source":"codex"/)
    assert.deepEqual(await readJsonFile(backgroundArgsPath), ['--source', 'codex'])
    assert.deepEqual(await readJsonFile(originalArgsPath), ['--source', 'payload-source', '--payload', 'value'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler records foreground failures for local diagnosis', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /notify-handler-errors\.log/)
  assert.match(source, /recordHandlerError\("enqueue", error\)/)
  assert.match(source, /recordHandlerError\("background", error\)/)
  assert.match(source, /function errorMessage\(error\)/)
  assert.match(source, /function safeErrorString\(value\)/)
  assert.doesNotMatch(source, /: String\(error\)/)
  assert.match(source, /return "Unknown error"/)
})

test('notify handler formats hostile errors without throwing at runtime', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const helperStart = source.indexOf('function errorMessage(error)')
  const helperEnd = source.indexOf('function isMissingFileError(error)')

  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)
  const results = runInNewContext(`
    ${source.slice(helperStart, helperEnd)}
    const hostileError = new Error("failed");
    Object.defineProperties(hostileError, {
      message: { get() { throw new Error("message failed"); } },
      name: { get() { throw new Error("name failed"); } }
    });
    [
      errorMessage(new Error("")),
      errorMessage(Object.create(null)),
      errorMessage({ toString() { throw new Error("toString failed"); } }),
      errorMessage(hostileError)
    ];
  `)

  assert.deepEqual(Array.from(results), ['Error', 'Unknown error', 'Unknown error', 'Unknown error'])
})

test('notify handler records invalid source without enqueueing background work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const backgroundArgsPath = join(root, 'background-args.json')

  try {
    await writeFile(backgroundScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(backgroundArgsPath)}, JSON.stringify(process.argv.slice(2)))`
    ].join('\n'))
    await writeFile(handlerPath, buildNotifyHandler({
      stateDir: root,
      notifyScriptPath: backgroundScript,
      nodePath: process.execPath
    }))

    const result = spawnSync(process.execPath, [handlerPath, '--source=bad-source'])

    assert.equal(result.status, 0)
    await assert.rejects(readFile(join(root, 'notify.signal'), 'utf8'))
    await assert.rejects(readFile(backgroundArgsPath, 'utf8'))
    const log = await readFile(join(root, 'notify-handler-errors.log'), 'utf8')
    assert.match(log, /Unsupported TokenBoard hook source/)
    assert.doesNotMatch(log, /bad-source/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function readJsonFile(path) {
  let lastError
  const deadline = Date.now() + backgroundResultTimeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, backgroundResultRetryMs))
    }
  }
  throw lastError
}
