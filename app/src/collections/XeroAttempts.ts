import type { CollectionConfig } from 'payload'

const denyAll = () => false

export const XERO_ATTEMPT_RESULTS = [
  'pending',
  'succeeded',
  'definitely-not-created',
  'retryable-before-send',
  'ambiguous',
  'manual-review',
] as const

/** Immutable accounting-mutation journal. Access is only through billing services. */
export const XeroAttempts: CollectionConfig = {
  slug: 'xero-attempts',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: { hidden: true, useAsTitle: 'idempotencyKey' },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'invoiceExport',
      type: 'relationship',
      relationTo: 'invoice-exports',
      maxDepth: 0,
      required: true,
      index: true,
    },
    { name: 'attemptNumber', type: 'number', min: 1, required: true },
    {
      type: 'row',
      fields: [
        {
          name: 'operation',
          type: 'select',
          options: [
            { label: 'Create invoice', value: 'create-invoice' },
            { label: 'Fetch invoice', value: 'fetch-invoice' },
          ],
          required: true,
        },
        {
          name: 'method',
          type: 'select',
          options: [
            { label: 'GET', value: 'GET' },
            { label: 'POST', value: 'POST' },
          ],
          required: true,
        },
      ],
    },
    { name: 'safeResponseMetadata', type: 'json' },
    { name: 'payloadHash', type: 'text', maxLength: 100, required: true },
    {
      name: 'idempotencyKey',
      type: 'text',
      maxLength: 128,
      required: true,
      unique: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'claimId', type: 'text', hidden: true, maxLength: 100 },
        { name: 'leaseExpiresAt', type: 'date', hidden: true, index: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'requestStartedAt', type: 'date' },
        { name: 'requestMayHaveBeenSent', type: 'checkbox', defaultValue: false, required: true },
        { name: 'completedAt', type: 'date' },
      ],
    },
    {
      name: 'result',
      type: 'select',
      defaultValue: 'pending',
      options: XERO_ATTEMPT_RESULTS.map((value) => ({ label: value, value })),
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'httpStatus', type: 'number', min: 100, max: 599 },
        { name: 'xeroCorrelationId', type: 'text', maxLength: 200 },
        { name: 'rateLimitRemaining', type: 'number', min: 0 },
        { name: 'retryAfterSeconds', type: 'number', min: 0 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'errorCode', type: 'text', maxLength: 100 },
        { name: 'errorMessage', type: 'text', maxLength: 500 },
      ],
    },
    {
      name: 'replacesAttempt',
      type: 'relationship',
      relationTo: 'xero-attempts',
      maxDepth: 0,
    },
  ],
  indexes: [
    { fields: ['invoiceExport', 'attemptNumber'], unique: true },
    { fields: ['result', 'leaseExpiresAt'] },
    { fields: ['invoiceExport', 'createdAt'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
