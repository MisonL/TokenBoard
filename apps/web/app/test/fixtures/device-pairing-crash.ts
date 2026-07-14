import { createSqliteD1 } from '../sqlite-d1'
import { D1DevicePairingRepository } from '../../features/device/repository'
import { pairDevice } from '../../features/device/service'

const dbPath = process.argv[2]
if (!dbPath) throw new Error('Database path is required')

const repository = new D1DevicePairingRepository(createSqliteD1(dbPath))
repository.createUploadTokenAndDevice = async () => {
  process.exit(42)
}

await pairDevice(
  repository,
  {
    pairingCode: 'pairing-code',
    deviceName: 'Workstation',
    platform: 'linux',
    timezone: 'UTC'
  },
  {
    now: () => '2026-07-11T01:00:00.000Z',
    endpoint: 'https://tokenboard.example/api/v1/ingest',
    randomId: () => 'attempt',
    randomToken: () => 'upload-token',
    randomInstallClaim: () => 'install-claim',
    hash: async (value) => `hash:${value}`
  }
)
