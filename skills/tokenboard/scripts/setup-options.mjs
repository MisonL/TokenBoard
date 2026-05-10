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
