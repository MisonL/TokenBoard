import { createHash } from 'node:crypto'

// Content fingerprints identify a session-file revision so a sync can tell "nothing
// changed" from "these bytes are new". They never leave the machine — the upload
// payload carries usage snapshots only — so the requirements are collision
// resistance and speed, not compatibility with any external format.
//
// blake2b512 ships in node:crypto and measured 1.35x faster than sha256 on a host
// without SHA-NI (Intel i7-10700: 0.30 GB/s sha256 vs 0.40 GB/s blake2b512 reading a
// 0.55 GB session file, median of repeated runs). The gain is smaller than the
// algorithm's raw throughput suggests — 1.67x in memory — because file reads absorb
// part of it. It applies to every changed session file on every sync, and a codex
// corpus can reach tens of gigabytes.
//
// `contentHashAlgo` is recorded alongside each digest so a later switch needs no
// migration: readers dispatch on the recorded name, and an entry without one
// predates this field and holds a legacy sha256 digest.
export const sessionContentHashAlgorithm = 'blake2b512'

// Entries written before `contentHashAlgo` existed carry a sha256 digest. The name
// is kept so those entries stay readable and are upgraded in place on next change.
export const legacySessionContentHashAlgorithm = 'sha256'

export function createSessionContentHasher() {
  return createHash(sessionContentHashAlgorithm)
}

// A stored digest is only comparable against one produced by the same algorithm, so
// a legacy entry cannot use the append-only fast path — its prefix digest was made
// with sha256. Treating it as "changed" costs one full re-read, after which the
// entry carries the current algorithm and the fast path applies again.
export function isCurrentContentHashAlgorithm(algorithm: string | undefined) {
  return (algorithm ?? legacySessionContentHashAlgorithm) === sessionContentHashAlgorithm
}
