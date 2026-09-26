import { describe, expect, test } from 'vitest'
import { defaultPublicCardConfig } from '../public-card/config'
import { vi } from 'vitest'
import {
  getCanonicalPublicOrigin,
  getProfileDisplayName,
  getProfileSettings,
  getProfileTimezoneSettings,
  parseProfilePageForm,
  parseProfileForm,
  updateProfilePageSettings,
  updateProfileSettings
} from './service'

describe('settings service', () => {
  test('prefers configured public origin over request origin', () => {
    expect(
      getCanonicalPublicOrigin({
        configuredOrigin: 'https://tokenboard.example.com/',
        requestOrigin: 'https://preview.example.com'
      })
    ).toBe('https://tokenboard.example.com')
  })

  test('parses public profile form checkboxes', () => {
    expect(
      parseProfileForm({
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: 'on',
        participatesInLeaderboards: 'on'
      })
    ).toEqual({
      slug: 'eve-tokenboard',
      displayName: 'Eve',
      timezone: 'Asia/Hong_Kong',
      isPublic: true,
      participatesInLeaderboards: true
    })
  })

  test('rejects invalid profile timezones', () => {
    expect(() =>
      parseProfileForm({
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Mars/Base'
      })
    ).toThrow()
  })

  test('parses profile page form with public card config', () => {
    expect(
      parseProfilePageForm({
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: 'on',
        cardLanguage: 'en',
        cardTheme: 'light',
        cardMetric1: 'todayTokens',
        cardMetric2: 'totalCost'
      })
    ).toMatchObject({
      profile: {
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: true
      },
      publicCardConfig: {
        language: 'en',
        theme: 'light',
        metrics: ['todayTokens', 'totalCost']
      }
    })
  })

  test('updates profile after checking slug ownership', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return null
              },
              async run() {
                return { success: true, meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateProfileSettings(
      db,
      'user_1',
      {
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: true,
        participatesInLeaderboards: false
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(sqlStatements[0]).toContain('SELECT user_id as userId FROM profiles')
    expect(sqlStatements[1]).toContain('UPDATE profiles')
    expect(sqlStatements[1]).toContain("timezone_source = 'user'")
    expect(bindings[0]).toEqual(['eve-tokenboard', 'user_1'])
    expect(bindings[1]).toEqual([
      'eve-tokenboard',
      'Eve',
      'Asia/Hong_Kong',
      1,
      0,
      '2026-04-29T10:00:00.000Z',
      'user_1',
      'eve-tokenboard',
      'user_1'
    ])
  })

  test('uses the canonical origin for public URLs', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'Asia/Hong_Kong',
                  isPublic: 1,
                  participatesInLeaderboards: 1,
                  createdAt: '2026-04-29T10:00:00.000Z',
                  updatedAt: '2026-04-29T10:00:00.000Z'
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.publicJsonUrl).toBe('https://tokenboard.example.com/api/public/eve-tokenboard.json')
    expect(settings.publicSvgUrl).toBe('https://tokenboard.example.com/api/public/eve-tokenboard.svg')
    expect(settings.publicMarkdown).toBe(
      '[![TokenBoard](https://tokenboard.example.com/api/public/eve-tokenboard.svg)](https://tokenboard.example.com)'
    )
    expect(settings.publicCardConfig).toEqual(defaultPublicCardConfig)
    expect(settings.shouldUseBrowserTimezoneDefault).toBe(false)
  })

  test('reads stored public card config from profile settings', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  publicCardConfig: JSON.stringify({
                    language: 'en',
                    theme: 'light',
                    metrics: ['todayTokens', 'totalCost']
                  }),
                  isPublic: 1,
                  participatesInLeaderboards: 1
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.publicCardConfig).toMatchObject({
      language: 'en',
      theme: 'light',
      metrics: ['todayTokens', 'totalCost']
    })
  })

  test('normalizes legacy profile values for settings pages', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_1',
                  slug: 'MisonL Profile!',
                  displayName: '  MisonL  ',
                  timezone: 'Mars/Base',
                  isPublic: 1,
                  participatesInLeaderboards: 1
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.slug).toBe('misonl-profile')
    expect(settings.displayName).toBe('MisonL')
    expect(settings.timezone).toBe('UTC')
    expect(settings.profileNeedsRepair).toBe(true)
    expect(settings.publicCardConfig).toEqual(defaultPublicCardConfig)
  })

  test('does not normalize legacy profile values to a reserved public slug', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_123',
                  slug: 'MODEL-PRICING',
                  displayName: 'Model Pricing',
                  timezone: 'UTC',
                  isPublic: 1,
                  participatesInLeaderboards: 0
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_123', 'https://tokenboard.example.com')

    expect(settings.slug).toBe('user-123')
    expect(settings.publicJsonUrl).toBe('https://tokenboard.example.com/api/public/user-123.json')
    expect(settings.profileNeedsRepair).toBe(true)
  })

  test('uses a stable user-specific fallback when every legacy slug candidate is reserved', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'model-pricing',
                  slug: 'MODEL-PRICING',
                  displayName: 'Model Pricing',
                  timezone: 'UTC',
                  isPublic: 1,
                  participatesInLeaderboards: 0
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'model-pricing', 'https://tokenboard.example.com')

    expect(settings.slug).toBe('user-model-pricing')
    expect(settings.slug).not.toBe('model-pricing')
  })

  test('reads profile timezone without requiring public card columns', async () => {
    let statement = ''
    const db = {
      prepare(sql: string) {
        statement = sql
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_1',
                  timezone: 'Mars/Base',
                  timezoneSource: 'default'
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileTimezoneSettings(db, 'user_1')

    expect(statement).toContain('timezone')
    expect(statement).not.toContain('public_card_config')
    expect(settings.timezone).toBe('UTC')
    expect(settings.profileNeedsRepair).toBe(true)
  })

  test('marks default UTC profiles as browser-timezone default candidates', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  isPublic: 0,
                  participatesInLeaderboards: 0,
                  timezoneSource: 'default',
                  createdAt: '2026-04-29T10:00:00.000Z',
                  updatedAt: '2026-04-29T10:00:00.000Z'
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.shouldUseBrowserTimezoneDefault).toBe(true)
  })

  test('does not mark user-saved UTC profiles for browser timezone autofill', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  timezoneSource: 'user',
                  isPublic: 0,
                  participatesInLeaderboards: 0,
                  createdAt: '2026-04-29T10:00:00.000Z',
                  updatedAt: '2026-04-29T10:00:00.000Z'
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.shouldUseBrowserTimezoneDefault).toBe(false)
  })

  test('uses the profile display name for dashboard labels', async () => {
    const db = {
      prepare(sql: string) {
        expect(sql).toContain('SELECT display_name as displayName FROM profiles')
        return {
          bind(userId: string) {
            expect(userId).toBe('user_1')
            return {
              async first() {
                return { displayName: 'New Public Name' }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getProfileDisplayName(db, 'user_1', 'Old Session Name')).resolves.toBe('New Public Name')
  })

  test('falls back to the session name when profile display name is missing', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getProfileDisplayName(db, 'user_1', 'Old Session Name')).resolves.toBe('Old Session Name')
  })

  test('makes a profile public when enabling leaderboard participation', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return null
              },
              async run() {
                return { success: true, meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateProfileSettings(
      db,
      'user_1',
      {
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: true
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(bindings[1]).toEqual([
      'eve-tokenboard',
      'Eve',
      'UTC',
      1,
      1,
      '2026-04-29T10:00:00.000Z',
      'user_1',
      'eve-tokenboard',
      'user_1'
    ])
  })

  test('updates profile and card settings together', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return null
              },
              async run() {
                return { success: true, meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateProfilePageSettings(
      db,
      'user_1',
      {
        profile: {
          slug: 'eve-tokenboard',
          displayName: 'Eve',
          timezone: 'UTC',
          isPublic: false,
          participatesInLeaderboards: true
        },
        publicCardConfig: {
          ...defaultPublicCardConfig,
          language: 'en',
          metrics: ['todayTokens']
        }
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(sqlStatements[1]).toContain('public_card_config = ?')
    expect(bindings[1]).toEqual([
      'eve-tokenboard',
      'Eve',
      'UTC',
      JSON.stringify({
        ...defaultPublicCardConfig,
        language: 'en',
        metrics: ['todayTokens']
      }),
      1,
      1,
      '2026-04-29T10:00:00.000Z',
      'user_1',
      'eve-tokenboard',
      'user_1'
    ])
  })

  test('clears card config when resetting to defaults', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return null
              },
              async run() {
                return { success: true, meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateProfilePageSettings(
      db,
      'user_1',
      {
        profile: {
          slug: 'eve-tokenboard',
          displayName: 'Eve',
          timezone: 'UTC',
          isPublic: true,
          participatesInLeaderboards: false
        },
        publicCardConfig: null
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(bindings[1][3]).toBeNull()
  })

  test('rejects a slug owned by another user', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { userId: 'other-user' }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'taken',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  // The pre-check reads and the UPDATE writes in separate statements, so two users can
  // pass the check at the same time. The write then matches no row for whichever loses.
  // That must surface as a conflict, not as a save that silently did nothing.
  // The race the guard exists for: the pre-check saw no conflict, a concurrent writer took
  // the slug, and the guarded UPDATE then matched no row. The cause lookup that runs on a
  // zero-row result is what distinguishes this from a missing profile row.
  test('reports a conflict when the update matches no row', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                // Pre-check: free. Cause lookup after the zero-row UPDATE: taken.
                return lookups++ === 0 ? null : { userId: 'user_2' }
              },
              async run() {
                return { meta: { changes: 0 } } // the guarded UPDATE changed nothing
              }
            }
          }
        }
      }
    } as unknown as D1Database
    let lookups = 0

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'raced',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Slug is already taken' })
  })

  // Zero changed rows can also mean there is no profile row for this user. Calling that a
  // slug conflict sends the caller to edit a slug that was never the problem.
  test('reports a missing profile rather than a slug conflict when no row matches', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null // no conflict, and no profile row either
              },
              async run() {
                return { meta: { changes: 0 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_missing', {
        slug: 'brand-new',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('saves when the guarded update changes a row', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'free',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).resolves.toBeUndefined()
  })

  // The WHERE guard should keep this unreachable, but if the UNIQUE index ever does
  // fire, the caller must still get a conflict rather than an opaque 500.
  test('reports a conflict when the UNIQUE index rejects the write', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null
              },
              async run() {
                throw new Error('UNIQUE constraint failed: profiles.slug')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'raced',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Slug is already taken' })
  })

  test('does not mask an unrelated write failure as a conflict', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null
              },
              async run() {
                throw new Error('D1_ERROR: no such table')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'free',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toThrow(/no such table/)
  })

  test('rejects slugs reserved for public API endpoints', async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null)
      }))
    }))
    const db = { prepare } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'model-pricing',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Slug is reserved' })
    expect(prepare).not.toHaveBeenCalled()
  })

  test('rejects reserved slugs case-insensitively for existing owners too', async () => {
    const prepare = vi.fn()
    const db = { prepare } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'MODEL-PRICING',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Slug is reserved' })
    expect(prepare).not.toHaveBeenCalled()
  })

  test('rejects reserved slugs for a non-owner updating the profile page', async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null)
      }))
    }))
    const db = { prepare } as unknown as D1Database

    await expect(
      updateProfilePageSettings(db, 'user_1', {
        profile: {
          slug: 'model-pricing',
          displayName: 'Eve',
          timezone: 'UTC',
          isPublic: false,
          participatesInLeaderboards: false
        },
        publicCardConfig: null
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Slug is reserved' })
    expect(prepare).not.toHaveBeenCalled()
  })
})
