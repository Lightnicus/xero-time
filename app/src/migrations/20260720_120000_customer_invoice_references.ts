import type { ApplicationIndex } from './20260718_001700_application_indexes'
import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-mongodb'

export const CUSTOMER_INVOICE_REFERENCE_INDEXES: readonly ApplicationIndex[] = [
  {
    collection: 'customers',
    key: { invoiceReferenceCode: 1 },
    name: 'invoiceReferenceCode_1',
    partialFilterExpression: { invoiceReferenceCode: { $type: 'string' } },
    unique: true,
  },
  {
    collection: 'invoice-exports',
    key: { customer: 1, customerReferenceSequence: 1 },
    name: 'customer_1_customerReferenceSequence_1_unique_when_present',
    partialFilterExpression: { customerReferenceSequence: { $type: 'number' } },
    unique: true,
  },
]

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

const samePartialFilter = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null)

/**
 * Historical customers and exports do not have reference fields. The partial
 * indexes exclude those documents (and explicit nulls) without rewriting them,
 * while protecting all new codes and per-customer sequences.
 * The compound index also supports a reverse scan for a customer's highest
 * allocated sequence.
 */
export async function up({ payload }: MigrateUpArgs): Promise<void> {
  const database = payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable while creating customer reference index.')

  for (const definition of CUSTOMER_INVOICE_REFERENCE_INDEXES) {
    const collection = database.collection(definition.collection)
    const existing = (await collection.indexes()).find((index) => index.name === definition.name)
    if (existing) {
      if (!sameKey(existing.key, definition.key)) {
        throw new Error(
          `Refusing to replace unexpected index ${definition.collection}.${definition.name}.`,
        )
      }
      const optionsMatch =
        Boolean(existing.unique) === Boolean(definition.unique) &&
        Boolean(existing.sparse) === Boolean(definition.sparse) &&
        samePartialFilter(existing.partialFilterExpression, definition.partialFilterExpression)
      if (optionsMatch) continue

      // An early development build created invoiceReferenceCode_1 as sparse.
      // Sparse unique indexes still index explicit nulls, so replace that exact
      // key with the partial index before optional legacy records are written.
      await collection.dropIndex(definition.name)
    }

    await collection.createIndex(definition.key, {
      ...(definition.partialFilterExpression
        ? { partialFilterExpression: definition.partialFilterExpression }
        : {}),
      ...(definition.sparse ? { sparse: true } : {}),
      name: definition.name,
      unique: definition.unique,
    })
  }
}

export async function down({ payload }: MigrateDownArgs): Promise<void> {
  payload.logger.warn(
    'Customer invoice reference indexes are retained on down migration to prevent identity or sequence reuse.',
  )
}
