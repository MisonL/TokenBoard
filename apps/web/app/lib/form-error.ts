import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ApiError, type ApiErrorCode } from './errors'

// A plain HTML form POST cannot answer with a JSON body: the browser renders it as the page and
// the user's edits are gone. Routes catch this, redirect back with `?error=<code>`, and the page
// renders the message for that code. The subclass keeps the status and message the JSON API
// already returned, so non-form callers see no change — a "not found" stays a 404 rather than
// being flattened into a validation failure.
export class FormError extends ApiError {
  constructor(
    readonly formErrorCode: string,
    message: string,
    code: ApiErrorCode = 'BAD_REQUEST',
    status: ContentfulStatusCode = 400
  ) {
    super(code, message, status)
  }
}

export function formErrorCode(error: unknown): string | null {
  return error instanceof FormError ? error.formErrorCode : null
}
