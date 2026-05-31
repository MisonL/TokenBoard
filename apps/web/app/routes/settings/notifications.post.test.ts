import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../features/auth/middleware'
import { sendWebhookTest } from '../../features/notifications/service'
import { POST } from './notifications'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../features/settings/service', () => ({
  getCanonicalPublicOrigin: vi.fn(),
  getProfileSettings: vi.fn()
}))

vi.mock('../../features/notifications/service', () => ({
  createWebhookSubscription: vi.fn(),
  deleteWebhookSubscription: vi.fn(),
  hasValidEncryptionKey: vi.fn(),
  listWebhookSubscriptions: vi.fn(),
  parseWebhookAction: (form: Record<string, unknown>) => String(form.action ?? ''),
  parseWebhookCreateForm: vi.fn(),
  parseWebhookId: (form: Record<string, unknown>) => String(form.subscriptionId ?? '').trim(),
  parseWebhookUpdateForm: vi.fn(),
  sendWebhookTest: vi.fn(),
  setWebhookSubscriptionEnabled: vi.fn(),
  updateWebhookSubscription: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedSendWebhookTest = vi.mocked(sendWebhookTest)

describe('notifications POST route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedSendWebhookTest.mockReset()
  })

  test('does not redirect failed webhook tests as sent', async () => {
    const context = postContext({ action: 'test', subscriptionId: 'sub_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedSendWebhookTest.mockResolvedValue({ status: 'failure' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(mockedSendWebhookTest).toHaveBeenCalledWith({
      env: context.env,
      userId: 'user_1',
      subscriptionId: 'sub_1'
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?testFailed=1')
  })

  test('redirects successful webhook tests as sent', async () => {
    const context = postContext({ action: 'test', subscriptionId: 'sub_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedSendWebhookTest.mockResolvedValue({ status: 'success' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?tested=1')
  })
})

function postContext(body: Record<string, unknown>) {
  return {
    env: { DB: {} },
    req: {
      parseBody: vi.fn(async () => body)
    },
    redirect: vi.fn((location: string, status = 302) => (
      new Response(null, { status, headers: { location } })
    ))
  }
}
