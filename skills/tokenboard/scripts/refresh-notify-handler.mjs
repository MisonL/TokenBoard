#!/usr/bin/env node
import { isMainModule } from './is-main.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { errorMessage } from './error-message.mjs'
import { refreshInstalledNotifyHandler } from './hooks.mjs'

const usage = 'Usage: refresh-notify-handler.mjs'

export function runRefreshNotifyHandlerCli(argv = process.argv.slice(2), options = {}) {
  if (printHelpIfRequested(argv, usage)) {
    return 0
  }
  try {
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
