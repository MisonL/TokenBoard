import { errorMessage } from './error-message'

// Failures worth attempting again later: DNS, TLS, connection resets, and the
// gateway statuses an edge returns while a deploy rolls out. Command retries
// and the scheduled sync runner both key off this single list so a transient
// failure is classified the same way wherever it surfaces.
// Every entry has to name a network signature on its own. A bare 'network', 'tls',
// 'ssl' or 'cert_' also matches the path in a local filesystem error — "Unable to
// read Codex session file /Volumes/network-share/...: EIO", "...:/mnt/ssl-backup/..."
// — which turns a disk fault into five pointless retries reported as a connectivity
// problem. The entries below therefore carry the words that only appear in a real
// transport failure, while still covering the certificate errors a TLS handshake
// actually raises.
const transientErrorPatterns = [
  'fetch failed',
  'unknown_certificate_verification_error',
  // Named in full rather than as the bare word, which also matches a local path that happens
  // to contain a `certificates` directory — the same trap the comment above describes.
  'certificate verification',
  'verify the first certificate',
  'certificate has expired',
  'certificate is not yet valid',
  'self-signed certificate',
  'cert_has_expired',
  'cert_not_yet_valid',
  'econnreset',
  'econnrefused',
  'etimedout',
  'eai_again',
  'enotfound',
  'network socket',
  'socket hang up',
  'tls connection',
  'tls handshake',
  'ssl routines',
  'ssl_error',
  // Upload request deadline. Kept as the full phrase so an unrelated local
  // lock timeout is never mistaken for a transient network failure.
  'request timed out'
]

const transientHttpStatuses = new Set([408, 429, 500, 502, 503, 504])
const httpStatusPattern = /status (\d{3})\b/

export function isTransientNetworkError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  if (transientErrorPatterns.some((pattern) => message.includes(pattern))) return true
  const status = httpStatusPattern.exec(message)?.[1]
  return status !== undefined && transientHttpStatuses.has(Number(status))
}
