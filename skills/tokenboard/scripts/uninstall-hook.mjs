#!/usr/bin/env node
import { runUninstallHooksCli } from './hooks.mjs'
import { isMainModule } from './is-main.mjs'

if (isMainModule(import.meta.url)) {
  runUninstallHooksCli()
}
