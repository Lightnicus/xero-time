import { hasActiveRole, isActiveOwnerOrAdmin } from '@/access/roles'

import type { Access, CollectionConfig } from 'payload'

const denyAll = () => false
const readBilling: Access = ({ req }) => hasActiveRole(req.user, ['owner', 'admin', 'biller'])

export const InvoiceExportEntries: CollectionConfig = {
  slug: 'invoice-export-entries',
  access: {
    admin: ({ req }) => isActiveOwnerOrAdmin(req.user),
    create: denyAll,
    delete: denyAll,
    read: readBilling,
    update: denyAll,
  },
  admin: {
    defaultColumns: ['invoiceExport', 'workDate', 'projectCode', 'durationSeconds', 'amountScaled'],
    group: 'Billing',
    useAsTitle: 'description',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    {
      name: 'invoiceExport',
      type: 'relationship',
      relationTo: 'invoice-exports',
      maxDepth: 0,
      required: true,
      index: true,
    },
    {
      name: 'timeEntry',
      type: 'relationship',
      relationTo: 'time-entries',
      maxDepth: 0,
      required: true,
      index: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'customer',
          type: 'relationship',
          relationTo: 'customers',
          maxDepth: 0,
          required: true,
        },
        {
          name: 'project',
          type: 'relationship',
          relationTo: 'projects',
          maxDepth: 0,
          required: true,
        },
        { name: 'user', type: 'relationship', relationTo: 'users', maxDepth: 0, required: true },
      ],
    },
    { name: 'lineOrdinal', type: 'number', min: 0, required: true },
    { name: 'xeroLineItemId', type: 'text', maxLength: 100 },
    {
      type: 'row',
      fields: [
        { name: 'workDate', type: 'text', maxLength: 10, required: true },
        { name: 'timezone', type: 'text', maxLength: 100, required: true },
        { name: 'projectCode', type: 'text', maxLength: 40, required: true },
        { name: 'projectName', type: 'text', maxLength: 200, required: true },
        { name: 'userName', type: 'text', maxLength: 120, required: true },
      ],
    },
    { name: 'description', type: 'textarea', maxLength: 2_000, required: true },
    {
      type: 'row',
      fields: [
        { name: 'durationSeconds', type: 'number', min: 60, required: true },
        { name: 'quantityScaled', type: 'number', min: 1, required: true },
        { name: 'rateScaled', type: 'number', min: 0, required: true },
        { name: 'amountScaled', type: 'number', min: 0, required: true },
        { name: 'taxScaled', type: 'number', min: 0, required: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'currency', type: 'text', maxLength: 3, required: true },
        { name: 'accountCode', type: 'text', maxLength: 20, required: true },
        { name: 'taxType', type: 'text', maxLength: 50, required: true },
      ],
    },
    { name: 'tracking', type: 'json', required: true },
    { name: 'releasedAt', type: 'date' },
    { name: 'schemaVersion', type: 'number', defaultValue: 1, min: 1, required: true },
  ],
  indexes: [
    { fields: ['invoiceExport', 'timeEntry'], unique: true },
    { fields: ['timeEntry', 'releasedAt'] },
    { fields: ['invoiceExport', 'lineOrdinal'], unique: true },
  ],
  lockDocuments: false,
  timestamps: true,
}
