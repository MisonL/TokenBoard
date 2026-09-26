const reservedPublicSlugs = new Set(['model-pricing'])

export function isReservedPublicSlug(slug: string) {
  return reservedPublicSlugs.has(slug.toLowerCase())
}
