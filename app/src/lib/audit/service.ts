import { createHash } from 'node:crypto'

import type { AuditEventType } from '@/collections/AuditEvents'

import type { Payload, PayloadRequest } from 'payload'

export const AUDIT_WRITE_CONTEXT = 'writingAuditEvent'

const secretKeyPattern =
  /(password|secret|token|cookie|authorization|nonce|verifier|pkce|subject|envelope|payload|description)/i
const emailKeyPattern = /email/i

const maskEmail = (value: string): string => {
  const [local, domain] = value.split('@')
  return domain ? `${local?.slice(0, 1) ?? '*'}***@${domain}` : '[redacted]'
}

export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length <= 1_000 ? value : `${value.slice(0, 997)}...`
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value)

  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (secretKeyPattern.test(key)) {
      redacted[key] = '[redacted]'
    } else if (emailKeyPattern.test(key) && typeof item === 'string') {
      redacted[key] = maskEmail(item)
    } else {
      redacted[key] = redactAuditValue(item, depth + 1)
    }
  }
  return redacted
}

export type AuditEventInput = {
  actor?: number | string
  after?: unknown
  before?: unknown
  correlationId?: string
  customerId?: number | string
  eventType: AuditEventType
  exportId?: number | string
  machineActor?: string
  metadata?: unknown
  reason?: string
  targetCollection?: string
  targetId?: number | string
  xeroInvoiceId?: string
}

export async function recordAuditEvent(
  payload: Payload,
  input: AuditEventInput,
  req?: PayloadRequest,
): Promise<void> {
  if (req?.context?.[AUDIT_WRITE_CONTEXT] === true) return
  const actorType =
    typeof input.actor === 'string' || typeof input.actor === 'number' ? 'human' : 'machine'
  const machineActor =
    actorType === 'machine' ? input.machineActor?.slice(0, 100) || 'application' : undefined
  const previousContext = req?.context
  if (req) req.context = { ...(req.context ?? {}), [AUDIT_WRITE_CONTEXT]: true }
  try {
    await payload.create({
      collection: 'audit-events',
      ...(req ? {} : { context: { [AUDIT_WRITE_CONTEXT]: true } }),
      data: {
        actor: actorType === 'human' ? String(input.actor) : undefined,
        actorType,
        ...(input.after === undefined ? {} : { after: redactAuditValue(input.after) as never }),
        ...(input.before === undefined ? {} : { before: redactAuditValue(input.before) as never }),
        correlationId: input.correlationId?.slice(0, 100),
        customerId: input.customerId === undefined ? undefined : String(input.customerId),
        eventType: input.eventType,
        exportId: input.exportId === undefined ? undefined : String(input.exportId),
        machineActor,
        ...(input.metadata === undefined
          ? {}
          : { metadata: redactAuditValue(input.metadata) as never }),
        occurredAt: new Date().toISOString(),
        reason: input.reason?.trim().slice(0, 1_000),
        schemaVersion: 1,
        targetCollection: input.targetCollection?.slice(0, 100),
        targetId: input.targetId === undefined ? undefined : String(input.targetId),
        xeroInvoiceId: input.xeroInvoiceId?.slice(0, 100),
      },
      // Audit writes often participate in a wider MongoDB transaction. Returning
      // relationship-populated documents can make Payload issue parallel reads on
      // that one transaction session, which the MongoDB driver does not support.
      depth: 0,
      overrideAccess: true,
      req,
    })
  } finally {
    if (req) req.context = previousContext ?? {}
  }
}

export const correlationID = (): string =>
  createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`, 'utf8')
    .digest('base64url')
    .slice(0, 24)
