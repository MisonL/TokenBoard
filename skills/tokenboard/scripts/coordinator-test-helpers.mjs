export function writeSignal(fs, source) {
  fs.writeFile('/state/notify.signal', `${JSON.stringify({ source })}\n`, { flag: 'a' })
}

export function memoryRuntime(initial = {}, options = {}) {
  const files = new MemoryFiles(initial)
  return {
    files,
    platform: options.platform || 'linux',
    nodeVersion: options.nodeVersion || '22.16.0',
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options = {}) => {
      if (typeof options.flag === 'string' && options.flag.includes('x') && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      if (options.flag === 'a') {
        files.set(path, `${files.get(path) || ''}${value}`)
        return
      }
      files.set(path, String(value))
    },
    unlink: (path) => removeMemoryFile(files, path),
    rename: (source, target) => {
      if (!files.has(source)) {
        const error = new Error(`ENOENT: ${source}`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(target, files.get(source))
      files.delete(source)
    },
    link: (from, to) => linkMemoryFile(files, from, to),
    readdir: (path) => {
      const prefix = `${normalizeMemoryPath(path)}/`
      return [...files.keys()]
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => filePath.slice(prefix.length))
        .filter((name) => !name.includes('/'))
    },
    sleep: () => {}
  }
}

class MemoryFiles extends Map {
  constructor(initial = {}) {
    super()
    const entries = initial instanceof Map ? initial.entries() : Object.entries(initial)
    for (const [path, value] of entries) this.set(path, value)
  }

  get(path) {
    return super.get(normalizeMemoryPath(path))
  }

  has(path) {
    return super.has(normalizeMemoryPath(path))
  }

  set(path, value) {
    return super.set(normalizeMemoryPath(path), value)
  }

  delete(path) {
    return super.delete(normalizeMemoryPath(path))
  }
}

function normalizeMemoryPath(path) {
  return typeof path === 'string' ? path.replaceAll('\\', '/') : path
}

export function fakeProcess(pid) {
  return {
    pid,
    kill: () => true
  }
}

export function readMemoryFile(files, path) {
  const value = files.get(path)
  if (value !== undefined) return value
  const error = new Error(`ENOENT: ${path}`)
  error.code = 'ENOENT'
  throw error
}

export function moveMemoryFile(files, from, to) {
  const value = readMemoryFile(files, from)
  files.set(to, value)
  files.delete(from)
}

export function linkMemoryFile(files, from, to) {
  if (files.has(to)) {
    const error = new Error(`EEXIST: ${to}`)
    error.code = 'EEXIST'
    throw error
  }
  files.set(to, readMemoryFile(files, from))
}

export function removeMemoryFile(files, path) {
  if (!files.has(path)) {
    const error = new Error(`ENOENT: ${path}`)
    error.code = 'ENOENT'
    throw error
  }
  files.delete(path)
}
