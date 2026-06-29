#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const defaultMaxInputBytes = 256 * 1024
const maxTokenValue = 1_000_000_000
const maxModelLength = 160
const maxCommandLength = 8192
const originalCommandTimeoutMs = 1000
const originalCommandMaxBuffer = 8192
const schemaVersion = 'antigravity-statusline/v1'

export function runStatuslineCli(argv = process.argv.slice(2), env = process.env) {
  const options = readOptions(argv, env)
  let raw = ''
  try {
    raw = readStdinLimited(options.maxInputBytes)
    const event = extractStatuslineEvent(raw, new Date().toISOString())
    if (event) {
      appendJsonLine(options.logPath, event)
    }
  } catch (error) {
    recordStatuslineError(options.errorPath, 'capture', error)
  }

  try {
    const output = runOriginalCommand({
      raw,
      originalCommandFile: options.originalCommandFile,
      selfPath: options.selfPath
    })
    if (output) process.stdout.write(output)
  } catch (error) {
    recordStatuslineError(options.errorPath, 'original', error)
  }
}

export function extractStatuslineEvent(raw, capturedAt) {
  const payload = parsePayload(raw)
  const contextWindow = readObject(payload.context_window)
  const usage = readObject(contextWindow.current_usage)
  const conversationId = readBoundedString(payload.conversation_id, 4096, 'conversation_id')
  const conversationHash = hashLegacyIdentifier(conversationId)
  const conversationHashAliases = hashIdentifier(conversationId)
  const model = readModel(payload.model)
  const inputTokens = readToken(usage.input_tokens, 'input_tokens')
  const outputTokens = readToken(usage.output_tokens, 'output_tokens')
  const cacheCreationTokens = readToken(usage.cache_creation_input_tokens, 'cache_creation_input_tokens') ?? 0
  const cacheReadTokens = readToken(usage.cache_read_input_tokens, 'cache_read_input_tokens') ?? 0

  if (!conversationHash || !model) return null
  if ([inputTokens, outputTokens].some((value) => value === null)) return null
  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) return null

  return {
    schemaVersion,
    capturedAt,
    conversationHash,
    conversationHashAliases: conversationHashAliases && conversationHashAliases !== conversationHash
      ? [conversationHashAliases]
      : undefined,
    model,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens
    }
  }
}

export function readOptions(argv, env = process.env) {
  const flags = readFlags(argv)
  const stateDir = flags['state-dir'] || env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR
  if (!stateDir) {
    throw new Error('Missing --state-dir for Antigravity statusline handler')
  }
  const logPath = flags['log-path'] || env.TOKENBOARD_ANTIGRAVITY_STATUSLINE_LOG || `${stateDir}/antigravity-cli-statusline.jsonl`
  const errorPath = flags['error-path'] || `${stateDir}/antigravity-statusline-errors.log`
  const originalCommandFile = flags['original-command-file'] || `${stateDir}/antigravity_statusline_original.json`
  return {
    stateDir,
    logPath,
    errorPath,
    originalCommandFile,
    maxInputBytes: Number(flags['max-input-bytes'] || defaultMaxInputBytes),
    selfPath: resolve(fileURLToPath(import.meta.url))
  }
}

function parsePayload(raw) {
  let payload
  try {
    payload = JSON.parse(raw || '{}')
  } catch (error) {
    throw new Error('Malformed Antigravity statusline payload', { cause: error })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Antigravity statusline payload: expected object')
  }
  return payload
}

function readStdinLimited(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > defaultMaxInputBytes) {
    throw new Error('Invalid Antigravity statusline input limit')
  }
  const chunks = []
  let total = 0
  const buffer = Buffer.alloc(Math.min(16 * 1024, maxBytes))
  while (true) {
    const bytesRead = readSync(0, buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxBytes) {
      throw new Error('Antigravity statusline payload too large')
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function readModel(value) {
  if (typeof value === 'string') return readBoundedString(value, maxModelLength, 'model')
  const model = readObject(value)
  return readBoundedString(model.display_name, maxModelLength, 'model.display_name') ||
    readBoundedString(model.id, maxModelLength, 'model.id')
}

function readToken(value, field) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0 || value > maxTokenValue) {
    throw new Error(`Invalid Antigravity statusline payload: ${field} must be a bounded nonnegative integer`)
  }
  return value
}

function readBoundedString(value, maxLength, field) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > maxLength) {
    throw new Error(`Invalid Antigravity statusline payload: ${field} is too long`)
  }
  return trimmed
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function hashIdentifier(value) {
  if (!value) return null
  return createHash('sha256')
    .update(value)
    .digest('hex')
}

function hashLegacyIdentifier(value) {
  if (!value) return null
  return createHash('sha256')
    .update('tokenboard-antigravity-cli\0')
    .update(value)
    .digest('hex')
}

function appendJsonLine(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function recordStatuslineError(filePath, stage, error) {
  try {
    appendJsonLine(filePath, {
      stage,
      message: error instanceof Error ? error.message : String(error),
      capturedAt: new Date().toISOString()
    })
  } catch (_) {}
}

function runOriginalCommand({ raw, originalCommandFile, selfPath }) {
  const command = readOriginalCommand(originalCommandFile, selfPath)
  if (!command) return ''
  const result = spawnSync(command, {
    input: raw,
    shell: true,
    encoding: 'utf8',
    timeout: originalCommandTimeoutMs,
    maxBuffer: originalCommandMaxBuffer,
    env: { ...process.env }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Antigravity original statusline command exited with ${result.status}`)
  }
  return typeof result.stdout === 'string' ? result.stdout.slice(0, originalCommandMaxBuffer) : ''
}

function readOriginalCommand(filePath, selfPath) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw new Error('Invalid Antigravity original statusline command backup', { cause: error })
  }
  const command = readBoundedString(parsed && parsed.command, maxCommandLength)
  if (!command) return ''
  return isSelfCommand(command, selfPath) ? '' : command
}

function isSelfCommand(command, selfPath) {
  if (command.includes(selfPath)) return true
  const resolvedSelf = safeRealpath(selfPath)
  if (resolvedSelf && command.includes(resolvedSelf)) return true
  return command.includes('antigravity-statusline.mjs')
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return ''
  }
}

function readFlags(args) {
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2)
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue
      continue
    }
    const next = args[index + 1]
    if (!next || next.startsWith('--')) {
      flags[rawKey] = 'true'
      continue
    }
    flags[rawKey] = next
    index += 1
  }
  return flags
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runStatuslineCli()
}
