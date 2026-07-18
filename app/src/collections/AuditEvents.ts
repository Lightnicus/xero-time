import { hasActiveRole, isActiveOwnerOrAdmin } from '@/access/roles'

import type { Access, CollectionConfig } from 'payload'

const denyAll = () => false
const readAudit: Access = ({ req }) => hasActiveRole(req.user, ['owner', 'admin'])

export const AUDIT_EVENT_TYPES = [
  'authentication.login-succeeded',
  'authentication.login-failed',
  'authentication.logout',
  'authentication.session-revoked',
  'authentication.identity-linked',
  'authentication.identity-unlinked',
  'authentication.identity-recovered',
  'authentication.identity-collision',
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  'user.role-changed',
  'user.status-changed',
  'user.owner-transitioned',
  'settings.business-changed',
  'settings.authentication-changed',
  'settings.billing-changed',
  'xero.accounting-configuration-changed',
  'xero.accounting-connected',
  'xero.accounting-reconnected',
  'xero.accounting-handover',
  'xero.accounting-disconnected',
  'xero.reference-data-refreshed',
  'xero.webhook-ignored',
  'xero.webhook-processed',
  'customer.mapping-changed',
  'customer.changed',
  'project.changed',
  'time-entry.privileged-correction',
  'time-entry.rate-recalculated',
  'export.created',
  'export.state-changed',
  'export.retry-requested',
  'export.reconciled',
  'export.released',
  'export.rebilled',
  'security.kill-switch-changed',
  'security.diagnostic-override',
] as const

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/** Append-only, redacted business/security event stream. */
export const AuditEvents: CollectionConfig = {
  slug: 'audit-events',
  access: {
    admin: ({ req }) => isActiveOwnerOrAdmin(req.user),
    create: denyAll,
    delete: denyAll,
    read: readAudit,
    update: denyAll,
  },
  admin: {
    defaultColumns: ['occurredAt', 'eventType', 'actorType', 'actor', 'targetCollection'],
    group: 'Security',
    useAsTitle: 'eventType',
  },
  defaultSort: '-occurredAt',
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    {
      name: 'eventType',
      type: 'select',
      options: AUDIT_EVENT_TYPES.map((value) => ({ label: value, value })),
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'actorType',
          type: 'select',
          options: [
            { label: 'Human', value: 'human' },
            { label: 'Machine', value: 'machine' },
          ],
          required: true,
          index: true,
        },
        { name: 'actor', type: 'relationship', relationTo: 'users', maxDepth: 0, index: true },
        { name: 'machineActor', type: 'text', maxLength: 100 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'targetCollection', type: 'text', maxLength: 100, index: true },
        { name: 'targetId', type: 'text', maxLength: 100, index: true },
        { name: 'customerId', type: 'text', maxLength: 100, index: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'correlationId', type: 'text', maxLength: 100, index: true },
        { name: 'exportId', type: 'text', maxLength: 100, index: true },
        { name: 'xeroInvoiceId', type: 'text', maxLength: 100, index: true },
      ],
    },
    { name: 'occurredAt', type: 'date', required: true, index: true },
    { name: 'reason', type: 'textarea', maxLength: 1_000 },
    { name: 'before', type: 'json' },
    { name: 'after', type: 'json' },
    { name: 'metadata', type: 'json' },
    { name: 'schemaVersion', type: 'number', defaultValue: 1, min: 1, required: true },
  ],
  indexes: [
    { fields: ['occurredAt', 'eventType'] },
    { fields: ['actor', 'occurredAt'] },
    { fields: ['targetCollection', 'targetId', 'occurredAt'] },
    { fields: ['customerId', 'occurredAt'] },
    { fields: ['exportId', 'occurredAt'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
