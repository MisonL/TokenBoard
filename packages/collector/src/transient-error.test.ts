import { describe, expect, test } from 'vitest'
import { isTransientNetworkError } from './transient-error'

describe('isTransientNetworkError', () => {
  test.each([
    'fetch failed',
    'ECONNRESET',
    'read ECONNRESET',
    'connect ETIMEDOUT 1.2.3.4:443',
    'getaddrinfo ENOTFOUND tokenboard.example.com',
    'socket hang up',
    'Client network socket disconnected before secure TLS connection was established',
    'unknown_certificate_verification_error',
    'unable to verify the first certificate',
    'self-signed certificate in certificate chain',
    'certificate has expired',
    'Upload failed with status 500',
    'Upload failed with status 502',
    'Upload failed with status 503',
    'Upload failed with status 504',
    'Upload failed with status 408',
    'Upload failed with status 429',
    'TokenBoard request timed out after 30000ms'
  ])('treats %s as transient', (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true)
  })

  test.each([
    'Upload failed with status 400',
    'Upload failed with status 401',
    'Upload failed with status 403',
    'Upload failed with status 404',
    'Upload returned invalid response',
    'Snapshot check returned invalid response',
    'TokenBoard scheduled retry reached an unreachable state'
  ])('treats %s as a hard failure', (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(false)
  })

  // A local filesystem failure is not something a retry can fix. The old bare
  // 'network' and 'tls' substrings matched these messages whenever a configured
  // session root happened to live under a path containing those words, so the
  // caller retried five times and then reported a network problem.
  test.each([
    'Unable to read Codex session file /Volumes/network-share/codex/rollout.jsonl: EIO: i/o error, lstat',
    'Unable to read Codex session file /mnt/tls-certs/codex/rollout.jsonl: EIO: i/o error, lstat',
    'Unable to inspect session directory /mnt/network/codex: EACCES: permission denied',
    'Codex session prefilter read limit exceeded for /Volumes/network/codex/sessions/rollout.jsonl',
    'Unable to read Codex session file /tls-mount/rollout.jsonl: EPERM: operation not permitted',
    // The bare word `certificate` matched this one too, for the same reason.
    'Unable to read session file /Users/x/certificates/rollout.jsonl: EACCES: permission denied'
  ])('treats %s as a hard failure despite a network-like path', (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(false)
  })

  test('classifies a non-Error rejection without throwing', () => {
    expect(isTransientNetworkError('fetch failed')).toBe(true)
    expect(isTransientNetworkError(undefined)).toBe(false)
  })
})
