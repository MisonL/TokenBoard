import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import test from 'node:test'
import { buildInstallCollectorArgs } from './setup-options.mjs'

test('passes setup repo-url override to install collector', () => {
  assert.deepEqual(
    buildInstallCollectorArgs({
      flags: { 'repo-url': 'https://github.com/example/TokenBoard.git' },
      packageManager: 'pnpm',
      installCollectorScript: '/repo/scripts/install-collector.mjs'
    }),
    [
      '/repo/scripts/install-collector.mjs',
      '--repo-url',
      'https://github.com/example/TokenBoard.git',
      '--package-manager',
      'pnpm'
    ]
  )
})

test('setup installs hooks only after initial sync succeeds', () => {
  const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8')
  const syncIndex = source.indexOf("scriptPath('./sync.mjs')")
  const hookIndex = source.indexOf("scriptPath('./install-hook.mjs')")

  assert.notEqual(syncIndex, -1)
  assert.notEqual(hookIndex, -1)
  assert.ok(syncIndex < hookIndex)
})

test('setup activates an existing server profile without pairing again', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-existing-profile-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://private.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'prod-token'
          },
          'https://private.example.com': {
            endpoint: 'https://private.example.com/api/v1/ingest',
            uploadToken: 'private-token'
          }
        },
        endpoint: 'https://private.example.com/api/v1/ingest',
        uploadToken: 'private-token'
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(config.activeServer, 'https://prod.example.com')
    assert.equal(config.endpoint, 'https://prod.example.com/api/v1/ingest')
    assert.equal(config.uploadToken, 'prod-token')
    assert.equal(config.servers['https://private.example.com'].uploadToken, 'private-token')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup refuses a plain-http base URL before any credential is sent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-insecure-base-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'http://tokenboard.example.com',
        '--pairing-code',
        'tb_pair_probe',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must use https/)
    // A refused flag is an operator mistake, not a crash: the message must be
    // the script's own one-liner, not an uncaught exception with a stack trace.
    assert.doesNotMatch(result.stderr, /^\s+at /m, 'no stack trace expected')
    // Nothing was written: the refusal happens before pairing.
    assert.equal(existsSync(join(directory, 'config.json')), false, 'no config expected')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup applies explicit install flags without dropping saved profile defaults', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-profile-options-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'prod-token',
            repoUrl: 'https://github.com/example/private.git',
            repoRef: 'release-branch',
            packageManager: 'bun',
            scheduleTimes: ['07:15', '19:45']
          }
        }
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--repo-ref',
        'override-branch',
        '--schedule-times',
        '08:30,20:30',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(config.repoUrl, 'https://github.com/example/private.git')
    assert.equal(config.repoRef, 'override-branch')
    assert.equal(config.packageManager, 'bun')
    assert.deepEqual(config.scheduleTimes, ['08:30', '20:30'])
    assert.equal(config.servers['https://prod.example.com'].repoRef, 'override-branch')
    assert.deepEqual(config.servers['https://prod.example.com'].scheduleTimes, ['08:30', '20:30'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup reports saved profile activation failures without an uncaught stack', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-profile-error-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'prod-token',
            scheduleTimes: ['not-a-time']
          }
        }
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'Invalid schedule time: not-a-time. Expected HH:MM in 24-hour format.\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup activates the profile read after acquiring the credentials lock', () => {
  const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8')
  const lockBody = source.slice(
    source.indexOf('withSetupCredentialsLock(() => {'),
    source.indexOf("console.log('TokenBoard server profile activated.')")
  )

  assert.match(lockBody, /const latestProfile = reusableServerProfile\(latestConfig, serverOrigin\)/)
  assert.match(lockBody, /withServerProfile\(latestConfig, serverOrigin, \{/)
  assert.doesNotMatch(lockBody, /withServerProfile\(latestConfig, serverOrigin, savedProfile\)/)
})

test('setup honors explicit device-link reconnect over an existing server profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-device-link-priority-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'revoked-token'
          }
        },
        endpoint: 'https://prod.example.com/api/v1/ingest',
        uploadToken: 'revoked-token'
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--use-device-link',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /TokenBoard device link not found/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Pairing consumes the pairing code, so a release flag that will be refused must be
// refused before setup posts to /api/v1/device/pair — otherwise the retry fails on a
// code that is already spent.
test('setup refuses a bad release flag before it pairs the device', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-release-preflight-'))
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    response.setHeader('content-type', 'application/json')
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const env = { PATH: process.env.PATH, TOKENBOARD_CONFIG_DIR: directory }
  const runSetup = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      child.stdout.on('data', () => {})
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('close', (status) => resolve({ status, stderr }))
    })
  try {
    const baseUrl = `http://127.0.0.1:${port}`
    const malformed = await runSetup([
      '--base-url',
      baseUrl,
      '--pairing-code',
      'tb_pair_preflight',
      '--client',
      'binary',
      '--release-tag'
    ])
    assert.equal(malformed.status, 1)
    assert.match(malformed.stderr, /--release-tag requires a value/)

    const wrongClient = await runSetup([
      '--base-url',
      baseUrl,
      '--pairing-code',
      'tb_pair_preflight',
      '--client',
      'git',
      '--release-tag',
      'v1.0.0'
    ])
    assert.equal(wrongClient.status, 1)
    assert.match(wrongClient.stderr, /only to the binary client/)
    assert.match(wrongClient.stderr, /--client binary/)

    assert.equal(requests, 0)
    assert.equal(existsSync(join(directory, 'config.json')), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})

function runSetupCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status) => resolve({ status, stderr }))
  })
}

// The client type that matters is the one this run installs for: the reused profile of
// the *target* server. Judging by the active profile refused a valid binary install on a
// second server whose active server runs the git client.
test('setup judges release flags by the target server profile, not the active one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-target-client-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://git.example.com',
        servers: {
          'https://git.example.com': {
            endpoint: 'https://git.example.com/api/v1/ingest',
            uploadToken: 'git-token',
            clientType: 'git'
          },
          'https://binary.example.com': {
            endpoint: 'https://binary.example.com/api/v1/ingest',
            uploadToken: 'binary-token',
            clientType: 'binary'
          }
        }
      })
    )
    const result = await runSetupCli(
      ['--base-url', 'https://binary.example.com', '--release-repo', 'mirror/TokenBoard', '--skip-collector'],
      { PATH: process.env.PATH, TOKENBOARD_CONFIG_DIR: directory }
    )
    // The run may still fail later (the target profile's binary is not installed and
    // --skip-collector leaves it that way); what matters here is that the preflight did
    // not refuse and the profile was activated.
    assert.doesNotMatch(result.stderr, /only to the binary client/)
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(config.activeServer, 'https://binary.example.com')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// With no reusable profile for the target server the install will be a git one (unless a
// flag says otherwise), so a release flag has to be refused before pairing — even when
// another configured server runs the binary client.
test('setup refuses release flags for a new server before pairing, regardless of the active client', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-new-server-client-'))
  writeFileSync(
    join(directory, 'config.json'),
    JSON.stringify({
      activeServer: 'https://binary.example.com',
      servers: {
        'https://binary.example.com': {
          endpoint: 'https://binary.example.com/api/v1/ingest',
          uploadToken: 'binary-token',
          clientType: 'binary'
        }
      }
    })
  )
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    response.setHeader('content-type', 'application/json')
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await runSetupCli(
      ['--base-url', `http://127.0.0.1:${port}`, '--pairing-code', 'tb_pair_new_server', '--release-tag', 'v1.0.0'],
      { PATH: process.env.PATH, TOKENBOARD_CONFIG_DIR: directory }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /only to the binary client/)
    assert.equal(requests, 0)
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.deepEqual(Object.keys(config.servers), ['https://binary.example.com'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
