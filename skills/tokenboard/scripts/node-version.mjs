// The Node floor this project enforces, in one place: `engines.node` in
// package.json, the preflight in setup.mjs / sync.mjs / install-collector.mjs,
// and the troubleshooting text in SKILL.md all have to agree, and a range that
// drifts between them is worse than no range at all.
//
// The floor is a security floor, not a functional one. `node:sqlite` needs
// 22.5 and `zstdDecompress` needs 22.15, so 22.18 was functional — but Node 22
// below 22.23.4 and Node 24 below 24.22.1 carry the Brotli out-of-bounds write
// (CVE-2026-111497) and the TLS hostname-verification bypasses, and the
// collector presents its upload token over TLS. Node 23 and 25 are odd-numbered
// and already end-of-life, so no release of either is a supported target;
// `^22.23.4 || ^24.22.1 || >=26.12.1` excludes them by construction.
export const minimumNodeRange = '^22.23.4 || ^24.22.1 || >=26.12.1'

// [major, minor, patch] floors per supported line. Lines above the last entry
// inherit its floor: `>=26.12.1` covers 27 and everything after.
const lineFloors = [
  [22, 23, 4],
  [24, 22, 1],
  [26, 12, 1]
]

const nodeVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/

export function isSupportedNodeVersion(version) {
  const match = typeof version === 'string' ? nodeVersionPattern.exec(version.trim()) : null
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]

  for (const floor of lineFloors) {
    if (parts[0] !== floor[0]) continue
    return compare(parts, floor) >= 0
  }

  const newest = lineFloors[lineFloors.length - 1]
  return parts[0] > newest[0] && compare(parts, newest) >= 0
}

export function assertSupportedNodeVersion(version, label = 'TokenBoard') {
  if (isSupportedNodeVersion(version)) return version
  throw new Error(
    `${label} requires Node.js ${minimumNodeRange}. ` +
      `This machine is running Node.js ${version || 'unknown'}. ` +
      'Upgrade Node (nvm install --lts, or the installer from nodejs.org) and run the command again — ' +
      'older releases carry known TLS and decompression vulnerabilities.'
  )
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}
