import { hasActiveRole, isActiveOwnerOrAdmin } from '@/access/roles'

import type { Access, CollectionConfig } from 'payload'

const denyAll = () => false
const readBilling: Access = ({ req }) => hasActiveRole(req.user, ['owner', 'admin', 'biller'])

export const ExportBatches: CollectionConfig = {
  slug: 'export-batches',
  access: {
    admin: ({ req }) => isActiveOwnerOrAdmin(req.user),
    create: denyAll,
    delete: denyAll,
    read: readBilling,
    update: denyAll,
  },
  admin: {
    defaultColumns: ['applicationReference', 'status', 'actualMode', 'entryCount', 'createdAt'],
    group: 'Billing',
    useAsTitle: 'applicationReference',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    { name: 'applicationReference', type: 'text', maxLength: 100, required: true, unique: true },
    { name: 'requestedBy', type: 'relationship', relationTo: 'users', maxDepth: 0, required: true },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          defaultValue: 'preparing',
          options: [
            { label: 'Preparing', value: 'preparing' },
            { label: 'Queued', value: 'queued' },
            { label: 'Processing', value: 'processing' },
            { label: 'Partially complete', value: 'partial' },
            { label: 'Succeeded', value: 'succeeded' },
            { label: 'Action required', value: 'action-required' },
            { label: 'Cancelled', value: 'cancelled' },
          ],
          required: true,
          index: true,
        },
        {
          name: 'selectionType',
          type: 'select',
          options: [
            { label: 'Explicit entries', value: 'explicit' },
            { label: 'All matching', value: 'all-matching' },
          ],
          required: true,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'requestedMode',
          type: 'select',
          options: [
            { label: 'Background', value: 'background' },
            { label: 'Wait for Xero', value: 'wait-for-result' },
          ],
          required: true,
        },
        {
          name: 'actualMode',
          type: 'select',
          options: [
            { label: 'Background', value: 'background' },
            { label: 'Wait for Xero', value: 'wait-for-result' },
          ],
          required: true,
        },
      ],
    },
    { name: 'normalizedFilterSnapshot', type: 'json', required: true },
    { name: 'explicitEntryIds', type: 'json' },
    { name: 'snapshotHash', type: 'text', maxLength: 100, required: true },
    {
      type: 'row',
      fields: [
        { name: 'entryCount', type: 'number', min: 0, required: true },
        { name: 'invoiceCount', type: 'number', min: 0, required: true },
        { name: 'durationSeconds', type: 'number', min: 0, required: true },
        {
          name: 'totalAmountScaled',
          type: 'number',
          min: 0,
          required: true,
          admin: {
            description:
              'Internal aggregate only; a batch can contain more than one currency, so no user-facing total is shown.',
            hidden: true,
          },
        },
      ],
    },
    { name: 'schemaVersion', type: 'number', defaultValue: 1, min: 1, required: true },
    { name: 'completedAt', type: 'date' },
  ],
  indexes: [{ fields: ['requestedBy', 'createdAt'] }, { fields: ['status', 'createdAt'] }],
  lockDocuments: false,
  timestamps: true,
}
