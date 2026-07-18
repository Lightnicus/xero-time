import { config as loadEnvironment } from 'dotenv'

import { APPLICATION_INDEXES } from '@/migrations/20260718_001700_application_indexes'

loadEnvironment()

const sameKey = (
  actual: Record<string, unknown> | undefined,
  expected: Record<string, -1 | 1>,
): boolean => {
  if (!actual) return false
  const actualEntries = Object.entries(actual)
  const expectedEntries = Object.entries(expected)
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], index) =>
        actualEntries[index]?.[0] === field && actualEntries[index]?.[1] === direction,
    )
  )
}

const [{ getPayload }, { default: config }] = await Promise.all([
  import('payload'),
  import('../src/payload.config'),
])
const payload = await getPayload({ config })
let verificationError: unknown
try {
  const database = payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable for index verification.')
  const failures: string[] = []

  for (const expected of APPLICATION_INDEXES) {
    const indexes = await database.collection(expected.collection).indexes()
    const found = indexes.find((index) => index.name === expected.name)
    const valid =
      sameKey(found?.key, expected.key) &&
      (!expected.unique || found?.unique === true) &&
      (!expected.sparse || found?.sparse === true) &&
      (typeof expected.expireAfterSeconds !== 'number' ||
        found?.expireAfterSeconds === expected.expireAfterSeconds) &&
      (!expected.partialFilterExpression ||
        JSON.stringify(found?.partialFilterExpression) ===
          JSON.stringify(expected.partialFilterExpression))
    if (!valid) failures.push(`${expected.collection}: ${expected.name}`)
  }

  if (failures.length > 0) throw new Error(`Missing or invalid indexes:\n${failures.join('\n')}`)
  payload.logger.info({
    checked: APPLICATION_INDEXES.length,
    event: 'database.index-verification-passed',
  })
} catch (error) {
  verificationError = error
}

// The verifier is a short-lived, read-only command. Payload/Mongoose can keep
// monitoring handles alive after destroy on some Node versions, so initiate a
// graceful close and then return a deterministic command status.
void payload.destroy()
if (verificationError) {
  const message =
    verificationError instanceof Error ? verificationError.message : 'Index verification failed.'
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
process.exit(0)
