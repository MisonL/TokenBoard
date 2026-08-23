#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { errorMessage } from './error-message.mjs'
import { refreshInstalledNotifyHandler } from './hooks.mjs'

export function runRefreshNotifyHandlerCli(options = {}) {
  try {
    const result = (options.refresh || refreshInstalledNotifyHandler)(options)
    console.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runRefreshNotifyHandlerCli()
}
