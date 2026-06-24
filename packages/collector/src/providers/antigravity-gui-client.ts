import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { AntigravityGuiSource } from './antigravity-gui'

const defaultLanguageServerPath = '/Applications/Antigravity.app/Contents/Resources/bin/language_server'
const apiServerUrl = 'https://generativelanguage.googleapis.com'
const cloudCodeEndpoint = 'https://daily-cloudcode-pa.googleapis.com'
const readyTimeoutMs = 30_000
const requestTimeoutMs = 60_000
const cascadeIdPattern = /^[0-9a-fA-F-]{8,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{12,}$/
type LanguageServerProcess = ChildProcessByStdio<null, Readable, Readable>

export type AntigravityGeneratorMetadataRequest = {
  source: AntigravityGuiSource
  cascadeId: string
}

export type AntigravityLanguageServerClient = {
  requestGeneratorMetadata: (input: AntigravityGeneratorMetadataRequest) => Promise<unknown>
  close: () => Promise<void>
}

export async function listAntigravityCascadeIds(input: {
  source: AntigravityGuiSource
  conversationDir?: string
}) {
  const dir = input.conversationDir ?? defaultConversationDir(input.source)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity conversations directory not found: ${dir}`)
    }
    throw error
  }

  const ids = entries
    .filter((entry) => entry.isFile())
    .map((entry) => cascadeIdFromFile(entry.name))
    .filter((id): id is string => Boolean(id))
    .sort()

  if (ids.length === 0) {
    throw new Error(`No Antigravity conversations found in ${dir}`)
  }
  return ids
}

export async function createAntigravityLanguageServerClient(input: {
  source: AntigravityGuiSource
  languageServerPath?: string
  overrideIdeVersion?: string
  port?: number
}): Promise<AntigravityLanguageServerClient> {
  const port = input.port ?? await allocatePort()
  const csrfToken = randomBytes(16).toString('hex')
  const server = spawnLanguageServer({ ...input, port, csrfToken })
  await waitForReady(server, port)
  return {
    requestGeneratorMetadata: (requestInput) => requestGeneratorMetadata({ ...requestInput, port, csrfToken }),
    close: () => closeLanguageServer(server)
  }
}

function spawnLanguageServer(input: {
  source: AntigravityGuiSource
  languageServerPath?: string
  overrideIdeVersion?: string
  port: number
  csrfToken: string
}) {
  const languageServerPath = input.languageServerPath ?? process.env.TOKENBOARD_ANTIGRAVITY_LANGUAGE_SERVER ?? defaultLanguageServerPath
  const args = [
    '--standalone',
    '--override_ide_name', input.source,
    '--subclient_type', input.source === 'antigravity-ide' ? 'ide' : 'hub',
    '--override_ide_version', input.overrideIdeVersion ?? '0.0.0',
    '--override_user_agent_name', input.source,
    '--https_server_port', String(input.port),
    '--csrf_token', input.csrfToken,
    '--app_data_dir', input.source,
    '--api_server_url', apiServerUrl,
    '--cloud_code_endpoint', cloudCodeEndpoint,
    '--enable_sidecars',
    '--headless'
  ]
  return spawn(languageServerPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

function waitForReady(server: LanguageServerProcess, port: number) {
  const lines: string[] = []
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => rejectWithTail(`Timed out starting Antigravity language server on port ${port}`), readyTimeoutMs)
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      lines.push(text)
      if (text.includes(`fixed port at ${port} for HTTPS`) || text.includes(`:${port}`)) {
        cleanup()
        resolve()
      }
    }
    const onExit = () => rejectWithTail('Antigravity language server exited before it was ready')
    const rejectWithTail = (message: string) => {
      cleanup()
      reject(new Error(`${message}: ${lines.join('').slice(-2000)}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      server.stdout.off('data', onData)
      server.stderr.off('data', onData)
      server.off('exit', onExit)
    }
    server.stdout.on('data', onData)
    server.stderr.on('data', onData)
    server.once('exit', onExit)
  })
}

function requestGeneratorMetadata(input: AntigravityGeneratorMetadataRequest & { port: number; csrfToken: string }) {
  const body = JSON.stringify({ cascadeId: input.cascadeId })
  return new Promise<unknown>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: input.port,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': input.csrfToken
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          reject(new Error(`Antigravity metadata request failed for ${input.source}: HTTP ${res.statusCode} ${text.slice(0, 500)}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`Antigravity metadata request returned invalid JSON for ${input.source}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`Antigravity metadata request timed out for ${input.source}`)))
    req.on('error', reject)
    req.end(body)
  })
}

async function closeLanguageServer(server: LanguageServerProcess) {
  if (server.exitCode !== null || server.killed) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.kill('SIGKILL')
      resolve()
    }, 2_000)
    server.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    server.kill('SIGTERM')
  })
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port)
        else reject(new Error('Failed to allocate local Antigravity language server port'))
      })
    })
  })
}

function defaultConversationDir(source: AntigravityGuiSource) {
  return join(homedir(), '.gemini', source, 'conversations')
}

function cascadeIdFromFile(name: string) {
  const ext = extname(name)
  if (ext !== '.pb' && ext !== '.db') return null
  const id = basename(name, ext)
  return cascadeIdPattern.test(id) ? id : null
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
