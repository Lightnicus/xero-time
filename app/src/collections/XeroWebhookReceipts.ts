import type { CollectionConfig } from 'payload'

const denyAll = () => false

/** Minimal durable webhook notification metadata. Xero remains authoritative. */
export const XeroWebhookReceipts: CollectionConfig = {
  slug: 'xero-webhook-receipts',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: { hidden: true, useAsTitle: 'deduplicationKey' },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'deduplicationKey',
      type: 'text',
      hidden: true,
      maxLength: 200,
      required: true,
      unique: true,
      index: true,
    },
    { name: 'tenantId', type: 'text', hidden: true, maxLength: 100, required: true, index: true },
    {
      type: 'row',
      fields: [
        { name: 'resourceType', type: 'text', maxLength: 100, required: true },
        { name: 'resourceId', type: 'text', maxLength: 100, required: true, index: true },
        { name: 'eventType', type: 'text', maxLength: 100, required: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'eventAt', type: 'date', required: true },
        { name: 'receivedAt', type: 'date', required: true },
        { name: 'processedAt', type: 'date' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Processing', value: 'processing' },
        { label: 'Processed', value: 'processed' },
        { label: 'Ignored', value: 'ignored' },
        { label: 'Failed', value: 'failed' },
      ],
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'jobId', type: 'text', maxLength: 100, index: true },
        { name: 'retryCount', type: 'number', defaultValue: 0, min: 0, required: true },
        { name: 'processingLeaseId', type: 'text', hidden: true, maxLength: 100 },
        { name: 'processingLeaseExpiresAt', type: 'date', hidden: true, index: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'failureCode', type: 'text', maxLength: 100 },
        { name: 'failureMessage', type: 'text', maxLength: 500 },
      ],
    },
  ],
  indexes: [
    { fields: ['status', 'receivedAt'] },
    { fields: ['tenantId', 'resourceType', 'resourceId', 'eventAt'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
