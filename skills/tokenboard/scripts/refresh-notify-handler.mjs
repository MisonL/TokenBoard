#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { errorMessage } from './error-message.mjs'
import { refreshInstalledNotifyHandler } from './hooks.mjs'
import { ensureLauncher } from './launcher.mjs'
import { configDir as defaultConfigDir } from './config.mjs'

const usage = 'Usage: refresh-notify-handler.mjs'

export function runRefreshNotifyHandlerCli(argv = process.argv.slice(2), options = {}) {
  if (printHelpIfRequested(argv, usage)) {
    return 0
  }
  try {
    // Refresh the launcher before regenerating the handler: the handler now
    // spawns through <configDir>/bin/tokenboard-launcher.mjs, and after an
    // upgrade the vendored copies must come from the freshly installed skill
    // tree. ensureLauncher is idempotent.
    const configDirectory = options.configDirectory || defaultConfigDir()
    ensureLauncher({
      configDir: configDirectory,
      sourceDir: options.sourceDir || fileURLToPath(new URL('.', import.meta.url)),
      platform: options.platform
    })
    const result = (options.refresh || refreshInstalledNotifyHandler)(options)
    console.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runRefreshNotifyHandlerCli()
}
