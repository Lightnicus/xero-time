import { isActiveUser } from '@/access/roles'
import { relationshipID } from '@/lib/domain/validation'
import { hashOpaqueValue } from '@/lib/xero/accounting/crypto'

import { EXTERNAL_SESSION_COOKIE } from './constants'

import type { AuthStrategy } from 'payload'

const readCookie = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=')
    if (separator < 1) continue
    if (segment.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/** Authenticates only the application's opaque cookie; no Xero token reaches this strategy. */
export const xeroExternalSessionStrategy: AuthStrategy = {
  name: 'xero-external-session',
  async authenticate({ headers, payload }) {
    const rawToken = readCookie(headers.get('cookie'), EXTERNAL_SESSION_COOKIE)
    if (!rawToken || rawToken.length < 40 || rawToken.length > 500) return { user: null }

    const sessions = await payload.find({
      collection: 'external-auth-sessions',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      showHiddenFields: true,
      where: { tokenHash: { equals: hashOpaqueValue(rawToken) } },
    })
    const externalSession = sessions.docs[0]
    if (!externalSession || externalSession.status !== 'active') return { user: null }

    const now = new Date()
    const idleExpiry = new Date(externalSession.idleExpiresAt)
    const absoluteExpiry = new Date(externalSession.absoluteExpiresAt)
    if (
      Number.isNaN(idleExpiry.getTime()) ||
      Number.isNaN(absoluteExpiry.getTime()) ||
      idleExpiry <= now ||
      absoluteExpiry <= now
    ) {
      await payload.update({
        collection: 'external-auth-sessions',
        id: externalSession.id,
        data: {
          cleanupAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
          revocationReason: 'expired',
          revokedAt: now.toISOString(),
          status: 'expired',
        },
        overrideAccess: true,
      })
      return { user: null }
    }

    const identityID = relationshipID(externalSession.identity)
    const userID = relationshipID(externalSession.user)
    if (identityID === null || userID === null) return { user: null }

    try {
      const [identity, user] = await Promise.all([
        payload.findByID({
          collection: 'auth-identities',
          depth: 0,
          id: identityID,
          overrideAccess: true,
          showHiddenFields: true,
        }),
        payload.findByID({
          collection: 'users',
          depth: 0,
          id: userID,
          overrideAccess: true,
        }),
      ])
      if (
        identity.status !== 'active' ||
        String(relationshipID(identity.user)) !== String(userID) ||
        !isActiveUser(user)
      ) {
        return { user: null }
      }

      const lastSeen = new Date(externalSession.lastSeenAt)
      if (!Number.isNaN(lastSeen.getTime()) && now.getTime() - lastSeen.getTime() >= 5 * 60_000) {
        const idleWindow = Math.max(15 * 60_000, idleExpiry.getTime() - lastSeen.getTime())
        await payload.update({
          collection: 'external-auth-sessions',
          id: externalSession.id,
          data: {
            idleExpiresAt: new Date(
              Math.min(now.getTime() + idleWindow, absoluteExpiry.getTime()),
            ).toISOString(),
            lastSeenAt: now.toISOString(),
          },
          overrideAccess: true,
        })
      }

      return {
        user: {
          ...user,
          _strategy: 'xero-external-session',
          collection: 'users',
        },
      }
    } catch {
      return { user: null }
    }
  },
}
