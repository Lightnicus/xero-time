import { hasActiveRole, isActiveOwnerOrAdmin } from '@/access/roles'

import type { Access, CollectionConfig, Validate } from 'payload'

const denyAll = () => false
const readBilling: Access = ({ req }) => hasActiveRole(req.user, ['owner', 'admin', 'biller'])
const validatePositiveInteger: Validate<number> = (value) =>
  value === null || typeof value === 'undefined' || (Number.isInteger(value) && value >= 1)
    ? true
    : 'Reference sequence must be a positive integer.'

export const INVOICE_EXPORT_STATES = [
  'preparing',
  'queued',
  'processing',
  'retry-wait',
  'action-required',
  'reconciling',
  'succeeded',
  'cancelled',
  'released',
  'manual-review',
] as const

export const InvoiceExports: CollectionConfig = {
  slug: 'invoice-exports',
  access: {
    admin: ({ req }) => isActiveOwnerOrAdmin(req.user),
    create: denyAll,
    delete: denyAll,
    read: readBilling,
    update: denyAll,
  },
  admin: {
    defaultColumns: [
      'applicationReference',
      'state',
      'customer',
      'currency',
      'xeroInvoiceNumber',
      'updatedAt',
    ],
    group: 'Billing',
    useAsTitle: 'applicationReference',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    {
      name: 'batch',
      type: 'relationship',
      relationTo: 'export-batches',
      maxDepth: 0,
      required: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      maxDepth: 0,
      required: true,
    },
    { name: 'requestedBy', type: 'relationship', relationTo: 'users', maxDepth: 0, required: true },
    {
      name: 'applicationReference',
      type: 'text',
      maxLength: 100,
      required: true,
      unique: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'customerReferenceCode',
          type: 'text',
          maxLength: 30,
          admin: {
            description: 'Immutable customer-code snapshot used in the Xero reference.',
            readOnly: true,
          },
        },
        {
          name: 'customerReferenceSequence',
          type: 'number',
          min: 1,
          validate: validatePositiveInteger,
          admin: {
            description: 'Immutable per-customer sequence used in the Xero reference.',
            readOnly: true,
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'state',
          type: 'select',
          options: INVOICE_EXPORT_STATES.map((value) => ({ label: value, value })),
          required: true,
          index: true,
        },
        {
          name: 'dispatchState',
          type: 'select',
          defaultValue: 'pending',
          options: [
            { label: 'Pending', value: 'pending' },
            { label: 'Attached', value: 'attached' },
            { label: 'Dispatched', value: 'dispatched' },
            { label: 'Complete', value: 'complete' },
          ],
          required: true,
          index: true,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'requestedMode',
          type: 'select',
          options: ['background', 'wait-for-result'],
          required: true,
        },
        {
          name: 'actualMode',
          type: 'select',
          options: ['background', 'wait-for-result'],
          required: true,
        },
        { name: 'modeOverrideReason', type: 'text', maxLength: 500 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'payloadHash', type: 'text', maxLength: 100, required: true },
        { name: 'selectionHash', type: 'text', maxLength: 100, required: true },
        { name: 'schemaVersion', type: 'number', defaultValue: 1, min: 1, required: true },
      ],
    },
    { name: 'requestPayload', type: 'json', hidden: true, required: true },
    {
      type: 'row',
      fields: [
        { name: 'invoiceDate', type: 'date', required: true },
        { name: 'dueDate', type: 'date', required: true },
        { name: 'currency', type: 'text', maxLength: 3, required: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'entryCount', type: 'number', min: 1, required: true },
        { name: 'durationSeconds', type: 'number', min: 60, required: true },
        {
          name: 'subtotalScaled',
          label: 'Subtotal',
          type: 'number',
          min: 0,
          required: true,
          admin: {
            disableGroupBy: true,
            disableListFilter: true,
            readOnly: true,
            components: {
              Cell: '/components/admin/ScaledCurrencyCell',
              Field: '/components/admin/ScaledCurrencyField',
            },
          },
        },
        {
          name: 'taxScaled',
          label: 'Tax',
          type: 'number',
          min: 0,
          required: true,
          admin: {
            disableGroupBy: true,
            disableListFilter: true,
            readOnly: true,
            components: {
              Cell: '/components/admin/ScaledCurrencyCell',
              Field: '/components/admin/ScaledCurrencyField',
            },
          },
        },
        {
          name: 'totalScaled',
          label: 'Total',
          type: 'number',
          min: 0,
          required: true,
          admin: {
            disableGroupBy: true,
            disableListFilter: true,
            readOnly: true,
            components: {
              Cell: '/components/admin/ScaledCurrencyCell',
              Field: '/components/admin/ScaledCurrencyField',
            },
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'jobId', type: 'text', maxLength: 100, index: true },
        { name: 'currentAttempt', type: 'relationship', relationTo: 'xero-attempts', maxDepth: 0 },
        { name: 'currentAttemptNumber', type: 'number', min: 0, defaultValue: 0 },
        { name: 'nextAttemptAt', type: 'date', index: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'processingLeaseId', type: 'text', hidden: true, maxLength: 100 },
        { name: 'processingLeaseExpiresAt', type: 'date', hidden: true, index: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'xeroInvoiceId', type: 'text', maxLength: 100, index: true },
        { name: 'xeroInvoiceNumber', type: 'text', maxLength: 100 },
        { name: 'xeroInvoiceUrl', type: 'text', maxLength: 1_000 },
        { name: 'remoteStatus', type: 'text', maxLength: 50, index: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'lastRemoteUpdateAt', type: 'date' },
        { name: 'lastReconciledAt', type: 'date' },
        { name: 'lastAttemptAt', type: 'date' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'lastErrorCode', type: 'text', maxLength: 100 },
        { name: 'lastErrorMessage', type: 'text', maxLength: 500 },
      ],
    },
    { name: 'stateHistory', type: 'json', required: true },
    { name: 'releaseAction', type: 'relationship', relationTo: 'release-actions', maxDepth: 0 },
    { name: 'rebillOf', type: 'relationship', relationTo: 'invoice-exports', maxDepth: 0 },
    {
      type: 'row',
      fields: [
        { name: 'queuedAt', type: 'date' },
        { name: 'processingAt', type: 'date' },
        { name: 'succeededAt', type: 'date' },
        { name: 'cancelledAt', type: 'date' },
        { name: 'releasedAt', type: 'date' },
      ],
    },
  ],
  indexes: [
    { fields: ['state', 'createdAt'] },
    { fields: ['dispatchState', 'jobId', 'createdAt'] },
    { fields: ['state', 'nextAttemptAt'] },
    { fields: ['customer', 'createdAt'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
