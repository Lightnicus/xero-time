import 'server-only'

import { hasActiveRole } from '@/access/roles'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AppSession } from '@/lib/member-app/session'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'

export class TimeEntryAdministrationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TimeEntryAdministrationError'
    this.code = code
  }
}

export async function deleteUnbilledTimeEntryAsAdministrator(
  session: AppSession,
  input: { entryID: string; reason: string },
): Promise<void> {
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    throw new TimeEntryAdministrationError(
      'forbidden',
      'Only an owner or administrator can perform a privileged deletion.',
    )
  }
  const reason = input.reason.trim()
  if (reason.length < 10 || reason.length > 1_000) {
    throw new TimeEntryAdministrationError(
      'invalid-reason',
      'Enter a deletion reason from 10 to 1,000 characters.',
    )
  }

  await withPayloadTransaction(
    session.payload,
    async (req) => {
      const entry = await session.payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: input.entryID,
        overrideAccess: true,
        req,
      })
      if (entry.billingStatus !== 'unbilled') {
        throw new TimeEntryAdministrationError(
          'entry-locked',
          'Reserved or exported time cannot be deleted.',
        )
      }

      await session.payload.delete({
        collection: 'time-entries',
        id: entry.id,
        overrideAccess: true,
        req,
      })
      await recordAuditEvent(
        session.payload,
        {
          actor: session.user.id,
          before: {
            billable: entry.billable,
            description: entry.description,
            durationSeconds: entry.durationSeconds,
            workDate: entry.workDate,
          },
          eventType: 'time-entry.privileged-correction',
          metadata: { action: 'delete' },
          reason,
          targetCollection: 'time-entries',
          targetId: entry.id,
        },
        req,
      )
    },
    { user: session.user },
  )
}
