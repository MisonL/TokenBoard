export function hasHelpFlag(argv = []) {
  return argv.some((arg) => arg === '--help' || arg === '-h')
}

export function printHelpIfRequested(argv, usage, log = console.log) {
  if (!hasHelpFlag(argv)) return false
  log(usage)
  return true
}
