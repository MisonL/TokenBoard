export const codexSource = 'codex'
export const claudeSource = 'claude-code'
export const antigravitySource = 'antigravity-cli'

export function readSources(value) {
  return readSourcesWithOptions(value, { includeAntigravityInAll: false })
}

export function readUninstallSources(value) {
  return readSourcesWithOptions(value, { includeAntigravityInAll: true })
}

function readSourcesWithOptions(value, options) {
  const sources = String(value || 'all')
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean)
  for (const source of sources) {
    if (source === 'all') continue
    if (source !== codexSource && source !== claudeSource && source !== antigravitySource) {
      throw new Error(`Unsupported hook source: ${source}`)
    }
  }
  if (sources.includes('all')) {
    const explicit = sources.filter((source) => source !== 'all')
    const implicit = options.includeAntigravityInAll
      ? [codexSource, claudeSource, antigravitySource]
      : [codexSource, claudeSource]
    return [...new Set([...implicit, ...explicit])]
  }
  return [...new Set(sources)]
}
