import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A CLI's entry guard must compare canonical paths. Node resolves `import.meta.url` through
// symlinks, but `process.argv[1]` is whatever the caller typed, so a plain string compare — or
// one using `resolve()`, which only normalizes `.`/`..` and separators — fails when the path
// carries a symlink component or (on a case-insensitive filesystem) differs in case. The script
// then exits 0 having done nothing: a normal run silently no-ops, and `--help` violates its
// "print usage" contract. `realpathSync` both sides; a path that cannot be resolved is not this
// module.
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(importMetaUrl)
  } catch {
    return false
  }
}
