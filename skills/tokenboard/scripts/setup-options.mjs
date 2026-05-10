export function buildInstallCollectorArgs({ flags = {}, packageManager, installCollectorScript = './install-collector.mjs' } = {}) {
  const args = [installCollectorScript]
  if (flags['repo-url']) {
    args.push('--repo-url', flags['repo-url'])
  }
  if (packageManager) {
    args.push('--package-manager', packageManager)
  }
  return args
}
