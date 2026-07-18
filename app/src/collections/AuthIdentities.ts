import type { CollectionConfig } from 'payload'

const denyAll = () => false

/** Identity metadata only. Provider access/ID/refresh tokens are never persisted. */
export const AuthIdentities: CollectionConfig = {
  slug: 'auth-identities',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: {
    hidden: true,
    useAsTitle: 'provider',
  },
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
      type: 'row',
      fields: [
        {
          name: 'provider',
          type: 'select',
          defaultValue: 'xero',
          options: [{ label: 'Xero', value: 'xero' }],
          required: true,
        },
        {
          name: 'status',
          type: 'select',
          defaultValue: 'active',
          options: [
            { label: 'Active', value: 'active' },
            { label: 'Revoked', value: 'revoked' },
            { label: 'Collision review', value: 'collision-review' },
          ],
          required: true,
          index: true,
        },
      ],
    },
    { name: 'issuer', type: 'text', hidden: true, maxLength: 500, required: true },
    { name: 'subject', type: 'text', hidden: true, maxLength: 500, required: true },
    {
      type: 'row',
      fields: [
        { name: 'emailSnapshot', type: 'email' },
        { name: 'displayNameSnapshot', type: 'text', maxLength: 200 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'linkedAt', type: 'date', required: true },
        { name: 'lastUsedAt', type: 'date' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'linkedBy', type: 'relationship', relationTo: 'users', maxDepth: 0 },
        { name: 'unlinkedBy', type: 'relationship', relationTo: 'users', maxDepth: 0 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'unlinkedAt', type: 'date' },
        { name: 'unlinkReason', type: 'text', maxLength: 1_000 },
      ],
    },
  ],
  indexes: [
    { fields: ['provider', 'issuer', 'subject'], unique: true },
    { fields: ['user', 'provider'], unique: true },
    { fields: ['status', 'lastUsedAt'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
