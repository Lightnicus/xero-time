import type { CollectionConfig } from 'payload'

const denyAll = () => false

export const XeroContactOperations: CollectionConfig = {
  slug: 'xero-contact-operations',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: { hidden: true, useAsTitle: 'applicationReference' },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'applicationReference',
      type: 'text',
      maxLength: 100,
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'idempotencyKey',
      type: 'text',
      maxLength: 128,
      required: true,
      unique: true,
      index: true,
    },
    { name: 'customer', type: 'relationship', relationTo: 'customers', maxDepth: 0, index: true },
    { name: 'requestedBy', type: 'relationship', relationTo: 'users', maxDepth: 0, required: true },
    {
      name: 'state',
      type: 'select',
      options: [
        { label: 'Preparing', value: 'preparing' },
        { label: 'Processing', value: 'processing' },
        { label: 'Succeeded', value: 'succeeded' },
        { label: 'Ambiguous', value: 'ambiguous' },
        { label: 'Failed', value: 'failed' },
      ],
      required: true,
      index: true,
    },
    { name: 'payloadHash', type: 'text', maxLength: 100, required: true },
    { name: 'requestPayload', type: 'json', hidden: true, required: true },
    { name: 'xeroContactId', type: 'text', maxLength: 100, index: true },
    { name: 'attemptCount', type: 'number', min: 0, defaultValue: 0, required: true },
    {
      type: 'row',
      fields: [
        { name: 'lastErrorCode', type: 'text', maxLength: 100 },
        { name: 'lastErrorMessage', type: 'text', maxLength: 500 },
      ],
    },
    { name: 'completedAt', type: 'date' },
  ],
  indexes: [{ fields: ['state', 'createdAt'] }, { fields: ['customer', 'createdAt'] }],
  lockDocuments: false,
  timestamps: true,
}
