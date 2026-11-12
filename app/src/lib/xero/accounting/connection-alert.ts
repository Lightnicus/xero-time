import 'server-only'

import type { AppSession } from '@/lib/member-app/session'

import { XERO_RECONNECT_EXPORT_CODE } from './recovery'

export type XeroConnectionAlert = {
  tenantName?: string
  waitingExports: number
}

/** Reports a Xero accounting connection that stopped working, for the app-wide banner. */
export async function getXeroConnectionAlert(
  session: AppSession,
): Promise<XeroConnectionAlert | null> {
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
    tenantName: connection.tenantName ?? undefined,
    waitingExports: waiting.totalDocs,
  }
}
