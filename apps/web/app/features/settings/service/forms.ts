import { ZodError } from 'zod'
import { parsePublicCardConfigForm } from '../../public-card/config'
import { FormError } from '../../../lib/form-error'
import { publicProfileSchema, type PublicProfileInput } from '../schema'
import type { ProfilePageInput } from './types'

export function parseProfileForm(form: Record<string, unknown>): PublicProfileInput {
  return publicProfileSchema.parse({
    slug: String(form.slug || ''),
    displayName: String(form.displayName || ''),
    timezone: String(form.timezone || 'UTC'),
    isPublic: form.isPublic === 'on',
    participatesInLeaderboards: form.participatesInLeaderboards === 'on'
  })
}

export function parseProfilePageForm(form: Record<string, unknown>): ProfilePageInput {
  const profile = parseProfileForm(form)
  // The card section is a second, independent schema. Letting its ZodError escape as-is would
  // reach the route as a bare ZodError and be reported as `invalid-profile`, telling the user
  // their slug or timezone is wrong when the card title is what failed; tag it so the page
  // explains the right field.
  let publicCardConfig
  try {
    publicCardConfig = parsePublicCardConfigForm(form)
  } catch (error) {
    if (error instanceof ZodError) throw new FormError('invalid-card', 'Public card config is invalid')
    throw error
  }
  return { profile, publicCardConfig }
}
