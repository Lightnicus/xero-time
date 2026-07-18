import 'server-only'

import { isActiveOwner } from '@/access/roles'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import type { User } from '@/payload-types'

import { OWNER_TRANSITION_CONTEXT } from './context'

import type { PayloadRequest } from 'payload'

export class OwnerTransitionError extends Error {
  code: string

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'OwnerTransitionError'
    this.code = code
  }
}

const confirmOwnerPassword = async (session: AppSession, password: string): Promise<void> => {
  if (password.length === 0 || password.length > 1_024) {
    throw new OwnerTransitionError('reauthentication-failed', 'Password confirmation failed.')
  }
  try {
    const result = await session.payload.login({
      collection: 'users',
      data: { email: session.user.email, password },
    })
    if (!result.user || String(result.user.id) !== String(session.user.id)) {
      throw new Error('Password confirmation returned another user.')
    }
  } catch (error) {
    throw new OwnerTransitionError('reauthentication-failed', 'Password confirmation failed.', {
      cause: error,
    })
  }
}

const hasPasswordCredential = async (req: PayloadRequest, userID: string): Promise<boolean> => {
  const transactionID = await req.transactionID
  const mongoSession = transactionID ? req.payload.db.sessions[transactionID] : undefined
  const query = requireMongoModel(req.payload, 'users').findOne({
    _id: userID,
    active: true,
    hash: { $type: 'string' },
    salt: { $type: 'string' },
  })
  if (mongoSession) query.session(mongoSession)
  return Boolean(await query)
}

export async function transitionOwner(
  session: AppSession,
  input: {
    action: 'demote' | 'promote'
    password: string
    reason: string
    targetUserID: string
  },
): Promise<void> {
  if (!isActiveOwner(session.user)) {
    throw new OwnerTransitionError('forbidden', 'Only an owner can transition ownership.')
  }
  const reason = input.reason.trim()
  if (reason.length < 10 || reason.length > 1_000) {
    throw new OwnerTransitionError(
      'invalid-reason',
      'Enter an ownership-transition reason of at least 10 characters.',
    )
  }
  if (!/^[a-f0-9]{24}$/i.test(input.targetUserID)) {
    throw new OwnerTransitionError('invalid-user', 'Select a valid user.')
  }
  await confirmOwnerPassword(session, input.password)

  try {
    await withPayloadTransaction(
      session.payload,
      async (req) => {
        const transactionID = await req.transactionID
        const mongoSession = transactionID ? session.payload.db.sessions[transactionID] : undefined
        const database = session.payload.db.connection.db
        if (!database)
          throw new OwnerTransitionError('database-unavailable', 'MongoDB is unavailable.')

        await database
          .collection('application_owner_transition_locks')
          .updateOne(
            { _id: 'business-owner' as never },
            { $inc: { version: 1 }, $set: { updatedAt: new Date() } },
            { session: mongoSession, upsert: true },
          )

        let target: User
        try {
          target = await session.payload.findByID({
            collection: 'users',
            depth: 0,
            id: input.targetUserID,
            overrideAccess: true,
            req,
          })
        } catch {
          throw new OwnerTransitionError('invalid-user', 'Select a valid user.')
        }
        if (!target.active || !(await hasPasswordCredential(req, String(target.id)))) {
          throw new OwnerTransitionError(
            'no-password-recovery',
            'The target must be active and have a tested email/password credential.',
          )
        }

        if (input.action === 'promote') {
          if (target.role === 'owner') {
            throw new OwnerTransitionError('already-owner', 'That user is already an owner.')
          }
          await session.payload.update({
            collection: 'users',
            id: target.id,
            data: { role: 'owner' },
            overrideAccess: true,
            req,
          })
          await recordAuditEvent(
            session.payload,
            {
              actor: session.user.id,
              after: { role: 'owner' },
              before: { role: target.role },
              eventType: 'user.owner-transitioned',
              reason,
              targetCollection: 'users',
              targetId: target.id,
            },
            req,
          )
          return
        }

        if (target.role !== 'owner') {
          throw new OwnerTransitionError(
            'not-owner',
            'Only an owner can be demoted by this command.',
          )
        }
        if (String(target.id) === String(session.user.id)) {
          throw new OwnerTransitionError(
            'self-demotion-denied',
            'A different active owner must perform your demotion.',
          )
        }

        const owners = await session.payload.find({
          collection: 'users',
          depth: 0,
          limit: 100,
          overrideAccess: true,
          req,
          where: { and: [{ active: { equals: true } }, { role: { equals: 'owner' } }] },
        })
        let recoveryOwnerRemains = false
        // MongoDB does not support parallel operations on a transaction session.
        for (const owner of owners.docs) {
          if (String(owner.id) === String(target.id)) continue
          if (await hasPasswordCredential(req, String(owner.id))) {
            recoveryOwnerRemains = true
            break
          }
        }
        if (!recoveryOwnerRemains) {
          throw new OwnerTransitionError(
            'final-owner',
            'Another active password-capable owner must remain.',
          )
        }

        await session.payload.update({
          collection: 'users',
          id: target.id,
          data: { role: 'admin' },
          overrideAccess: true,
          req,
        })
        await recordAuditEvent(
          session.payload,
          {
            actor: session.user.id,
            after: { role: 'admin' },
            before: { role: 'owner' },
            eventType: 'user.owner-transitioned',
            reason,
            targetCollection: 'users',
            targetId: target.id,
          },
          req,
        )
      },
      { context: { [OWNER_TRANSITION_CONTEXT]: true } },
    )
  } catch (error) {
    if (error instanceof OwnerTransitionError) throw error
    throw new OwnerTransitionError('transition-failed', 'Ownership could not be changed.', {
      cause: error,
    })
  }
}
