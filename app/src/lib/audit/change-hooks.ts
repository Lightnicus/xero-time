import type { AuditEventType } from '@/collections/AuditEvents'
import { isRecord, relationshipID } from '@/lib/domain/validation'

import { recordAuditEvent } from './service'

import type { CollectionAfterChangeHook, GlobalAfterChangeHook, PayloadRequest } from 'payload'

type Snapshot = Record<string, unknown>

const actorID = (req: PayloadRequest): string | undefined => {
  const id = isRecord(req.user) ? req.user.id : undefined
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

const comparableValue = (value: unknown): unknown => {
  const relationship = relationshipID(value)
  if (relationship !== null && isRecord(value)) return String(relationship)
  return value
}

export const selectedSnapshot = (document: unknown, fields: readonly string[]): Snapshot => {
  if (!isRecord(document)) return {}
  const result: Snapshot = {}
  for (const field of fields) {
    if (Object.hasOwn(document, field)) result[field] = comparableValue(document[field])
  }
  return result
}

const changedSnapshot = (
  previous: unknown,
  current: unknown,
  fields: readonly string[],
): { after: Snapshot; before: Snapshot } | null => {
  const before = selectedSnapshot(previous, fields)
  const after = selectedSnapshot(current, fields)
  const changed = fields.some(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  )
  return changed ? { after, before } : null
}

export const auditGlobalChange =
  (eventType: AuditEventType, fields: readonly string[]): GlobalAfterChangeHook =>
  async ({ doc, global, previousDoc, req }) => {
    const change = changedSnapshot(previousDoc, doc, fields)
    if (!change) return doc
    const contextReason = req.context?.auditReason
    await recordAuditEvent(
      req.payload,
      {
        actor: actorID(req),
        ...change,
        eventType,
        machineActor: actorID(req) ? undefined : 'configuration',
        reason: typeof contextReason === 'string' ? contextReason : undefined,
        targetCollection: 'globals',
        targetId: global.slug,
      },
      req,
    )
    return doc
  }

export const auditCollectionChange =
  (eventType: AuditEventType, fields: readonly string[]): CollectionAfterChangeHook =>
  async ({ collection, doc, operation, previousDoc, req }) => {
    const change =
      operation === 'create'
        ? { after: selectedSnapshot(doc, fields), before: {} }
        : changedSnapshot(previousDoc, doc, fields)
    if (!change) return doc
    const contextReason = req.context?.auditReason
    await recordAuditEvent(
      req.payload,
      {
        actor: actorID(req),
        ...change,
        eventType,
        machineActor: actorID(req) ? undefined : 'application',
        reason: typeof contextReason === 'string' ? contextReason : undefined,
        targetCollection: collection.slug,
        targetId: doc.id,
      },
      req,
    )
    return doc
  }
