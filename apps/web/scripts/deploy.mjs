import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const configPath = resolveDeployConfigPath()

runNode(['scripts/check-production-config.mjs'], {
  ...process.env,
  TOKENBOARD_WRANGLER_CONFIG: configPath
})

runPnpm(['run', 'build'])
runPnpm(['exec', 'wrangler', 'deploy', '--dry-run', '--config', configPath])
if (!process.env.CLOUDFLARE_API_TOKEN?.trim() && !process.env.CF_API_TOKEN?.trim()) {
  runPnpm(['exec', 'wrangler', 'whoami'])
}
runNode(['scripts/check-production-route.mjs'], {
  ...process.env,
  TOKENBOARD_WRANGLER_CONFIG: configPath
})
runPnpm(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath])

// Post-migration schema gates. Each file raises on a violation and exits non-zero, so a
// failure here stops the deploy before the Worker is published. The foreign-key check is
// last because it validates data, not shape: a missing table would make it fail with a
// less specific error than the schema checks above.
//
// `--yes` is required, not cosmetic: `wrangler d1 execute --file --remote` only prompts when
// the process is interactive (`isInteractive4 && !yes && !json2`), and declining returns null,
// which the command treats as a no-op and exits 0. Without `--yes` an operator who answers
// "n" once would leave every gate unrun while deploy.mjs reads a zero status and publishes
// the Worker — a silent green. `d1 migrations apply` above has no such flag, but it uses
// `confirm2` with `fallbackValue: true`, so its non-interactive path still proceeds.
for (const file of [
  'db/verify-critical-schema.sql',
  'db/verify-rate-limit-index.sql',
  'db/verify-retention-index.sql',
  'db/verify-foreign-keys.sql'
]) {
  runPnpm(['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--file', file, '--yes', '--config', configPath])
}

runPnpm(['exec', 'wrangler', 'deploy', '--config', configPath])

function resolveDeployConfigPath() {
  const envPath = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim()
  if (envPath) return envPath

  const privateConfigPath = 'wrangler.production.jsonc'
  if (existsSync(privateConfigPath)) return privateConfigPath

  const generatedConfigPath = 'wrangler.production.ci.jsonc'
  runNode(['scripts/write-production-config.mjs', 'wrangler.production.example.jsonc', generatedConfigPath])
  return generatedConfigPath
}

function runNode(args, extraEnv) {
  run(process.execPath, args, extraEnv)
}

function runPnpm(args, extraEnv) {
  const packageManagerCli = process.env.TOKENBOARD_PNPM_CLI?.trim() || process.env.npm_execpath?.trim()
  if (packageManagerCli) {
    run(process.execPath, [packageManagerCli, ...args], extraEnv)
    return
  }
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, extraEnv)
}

function run(command, args, extraEnv) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    cwd: process.cwd()
  })
  if (result.status !== 0) {
    if (result.error) console.error(`Failed to start ${command}: ${result.error.message}`)
    process.exit(result.status ?? 1)
  }
}
