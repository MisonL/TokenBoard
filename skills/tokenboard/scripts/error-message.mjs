export function errorMessage(error) {
  const message = error instanceof Error ? String(error.message ?? '') : String(error)
  if (message.trim()) return message
  const name = error instanceof Error ? String(error.name ?? '') : ''
  if (name.trim()) return name
  return 'Unknown error'
}
