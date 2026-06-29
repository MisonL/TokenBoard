const eventSchemaVersion = 'antigravity-statusline/v1'
const maxTokenValue = 1_000_000_000
const maxModelLength = 160
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const sensitiveKeys = new Set([
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'authToken',
  'auth_token',
  'authorization',
  'bearer',
  'completion',
  'conversationId',
  'conversation_id',
  'cwd',
  'email',
  'filePath',
  'file_path',
  'path',
  'planTier',
  'plan_tier',
  'password',
  'prompt',
  'refreshToken',
  'refresh_token',
  'responseId',
  'response_id',
  'secret',
  'token',
  'toolArgs',
  'tool_args',
  'toolParams',
  'tool_params',
  'transcriptPath',
  'transcript_path',
  'workspace'
])

export type StatuslineEvent = {
  capturedAt: string
  conversationHash: string
  conversationHashAliases?: string[]
  eventHash?: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export function parseStatuslineEvent(line: string, lineNumber: number): StatuslineEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`Malformed Antigravity statusline JSON at line ${lineNumber}`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: expected object`)
  }
  const sensitiveKey = findSensitiveKey(parsed)
  if (sensitiveKey) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: sensitive field ${sensitiveKey} must not be persisted`)
  }
  if (parsed.schemaVersion !== eventSchemaVersion) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: unsupported schemaVersion`)
  }
  const usage = isRecord(parsed.usage) ? parsed.usage : null
  if (!usage) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: missing usage`)
  }
  const event = {
    capturedAt: readIsoDateTime(parsed.capturedAt, lineNumber),
    conversationHash: readHash(parsed.conversationHash, 'conversationHash', lineNumber),
    conversationHashAliases: readHashArray(parsed.conversationHashAliases, 'conversationHashAliases', lineNumber),
    eventHash: readOptionalHash(parsed.eventHash, 'eventHash', lineNumber),
    model: readString(parsed.model, 'model', lineNumber),
    inputTokens: readToken(usage.inputTokens, 'inputTokens', lineNumber),
    outputTokens: readToken(usage.outputTokens, 'outputTokens', lineNumber),
    cacheCreationTokens: readToken(usage.cacheCreationTokens, 'cacheCreationTokens', lineNumber),
    cacheReadTokens: readToken(usage.cacheReadTokens, 'cacheReadTokens', lineNumber)
  }
  const total = event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens
  if (total === 0) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: usage is empty`)
  }
  return event
}

function readIsoDateTime(value: unknown, lineNumber: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: capturedAt must be a string`)
  }
  if (!isoDateTimePattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: capturedAt must be an ISO datetime`)
  }
  return value
}

function findSensitiveKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = findSensitiveKey(item)
      if (key) return key
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKeys.has(key)) return key
    const childKey = findSensitiveKey(child)
    if (childKey) return childKey
  }
  return null
}

function readHash(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be a hash`)
  }
  return value
}

function readOptionalHash(value: unknown, field: string, lineNumber: number): string | undefined {
  if (value === undefined) return undefined
  return readHash(value, field, lineNumber)
}

function readHashArray(value: unknown, field: string, lineNumber: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be an array`)
  }
  return value.map((item, index) => readHash(item, `${field}[${index}]`, lineNumber))
}

function readString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxModelLength) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be a non-empty string`)
  }
  return value
}

function readToken(value: unknown, field: string, lineNumber: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maxTokenValue) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be a bounded nonnegative integer`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
