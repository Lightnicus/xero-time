import 'server-only'

import { hasActiveRole } from '@/access/roles'
import { TIME_ENTRY_PRIVILEGED_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { recordAuditEvent } from '@/lib/audit/service'
import { durationToQuantityScaled, quantityRateAmountScaled } from '@/lib/billing/math'
import { stableHash } from '@/lib/billing/stable'
import type { AppSession } from '@/lib/member-app/session'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'

export type RateRecalculationPreview = {
  affectedCount: number
  currency: string
  currentRateScaled: number
  hash: string
  newValueScaled: number
  oldValueScaled: number
  projectCode: string
  projectID: string
  projectName: string
}

const assertAdministrator = (session: AppSession): void => {
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    throw new Error('Only an owner or administrator can recalculate rate snapshots.')
  }
}

export async function previewProjectRateRecalculation(
  session: AppSession,
  projectID: string,
): Promise<RateRecalculationPreview> {
  assertAdministrator(session)
  const project = await session.payload.findByID({
    collection: 'projects',
    depth: 0,
    id: projectID,
    overrideAccess: true,
    req: session.req,
  })
  if (!Number.isSafeInteger(project.hourlyRateScaled) || project.hourlyRateScaled <= 0) {
    throw new Error('Set a positive project rate before recalculating time entries.')
  }
  const entries = await session.payload.find({
    collection: 'time-entries',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    sort: ['workDate', 'id'],
    where: {
      and: [
        { project: { equals: project.id } },
        { billingStatus: { equals: 'unbilled' } },
        { rateSnapshotScaled: { not_equals: project.hourlyRateScaled } },
      ],
    },
  })
  let newValueScaled = 0
  let oldValueScaled = 0
  for (const entry of entries.docs) {
    const quantity = durationToQuantityScaled(entry.durationSeconds)
    oldValueScaled += quantityRateAmountScaled(quantity, entry.rateSnapshotScaled)
    newValueScaled += quantityRateAmountScaled(quantity, project.hourlyRateScaled)
  }
  const fingerprint = {
    entries: entries.docs.map((entry) => ({
      id: String(entry.id),
      rate: entry.rateSnapshotScaled,
      updatedAt: entry.updatedAt,
    })),
    projectID: String(project.id),
    rate: project.hourlyRateScaled,
  }
  return {
    affectedCount: entries.docs.length,
    currency: project.currency,
    currentRateScaled: project.hourlyRateScaled,
    hash: stableHash(fingerprint),
    newValueScaled,
    oldValueScaled,
    projectCode: project.code,
    projectID: String(project.id),
    projectName: project.name,
  }
}

export async function confirmProjectRateRecalculation(
  session: AppSession,
  input: { confirmation: string; expectedHash: string; projectID: string; reason: string },
): Promise<number> {
  assertAdministrator(session)
  const reason = input.reason.trim()
  if (reason.length < 10 || reason.length > 1_000) {
    throw new Error('Enter a recalculation reason from 10 to 1,000 characters.')
  }
  if (input.confirmation !== 'RECALCULATE') {
    throw new Error('Type RECALCULATE to confirm the commercial-rate change.')
  }

  return withPayloadTransaction(
    session.payload,
    async (req) => {
      const transactionSession: AppSession = { ...session, req }
      const preview = await previewProjectRateRecalculation(transactionSession, input.projectID)
      if (preview.hash !== input.expectedHash) {
        throw new Error('The project or selected unbilled entries changed. Review a fresh preview.')
      }
      if (preview.affectedCount === 0) return 0
      const entries = await session.payload.find({
        collection: 'time-entries',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        req,
        where: {
          and: [
            { project: { equals: input.projectID } },
            { billingStatus: { equals: 'unbilled' } },
            { rateSnapshotScaled: { not_equals: preview.currentRateScaled } },
          ],
        },
      })
      if (entries.docs.length !== preview.affectedCount) {
        throw new Error('The selected entries changed before recalculation.')
      }
      for (const entry of entries.docs) {
        await session.payload.update({
          collection: 'time-entries',
          context: { [TIME_ENTRY_PRIVILEGED_MUTATION_CONTEXT]: 'rate-recalculation' },
          data: { rateSnapshotScaled: preview.currentRateScaled },
          id: entry.id,
          overrideAccess: true,
          req,
        })
      }
      await recordAuditEvent(
        session.payload,
        {
          actor: session.user.id,
          after: {
            affectedCount: preview.affectedCount,
            rateScaled: preview.currentRateScaled,
            valueScaled: preview.newValueScaled,
          },
          before: { valueScaled: preview.oldValueScaled },
          eventType: 'time-entry.rate-recalculated',
          metadata: { entryIDs: entries.docs.map((entry) => String(entry.id)) },
          reason,
          targetCollection: 'projects',
          targetId: input.projectID,
        },
        req,
      )
      return preview.affectedCount
    },
    { user: session.user },
  )
}
