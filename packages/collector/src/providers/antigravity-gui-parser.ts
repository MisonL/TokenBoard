import { createHash } from 'node:crypto'

export type AntigravityUsageEvent = {
  cascadeHash: string
  cascadeHashAliases?: string[]
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
const placeholderModelPrefix = 'MODEL_PLACEHOLDER_'
const isoDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/

export function parseGeneratorMetadata(response: unknown, cascadeId: string) {
  if (!isRecord(response) || !Array.isArray(response.generatorMetadata)) {
    throw new Error('Invalid Antigravity generator metadata response')
  }
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
  if (Object.keys(usage).length === 0) return null
  const tokens = readUsageTokens(usage, index)
  if (!tokens) return null
  const startMetadata = readRecord(chatModel.chatStartMetadata)
  const createdAt = readIsoDateTime(startMetadata?.createdAt, index)
  const model = readModel({ usage, chatModel, index })
  return {
    cascadeHash,
    eventHash: usageEventHash({ item, usage, tokens, model, createdAt }),
    createdAt,
    model,
    ...tokens
  }
}

function readUsageTokens(usage: Record<string, unknown>, index: number) {
  const tokens = {
    inputTokens: readOptionalToken(usage.inputTokens, 'inputTokens', index),
    outputTokens: readOptionalToken(usage.outputTokens, 'outputTokens', index),
    cacheCreationTokens: readOptionalToken(usage.cacheCreationTokens, 'cacheCreationTokens', index),
    cacheReadTokens: readOptionalToken(usage.cacheReadTokens, 'cacheReadTokens', index)
  }
  const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens
  return total === 0 ? null : tokens
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

function readModel(input: {
  usage: Record<string, unknown>
  chatModel: Record<string, unknown>
  index: number
}) {
  const candidates = [
    input.chatModel.responseModel,
    input.usage.model,
    input.chatModel.model
  ]
  const placeholderCandidates: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (candidate.length === 0) continue
    if (candidate.startsWith(placeholderModelPrefix)) {
      placeholderCandidates.push(candidate)
      continue
    }
    return readString(candidate, 'model', input.index)
  }
  const placeholder = placeholderCandidates[0]
  if (placeholder) return readString(placeholder, 'model', input.index)
  throw new Error(`Invalid Antigravity generator metadata item ${input.index}: model must be a non-empty string`)
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
  if (typeof value !== 'string' || !isValidIsoDateTime(value)) {
    throw new Error(`Invalid Antigravity generator metadata item ${index}: createdAt must be an ISO datetime`)
  }
  return value
}

function isValidIsoDateTime(value: string) {
  const match = isoDateTimePattern.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
  return month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth(year, month) &&
    hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function usageEventHash(input: {
  item: Record<string, unknown>
  usage: Record<string, unknown>
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
  }
  model: string
  createdAt: string
}) {
  return hash(JSON.stringify([
    input.usage.responseId,
    input.item.executionId,
    input.item.stepIndices,
    input.model,
    input.createdAt,
    input.tokens.inputTokens,
    input.tokens.outputTokens,
    input.tokens.cacheCreationTokens,
    input.tokens.cacheReadTokens
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
