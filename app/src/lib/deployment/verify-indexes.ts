import { APPLICATION_INDEXES } from '@/migrations/20260718_001700_application_indexes'
import { CUSTOMER_INVOICE_REFERENCE_INDEXES } from '@/migrations/20260720_120000_customer_invoice_references'

import type { Payload } from 'payload'

const EXPECTED_INDEXES = [...APPLICATION_INDEXES, ...CUSTOMER_INVOICE_REFERENCE_INDEXES]

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

export const verifyApplicationIndexes = async (payload: Payload): Promise<void> => {
  const database = payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable for index verification.')
  const failures: string[] = []

  for (const expected of EXPECTED_INDEXES) {
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
    checked: EXPECTED_INDEXES.length,
    event: 'database.index-verification-passed',
  })
}
