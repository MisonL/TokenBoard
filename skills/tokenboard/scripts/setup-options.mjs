export function buildInitialSyncArgs({ flags = {} } = {}) {
  return [
    '--mode',
    'sync',
    '--source',
    'all',
    '--since',
    flags.since || 'all'
  ]
}

export function buildInstallCollectorArgs({ flags = {}, installCollectorScript = './install-collector.mjs' } = {}) {
  const args = [installCollectorScript]
  if (flags['repo-url']) {
    args.push('--repo-url', flags['repo-url'])
  }
  return args
}
