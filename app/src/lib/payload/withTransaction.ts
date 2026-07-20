import { randomUUID } from 'node:crypto'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

type TransactionOptions = {
  context?: PayloadRequest['context']
  user?: PayloadRequest['user']
}

const MAX_TRANSACTION_ATTEMPTS = 10

const hasMongoErrorLabel = (error: unknown, label: string, depth = 0): boolean => {
  if (!error || typeof error !== 'object' || depth > 4) return false
  const candidate = error as {
    cause?: unknown
    errorLabels?: unknown
    hasErrorLabel?: (value: string) => boolean
  }
  if (typeof candidate.hasErrorLabel === 'function' && candidate.hasErrorLabel(label)) return true
  if (Array.isArray(candidate.errorLabels) && candidate.errorLabels.includes(label)) return true
  return hasMongoErrorLabel(candidate.cause, label, depth + 1)
}

const hasRetryableMongoTransactionCode = (error: unknown, depth = 0): boolean => {
  if (!error || typeof error !== 'object' || depth > 4) return false
  const candidate = error as {
    cause?: unknown
    code?: unknown
    codeName?: unknown
    message?: unknown
  }
  // Payload/Mongoose can wrap these errors without preserving the driver's
  // label, so retain the documented Mongo transaction codes as a fallback.
  if (
    candidate.code === 112 ||
    candidate.code === 244 ||
    candidate.code === 251 ||
    candidate.codeName === 'WriteConflict' ||
    candidate.codeName === 'NoSuchTransaction' ||
    (typeof candidate.message === 'string' &&
      /WriteConflict|NoSuchTransaction|does not match any in-progress transactions/i.test(
        candidate.message,
      ))
  ) {
    return true
  }
  return hasRetryableMongoTransactionCode(candidate.cause, depth + 1)
}

const isRetryableTransactionError = (error: unknown): boolean =>
  hasMongoErrorLabel(error, 'TransientTransactionError') || hasRetryableMongoTransactionCode(error)

/**
 * Runs a Payload Local API command in the Mongo driver's transaction helper.
 * The driver owns commit-result and transient retries while Payload receives a
 * registered transaction ID, so all nested reads/writes use the same session.
 */
export async function withPayloadTransaction<T>(
  payload: Payload,
  callback: (req: PayloadRequest) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const req = await createLocalReq(
    {
      context: options.context,
      user: options.user ?? undefined,
    },
    payload,
  )
  const client = payload.db.connection.getClient()
  const session = client.startSession()
  const transactionID = randomUUID()
  let callbackAttempts = 0

  payload.db.sessions[transactionID] = session
  req.transactionID = transactionID

  try {
    const result = await session.withTransaction(async () => {
      // The MongoDB driver may retry this callback after Payload has removed
      // its request-to-session registration while unwinding the prior attempt.
      // Re-register the same live ClientSession before each driver attempt.
      payload.db.sessions[transactionID] = session
      req.transactionID = transactionID
      callbackAttempts += 1
      if (callbackAttempts > MAX_TRANSACTION_ATTEMPTS) {
        throw new Error('The MongoDB transaction retry limit was exhausted.')
      }
      try {
        return await callback(req)
      } catch (error) {
        if (isRetryableTransactionError(error)) {
          // Payload field traversal can have sibling validation reads still
          // settling when one read reports a transaction conflict. Keeping the
          // same session alive briefly prevents a late operation crossing into
          // the next driver-managed attempt.
          await new Promise((resolve) => setTimeout(resolve, Math.min(callbackAttempts * 25, 250)))
        }
        throw error
      }
    }, payload.db.transactionOptions)

    return result as T
  } finally {
    delete req.transactionID
    delete payload.db.sessions[transactionID]
    await session.endSession()
  }
}
