// Two shapes are covered: URL userinfo (`https://user:token@host/…`, the form git echoes back
// in its errors) and credential-bearing query parameters. Signed URLs arrive under many names —
// `private_token`, `api_key`, `X-Amz-Signature` — so the parameter name is a family of
// hyphen/underscore-separated segments ending in `token`/`key`/`secret`/`signature`/
// `credential`/`password`/`auth`, not the handful of names git happens to use; matching only
// bare `token` left those literal in the log. A name must still sit on a segment boundary, so
// `monkey` or `keyboard` are not mistaken for `key`. The host and path stay, which is all a
// diagnostic needs. The userinfo rule stops at the first `/`, `?`, `#` or whitespace, so an `@`
// inside the query string cannot be mistaken for the userinfo delimiter and swallow the real
// host out of the line.
//
// Three more shapes a log outlives the terminal for: an `Authorization` header, a bare upload
// token (`tb_upload_…`, `tb_install_…`) outside any URL, and a webhook URL whose value carries
// the secret. The query rule also has to accept a `#` lead-in, since signed URLs are sometimes
// handed over in a fragment, and `webhook` is a parameter name the family above does not cover.
//
// A webhook secret is not always a query parameter: Discord-style URLs carry it as a path
// segment (`…/api/webhooks/<id>/<secret>`), which none of the rules above reach. The path rule
// keeps the host and the `/webhooks/` prefix — all a diagnostic needs — and redacts everything
// after it, so a provider that splits the secret over more segments is covered too. The value
// charset stops at whitespace and at the delimiters that can follow a URL inside a structured
// line (`"`, `'`, `,`, `;`, `)`, `}`, `]`, `>`, `<`), so redacting a URL inside a JSON log line
// does not eat the closing quote and the next key. A webhook secret never contains those, so the
// whole secret is still covered; a bare prefix with nothing after it is left alone.
//
// The two shapes below are lossy in ways that hid credentials, so each rule is anchored to the
// token's real character set and the auth scheme's real spelling:
// - The upload token body is base64url (`randomToken` in the web app maps `+`/`/` to `-`/`_`),
//   so the charset must include `-` and `_`. A trailing `\b` cannot end the match before a `_`
//   (`_` is a word character), which left tokens containing `_` untouched and tokens with `-`
//   only half-redacted, leaking the suffix.
// - HTTP auth schemes are case-insensitive (RFC 7235), and `Basic` carries the same secret as
//   `Bearer`, so both spellings in any case are redacted. This over-matches an English phrase
//   like "Basic authentication failed", but a real credential can be an all-letter base64 body
//   (`cGxhY2Vob2xkZXI`), so the rule stays wide: a missed credential is a leak, a redacted
//   phrase is only a less readable log line.
const credentialQueryName =
  '(?:[a-z0-9]+[_-])*(?:token|key|secret|signature|credential|password|passwd|auth(?:orization|_?token)?|webhook(?:_?url)?)'

export function redactUrlCredentials(line) {
  return String(line)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s?#]+@/gi, '$1')
    .replace(new RegExp(`([?&#]${credentialQueryName})=[^&#\\s]+`, 'gi'), '$1=<redacted>')
    .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi, '$1$2<redacted>')
    .replace(/\b(tb_(?:upload|install|pair)_)[A-Za-z0-9_-]+/g, '$1<redacted>')
    .replace(/(\/api\/webhooks\/)[^\s?#"'`<>,;)\]}]+/gi, '$1<redacted>')
}
