import type { Payload } from 'payload'

/**
 * Payload types database models as an open record. Centralising the runtime
 * assertion keeps direct Mongo operations fail-closed when a collection slug is
 * misspelled or omitted from the active configuration.
 */
export function requireMongoModel(payload: Payload, slug: string) {
  const model = payload.db.collections[slug]

  if (!model) {
    throw new Error(`Mongo model ${slug} is unavailable.`)
  }

  return model
}
