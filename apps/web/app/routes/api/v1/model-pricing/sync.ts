import { createRoute } from 'honox/factory'
import {
  modelPricingSyncEnabled,
  parsePricingSyncToken,
  pricingSyncTokenConfigured,
  readModelPricingSyncState,
  runModelPricingSync,
  verifyPricingSyncToken
} from '../../../../features/model-pricing/service'
import { ApiError } from '../../../../lib/errors'
import { jsonError } from '../../../../lib/http'
import {
  assertRateLimitAvailable,
  clientIpRateLimitSubject,
  enforceRateLimit,
  writeRateLimitPolicies
} from '../../../../lib/rate-limit'

export const POST = createRoute(async (c) => {
  try {
    if (!pricingSyncTokenConfigured(c.env)) {
      throw new ApiError('INTERNAL_SERVER_ERROR', 'Model pricing sync is not configured', 500)
    }
    // Read the flag before doing any work: an invalid TOKENBOARD_MODEL_PRICING_SYNC_ENABLED
    // throws, and reading it while building the response discarded a sync that had already
    // succeeded behind a 500.
    const scheduledSyncEnabled = modelPricingSyncEnabled(c.env)
    const clientIp = clientIpRateLimitSubject(c.req.raw.headers)
    const authorization = c.req.header('authorization')
    await assertRateLimitAvailable(c.env.DB, {
      policy: writeRateLimitPolicies.modelPricingSyncInvalidIp,
      subject: clientIp
    })
    const pricingSyncToken = parsePricingSyncToken(authorization)
    const verified = await verifyPricingSyncToken(c.env, authorization)
    if (!verified || !pricingSyncToken) {
      await enforceRateLimit(c.env.DB, {
        policy: writeRateLimitPolicies.modelPricingSyncInvalidIp,
        subject: clientIp
      })
      throw new ApiError('UNAUTHORIZED', 'Invalid model pricing sync token', 401)
    }
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.modelPricingSyncToken,
      subject: { kind: 'sync-token', value: pricingSyncToken }
    })
    const result = await runModelPricingSync({
      env: c.env,
      force: true
    })
    const syncState = await readModelPricingSyncState(c.env.DB)
    c.header('Cache-Control', 'no-store')
    return c.json({ ...result, scheduledSyncEnabled, syncState })
  } catch (error) {
    return jsonError(c, error)
  }
})
