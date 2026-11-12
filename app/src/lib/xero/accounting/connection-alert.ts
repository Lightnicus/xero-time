import 'server-only'

import { hasActiveRole } from '@/access/roles'
import type { AppSession } from '@/lib/member-app/session'

import { XERO_RECONNECT_EXPORT_CODE } from './recovery'

export type XeroConnectionAlert = {
  /** Whether this user can reconnect Xero themselves. */
  canReconnect: boolean
  tenantName?: string
  waitingExports: number
}

/**
 * Reports a Xero accounting connection that stopped working to the people it affects: owners
 * and admins, who can reconnect it, and billers, whose exports wait for it. It reveals only the
 * organisation name and a count, never credentials or error details.
 */
export async function getXeroConnectionAlert(
  session: AppSession,
): Promise<XeroConnectionAlert | null> {
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller'])) return null

  const result = await session.payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    select: { status: true, tenantName: true },
    where: { singletonKey: { equals: 'business-accounting' } },
  })
  const connection = result.docs[0]
  if (connection?.status !== 'action-required') return null

  const waiting = await session.payload.count({
    collection: 'invoice-exports',
    overrideAccess: true,
    where: {
      and: [
        { lastErrorCode: { equals: XERO_RECONNECT_EXPORT_CODE } },
        { state: { in: ['retry-wait', 'reconciling'] } },
      ],
    },
  })

  return {
    canReconnect: hasActiveRole(session.user, ['owner', 'admin']),
    tenantName: connection.tenantName ?? undefined,
    waitingExports: waiting.totalDocs,
  }
}
