import type { Access } from 'payload'

/**
 * The app has one kind of account: whoever signs in can do everything. Access checks only ask
 * whether the request comes from a signed-in user (as opposed to an anonymous request).
 */
export type SignedInUser = {
  collection: 'users'
  id: number | string
}

const isDocumentID = (value: unknown): value is number | string =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length > 0)

export const isSignedIn = (user: unknown): user is SignedInUser => {
  if (!user || typeof user !== 'object') return false
  const candidate = user as { collection?: unknown; id?: unknown }
  return candidate.collection === 'users' && isDocumentID(candidate.id)
}

export const authenticated: Access = ({ req }) => isSignedIn(req.user)

/** Payload Admin is open to the signed-in user. */
export const signedInAdmin = ({ req }: { req: { user?: unknown } }): boolean => isSignedIn(req.user)
