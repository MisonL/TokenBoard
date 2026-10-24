#!/usr/bin/env node
// Downloads the ccusage platform binaries that go inside the Go client's
// release tarballs (spec §4.1: bundle > probe > download).
//
// The npm registry publishes one package per platform, each carrying the Rust
// binary at package/bin/ccusage. The registry's dist.integrity is a sha512 of
// the tarball, so the same check the client performs at download time is
// applied here: a package that changed under its version is refused, not
// republished.
//
// Output: dist-ccusage/<goos>_<goarch>/ccusage[.exe], which .goreleaser.yaml
// globs per archive with `{{ .Os }}` / `{{ .Arch }}` and copies under its own
// base name (GoReleaser does not template `dst`), plus
// dist-ccusage/LICENSE.ccusage from the main package (MIT requires the notice
// to travel with a redistribution).
//
//   node clients/go/scripts/bundle-ccusage.mjs [--out DIR] [--version X.Y.Z]
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The six pairs the Go client publishes. The npm platform segment differs from
// Go's: windows is win32 and amd64 is x64.
const targets = [
  { goos: 'darwin', goarch: 'amd64', npmOs: 'darwin', npmArch: 'x64' },
  { goos: 'darwin', goarch: 'arm64', npmOs: 'darwin', npmArch: 'arm64' },
  { goos: 'linux', goarch: 'amd64', npmOs: 'linux', npmArch: 'x64' },
  { goos: 'linux', goarch: 'arm64', npmOs: 'linux', npmArch: 'arm64' },
  { goos: 'windows', goarch: 'amd64', npmOs: 'win32', npmArch: 'x64' },
  { goos: 'windows', goarch: 'arm64', npmOs: 'win32', npmArch: 'arm64' }
]

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    flags[arg.slice(2)] = value
    index += 1
  }
  return flags
}

function readExpectedVersion() {
  const source = readFileSync(new URL('../internal/ccusage/version.go', import.meta.url), 'utf8')
  const match = /const Version = "([^"]+)"/.exec(source)
  if (!match) throw new Error('cannot read the ccusage version from internal/ccusage/version.go')
  return match[1]
}

function integrityDigest(integrity) {
  // sha512-<base64>; anything else is a registry change this script must not
  // guess at.
  const match = /^sha512-(.+)$/.exec(String(integrity))
  if (!match) throw new Error(`unsupported dist.integrity: ${integrity}`)
  return Buffer.from(match[1], 'base64')
}

async function bundleOne(target, version, outDir) {
  const packageName = `@ccusage/ccusage-${target.npmOs}-${target.npmArch}`
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`
  const metadataResponse = await fetch(metadataUrl)
  if (!metadataResponse.ok) {
    throw new Error(`registry returned HTTP ${metadataResponse.status} for ${packageName}@${version}`)
  }
  const metadata = await metadataResponse.json()
  if (!metadata?.dist?.tarball || !metadata?.dist?.integrity) {
    throw new Error(`registry metadata for ${packageName} has no tarball integrity`)
  }
  const tarballResponse = await fetch(metadata.dist.tarball)
  if (!tarballResponse.ok) {
    throw new Error(`tarball download failed with HTTP ${tarballResponse.status} for ${packageName}`)
  }
  const tarball = Buffer.from(await tarballResponse.arrayBuffer())
  const actual = createHash('sha512').update(tarball).digest()
  const expected = integrityDigest(metadata.dist.integrity)
  if (!actual.equals(expected)) {
    throw new Error(`ccusage tarball integrity mismatch for ${packageName}@${version}`)
  }

  const work = mkdtempSync(join(tmpdir(), 'tokenboard-ccusage-'))
  try {
    const archivePath = join(work, 'package.tgz')
    writeFileSync(archivePath, tarball)
    // The Windows package ships ccusage.exe inside the same bin directory.
    const member = target.npmOs === 'win32' ? 'package/bin/ccusage.exe' : 'package/bin/ccusage'
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', work, member], {
      encoding: 'utf8'
    })
    if (extracted.status !== 0) {
      throw new Error(`cannot extract ${packageName}: ${extracted.stderr || extracted.error}`)
    }
    // One directory per goos/goarch: .goreleaser.yaml globs
    // dist-ccusage/ccusage_{{ .Os }}_{{ .Arch }}/*, so the file inside keeps
    // the plain name the bundled layer looks up and no dst rename is needed.
    const dir = join(outDir, `ccusage_${target.goos}_${target.goarch}`)
    mkdirSync(dir, { recursive: true })
    const binaryName = target.goos === 'windows' ? 'ccusage.exe' : 'ccusage'
    // Copy rather than rename: the work directory lives under os.tmpdir(),
    // which on Linux CI is often a different filesystem than the checkout,
    // and rename(2) cannot cross mounts.
    copyFileSync(
      join(work, 'package', 'bin', target.npmOs === 'win32' ? 'ccusage.exe' : 'ccusage'),
      join(dir, binaryName)
    )
    return `ccusage_${target.goos}_${target.goarch}/${binaryName}`
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function fetchLicense(version, outDir) {
  const packageName = `ccusage@${version}`
  const metadataResponse = await fetch(`https://registry.npmjs.org/ccusage/${version}`)
  if (!metadataResponse.ok) {
    throw new Error(`registry returned HTTP ${metadataResponse.status} for ${packageName}`)
  }
  const metadata = await metadataResponse.json()
  if (!metadata?.dist?.tarball || !metadata?.dist?.integrity) {
    throw new Error(`registry metadata for ${packageName} has no tarball integrity`)
  }
  const tarballResponse = await fetch(metadata.dist.tarball)
  if (!tarballResponse.ok) {
    throw new Error(`tarball download failed with HTTP ${tarballResponse.status} for ${packageName}`)
  }
  const tarball = Buffer.from(await tarballResponse.arrayBuffer())
  // Same sha512 check as the platform packages: a tarball that changed under
  // its version must be refused here too, not just for the binaries.
  const actual = createHash('sha512').update(tarball).digest()
  if (!actual.equals(integrityDigest(metadata.dist.integrity))) {
    throw new Error(`ccusage tarball integrity mismatch for ${packageName}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'tokenboard-ccusage-license-'))
  try {
    const archivePath = join(work, 'package.tgz')
    writeFileSync(archivePath, tarball)
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', work, 'package/LICENSE'], { encoding: 'utf8' })
    if (extracted.status !== 0) {
      throw new Error(`cannot extract the ccusage license: ${extracted.stderr || extracted.error}`)
    }
    copyFileSync(join(work, 'package', 'LICENSE'), join(outDir, 'LICENSE.ccusage'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// cleanOwnedOutputs removes only the paths this script writes, so a rerun
// after a partial failure cannot leave a previous version's binary behind for
// GoReleaser to package silently.
function cleanOwnedOutputs(outDir) {
  for (const target of targets) {
    rmSync(join(outDir, `ccusage_${target.goos}_${target.goarch}`), { recursive: true, force: true })
  }
  rmSync(join(outDir, 'LICENSE.ccusage'), { force: true })
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const version = flags.version || readExpectedVersion()
  const outDir = flags.out || 'dist-ccusage'
  mkdirSync(outDir, { recursive: true })
  cleanOwnedOutputs(outDir)
  for (const target of targets) {
    const name = await bundleOne(target, version, outDir)
    console.log(`bundled ${name} (ccusage ${version})`)
  }
  await fetchLicense(version, outDir)
  console.log(`bundled LICENSE.ccusage (ccusage ${version})`)
}

// The entry guard compares canonical paths: `import.meta.url` is resolved
// through symlinks while `process.argv[1]` is whatever the caller typed, so a
// plain string compare silently no-ops when the script is reached through a
// symlink (the same guard bug fixed across skills/tokenboard/scripts).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(importMetaUrl)
  } catch {
    return false
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`bundle-ccusage: ${error.message}`)
    process.exit(1)
  })
}
