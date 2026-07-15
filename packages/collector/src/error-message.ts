export function errorMessage(error: unknown) {
  if (!isError(error)) return safeString(error)

  const message = safePropertyString(error, 'message')
  if (message.trim()) return message
  const name = safePropertyString(error, 'name')
  if (name.trim()) return name
  return 'Unknown error'
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error
  } catch (_) {
    return false
  }
}

function safePropertyString(value: Error, property: 'message' | 'name') {
  try {
    return String(value[property] ?? '')
  } catch (_) {
    return ''
  }
}

function safeString(value: unknown) {
  try {
    const message = String(value)
    return message.trim() ? message : 'Unknown error'
  } catch (_) {
    return 'Unknown error'
  }
}
