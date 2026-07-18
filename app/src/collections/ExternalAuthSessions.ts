import type { CollectionConfig } from 'payload'

const denyAll = () => false

/** Hashed application sessions created after a verified external identity callback. */
export const ExternalAuthSessions: CollectionConfig = {
  slug: 'external-auth-sessions',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: { hidden: true, useAsTitle: 'deviceLabel' },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      maxDepth: 0,
      required: true,
      index: true,
    },
    {
      name: 'identity',
      type: 'relationship',
      relationTo: 'auth-identities',
      maxDepth: 0,
      required: true,
      index: true,
    },
    { name: 'tokenHash', type: 'text', hidden: true, index: true, required: true, unique: true },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          defaultValue: 'active',
          options: [
            { label: 'Active', value: 'active' },
            { label: 'Revoked', value: 'revoked' },
            { label: 'Expired', value: 'expired' },
          ],
          required: true,
          index: true,
        },
        { name: 'version', type: 'number', defaultValue: 1, min: 1, required: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'issuedAt', type: 'date', required: true },
        { name: 'lastSeenAt', type: 'date', required: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'idleExpiresAt', type: 'date', required: true, index: true },
        { name: 'absoluteExpiresAt', type: 'date', required: true, index: true },
        { name: 'cleanupAt', type: 'date', hidden: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'deviceLabel', type: 'text', maxLength: 160 },
        { name: 'userAgentHash', type: 'text', hidden: true, maxLength: 100 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'revokedAt', type: 'date' },
        { name: 'revocationReason', type: 'text', maxLength: 1_000 },
      ],
    },
  ],
  indexes: [
    { fields: ['user', 'status', 'absoluteExpiresAt'] },
    { fields: ['identity', 'status'] },
    { fields: ['status', 'idleExpiresAt'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
