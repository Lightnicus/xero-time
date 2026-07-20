import { adminOnly } from '@/access/domain'

import type { CollectionConfig } from 'payload'

const denyAll = () => false

export const XeroReferenceData: CollectionConfig = {
  slug: 'xero-reference-data',
  access: {
    admin: adminOnly,
    create: denyAll,
    delete: denyAll,
    read: adminOnly,
    update: denyAll,
  },
  admin: {
    defaultColumns: ['resourceType', 'code', 'name', 'status', 'fetchedAt'],
    description: 'Read-only reference values fetched from the pinned Xero organisation.',
    group: 'Xero',
    useAsTitle: 'name',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    {
      name: 'resourceType',
      type: 'select',
      options: [
        { label: 'Account', value: 'account' },
        { label: 'Tax rate', value: 'tax-rate' },
        { label: 'Currency', value: 'currency' },
        { label: 'Organisation action', value: 'organisation-action' },
        { label: 'Organisation', value: 'organisation' },
        { label: 'Tracking category', value: 'tracking-category' },
        { label: 'Item', value: 'item' },
        { label: 'Contact', value: 'contact' },
      ],
      required: true,
      index: true,
    },
    { name: 'xeroId', type: 'text', maxLength: 200, index: true },
    { name: 'code', type: 'text', maxLength: 100, index: true },
    { name: 'name', type: 'text', maxLength: 255, required: true, index: true },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          defaultValue: 'active',
          options: [
            { label: 'Active', value: 'active' },
            { label: 'Archived', value: 'archived' },
            { label: 'Unavailable', value: 'unavailable' },
          ],
          required: true,
          index: true,
        },
        { name: 'type', type: 'text', maxLength: 100 },
      ],
    },
    { name: 'metadata', type: 'json' },
    {
      type: 'row',
      fields: [
        { name: 'sourceTenantId', type: 'text', maxLength: 100, required: true, index: true },
        { name: 'fetchedAt', type: 'date', required: true, index: true },
      ],
    },
  ],
  indexes: [
    { fields: ['sourceTenantId', 'resourceType', 'xeroId'], unique: true },
    { fields: ['sourceTenantId', 'resourceType', 'code'] },
    { fields: ['resourceType', 'status', 'name'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
