import { createHash } from 'node:crypto'

export type AntigravityUsageEvent = {
  cascadeHash: string
  eventHash: string
  createdAt: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

const maxTokenValue = 1_000_000_000
const maxModelLength = 160
const rawContentKeys = new Set([
  'content',
  'conversationHistory',
  'cwd',
  'email',
  'filePath',
  'path',
  'prompt',
  'completion',
  'transcript_path',
  'userInput',
  'workspace',
  'workspaceFolderAbsoluteUri'
])

export function parseGeneratorMetadata(response: unknown, cascadeId: string) {
  if (!isRecord(response) || !Array.isArray(response.generatorMetadata)) {
    throw new Error('Invalid Antigravity generator metadata response')
  }
  assertNoRawContentFields(response.generatorMetadata, 'generatorMetadata')
  const cascadeHash = hash(cascadeId)
  const events: AntigravityUsageEvent[] = []
  for (const [index, item] of response.generatorMetadata.entries()) {
    const event = parseGeneratorMetadataItem(item, cascadeHash, index)
    if (event) events.push(event)
  }
  return events
}

function parseGeneratorMetadataItem(
  item: unknown,
  cascadeHash: string,
  index: number
): AntigravityUsageEvent | null {
  if (!isRecord(item)) return null
  const chatModel = readRecord(item.chatModel)
  if (!chatModel) return null
  const usage = readRecord(chatModel.usage)
  if (!usage) return null
  const startMetadata = readRecord(chatModel.chatStartMetadata)
  const createdAt = readIsoDateTime(startMetadata?.createdAt, index)
  const model = readString(usage.model ?? chatModel.model, 'model', index)
  const event = {
    cascadeHash,
    eventHash: usageEventHash({ item, usage, model, createdAt }),
    createdAt,
    model,
    inputTokens: readRequiredToken(usage.inputTokens, 'inputTokens', index),
    outputTokens: readRequiredToken(usage.outputTokens, 'outputTokens', index),
    cacheCreationTokens: readOptionalToken(usage.cacheCreationTokens, 'cacheCreationTokens', index),
    cacheReadTokens: readOptionalToken(usage.cacheReadTokens, 'cacheReadTokens', index)
  }
  if (event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens === 0) {
    throw new Error(`Invalid Antigravity generator metadata item ${index}: usage is empty`)
  }
  return event
}

function assertNoRawContentFields(value: unknown, path: string) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoRawContentFields(item, `${path}[${index}]`)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (rawContentKeys.has(key)) {
      throw new Error(`Antigravity generator metadata contains raw content field ${childPath}`)
    }
    assertNoRawContentFields(child, childPath)
  }
}

function readRequiredToken(value: unknown, field: string, index: number) {
  if (value === undefined || value === null) {
    throw new Error(`Invalid Antigravity generator metadata item ${index}: ${field} is required`)
  }
  return readToken(value, field, index)
}

function readOptionalToken(value: unknown, field: string, index: number) {
  return value === undefined || value === null ? 0 : readToken(value, field, index)
}

function readToken(value: unknown, field: string, index: number) {
  const token = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value
  if (typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0 || token > maxTokenValue) {
    throw new Error(
      `Invalid Antigravity generator metadata item ${index}: ` +
      `${field} must be a bounded nonnegative integer`
    )
  }
  return token
}

function readString(value: unknown, field: string, index: number) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxModelLength) {
    throw new Error(
      `Invalid Antigravity generator metadata item ${index}: ` +
      `${field} must be a non-empty string`
    )
  }
  return value
}

function readIsoDateTime(value: unknown, index: number) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid Antigravity generator metadata item ${index}: createdAt must be an ISO datetime`)
  }
  return value
}

function usageEventHash(input: {
  item: Record<string, unknown>
  usage: Record<string, unknown>
  model: string
  createdAt: string
}) {
  return hash(JSON.stringify([
    input.usage.responseId,
    input.item.executionId,
    input.item.stepIndices,
    input.model,
    input.createdAt,
    input.usage.inputTokens,
    input.usage.outputTokens,
    input.usage.cacheReadTokens
  ]))
}

export function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function readRecord(value: unknown) {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
