import { validateIanaTimezone } from '@/lib/domain/validation'

import type { CollectionConfig } from 'payload'

const denyAll = () => false

export const Invitations: CollectionConfig = {
  slug: 'invitations',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: {
    hidden: true,
    useAsTitle: 'email',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'email',
      type: 'email',
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'displayName',
      type: 'text',
      maxLength: 120,
      required: true,
    },
    {
      name: 'role',
      type: 'select',
      options: [
        { label: 'Administrator', value: 'admin' },
        { label: 'Biller', value: 'biller' },
        { label: 'Time-entry user', value: 'member' },
      ],
      required: true,
    },
    {
      name: 'timezone',
      type: 'text',
      defaultValue: 'Pacific/Auckland',
      required: true,
      validate: validateIanaTimezone,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      index: true,
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Accepting', value: 'accepting' },
        { label: 'Accepted', value: 'accepted' },
        { label: 'Revoked', value: 'revoked' },
      ],
      required: true,
    },
    {
      name: 'tokenHash',
      type: 'text',
      hidden: true,
      index: true,
      required: true,
      unique: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'issuedAt', type: 'date', required: true },
        { name: 'expiresAt', type: 'date', index: true, required: true },
        { name: 'cleanupAt', type: 'date', hidden: true },
      ],
    },
    {
      name: 'invitedBy',
      type: 'relationship',
      relationTo: 'users',
      required: true,
    },
    {
      name: 'acceptedBy',
      type: 'relationship',
      relationTo: 'users',
    },
    {
      name: 'acceptanceProvider',
      type: 'select',
      options: [
        { label: 'Email and password', value: 'email-password' },
        { label: 'Xero identity', value: 'xero' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'acceptedAt', type: 'date' },
        { name: 'revokedAt', type: 'date' },
        {
          name: 'revokedBy',
          type: 'relationship',
          relationTo: 'users',
        },
      ],
    },
    {
      name: 'revocationReason',
      type: 'textarea',
      maxLength: 1_000,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'deliveryStatus',
          type: 'select',
          defaultValue: 'pending',
          options: [
            { label: 'Pending', value: 'pending' },
            { label: 'Sent', value: 'sent' },
            { label: 'Failed', value: 'failed' },
          ],
          required: true,
        },
        { name: 'deliveryAttempts', type: 'number', defaultValue: 0, min: 0, required: true },
        { name: 'lastDeliveredAt', type: 'date' },
      ],
    },
    {
      name: 'lastDeliveryError',
      type: 'text',
      hidden: true,
      maxLength: 200,
    },
  ],
  lockDocuments: false,
  timestamps: true,
}
