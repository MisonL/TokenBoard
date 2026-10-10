import { ZodError } from 'zod'
import { FormError, formErrorCode } from '../../lib/form-error'

// Codes are a closed set so a redirect cannot carry arbitrary text. The values are rendered
// verbatim on the settings pages, so they are written for the person who submitted the form.
export const settingsFormErrorMessages = {
  'invalid-profile':
    '请检查填写内容：slug 只能使用小写字母、数字和连字符（3-32 位），显示名称为 1-80 个字符，时区需为有效的 IANA 时区名。',
  'invalid-card': '公开卡片的标题最多 48 个字符，副标题最多 96 个字符。',
  'profile-not-found': '资料不存在，请刷新页面后重试。',
  'slug-reserved': '这个 slug 是保留名称，请换一个。',
  'slug-taken': '这个 slug 已被占用，请换一个。'
} satisfies Record<string, string>

export type SettingsFormErrorCode = keyof typeof settingsFormErrorMessages

export function settingsFormErrorMessage(code: string | undefined) {
  if (!code) return undefined
  // A `?error=` query is user-controlled. Bracket lookup would walk the prototype chain, so
  // `?error=constructor` would resolve to `Object`'s own function and render an empty banner;
  // ownership is required to reach a message.
  if (!Object.prototype.hasOwnProperty.call(settingsFormErrorMessages, code)) return undefined
  return settingsFormErrorMessages[code as SettingsFormErrorCode]
}

// Route catch blocks use this to decide between a redirect (a validation failure the page can
// explain) and the JSON error path (anything else). A Zod failure on the profile form is the
// schema rejecting the submitted values; an unknown FormError code is treated as unexpected so
// a typo cannot send the user to a blank error banner.
export function settingsFormErrorCodeForRedirect(error: unknown): SettingsFormErrorCode | null {
  if (error instanceof ZodError) return 'invalid-profile'
  // A non-400 FormError — `profile-not-found` is the one the service raises, with a 404 — keeps
  // its status and takes the JSON path, matching FormError's contract that a not-found is not
  // flattened into a validation banner.
  if (error instanceof FormError && error.status !== 400) return null
  const code = formErrorCode(error)
  return code && Object.prototype.hasOwnProperty.call(settingsFormErrorMessages, code)
    ? (code as SettingsFormErrorCode)
    : null
}
