import { rename } from 'node:fs/promises'

// Atomic writes land via rename, and on Windows a concurrent opener (OneDrive, Defender,
// a backup tool) holds the destination just long enough to make rename fail with EPERM or
// EBUSY. That is transient: a short backoff retries only those errors instead of failing
// the whole sync's state write for a collision the other process releases in milliseconds.
const renameRetryDelaysMs = [50, 150, 400]

function isBusyRenameError(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY'
}

export async function renameAtomic(tempPath: string, destinationPath: string, renameFn: typeof rename = rename) {
  try {
    await renameFn(tempPath, destinationPath)
  } catch (error) {
    if (!isBusyRenameError(error)) throw error
    let lastError: unknown = error
    for (const delayMs of renameRetryDelaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        await renameFn(tempPath, destinationPath)
        return
      } catch (retryError) {
        if (!isBusyRenameError(retryError)) throw retryError
        lastError = retryError
      }
    }
    throw lastError
  }
}
