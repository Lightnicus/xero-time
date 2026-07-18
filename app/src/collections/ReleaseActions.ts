import { hasActiveRole, isActiveOwnerOrAdmin } from '@/access/roles'

import type { Access, CollectionConfig } from 'payload'

const denyAll = () => false
const readBilling: Access = ({ req }) => hasActiveRole(req.user, ['owner', 'admin', 'biller'])

/** Immutable lineage for a complete-export release. */
export const ReleaseActions: CollectionConfig = {
  slug: 'release-actions',
  access: {
    admin: ({ req }) => isActiveOwnerOrAdmin(req.user),
    create: denyAll,
    delete: denyAll,
    read: readBilling,
    update: denyAll,
  },
  admin: {
    defaultColumns: ['sourceExport', 'remoteStatus', 'actor', 'releasedAt'],
    group: 'Billing',
    useAsTitle: 'id',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    {
      name: 'sourceExport',
      type: 'relationship',
      relationTo: 'invoice-exports',
      maxDepth: 0,
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'actor',
      type: 'relationship',
      relationTo: 'users',
      maxDepth: 0,
      required: true,
      index: true,
    },
    { name: 'reason', type: 'textarea', minLength: 3, maxLength: 1_000, required: true },
    { name: 'remoteStatus', type: 'select', options: ['DELETED', 'VOIDED'], required: true },
    { name: 'remoteVerifiedAt', type: 'date', required: true },
    { name: 'releasedAt', type: 'date', required: true, index: true },
    { name: 'entryIds', type: 'json', required: true },
    {
      type: 'row',
      fields: [
        { name: 'entryCount', type: 'number', min: 1, required: true },
        { name: 'durationSeconds', type: 'number', min: 60, required: true },
        { name: 'amountScaled', type: 'number', min: 0, required: true },
      ],
    },
    { name: 'before', type: 'json', required: true },
    { name: 'after', type: 'json', required: true },
    {
      name: 'replacementExports',
      type: 'relationship',
      relationTo: 'invoice-exports',
      hasMany: true,
      maxDepth: 0,
    },
    { name: 'schemaVersion', type: 'number', defaultValue: 1, min: 1, required: true },
  ],
  indexes: [{ fields: ['actor', 'releasedAt'] }],
  lockDocuments: false,
  timestamps: true,
}
