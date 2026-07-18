import type { CollectionConfig } from 'payload'

const denyAll = () => false

export const XeroConnections: CollectionConfig = {
  slug: 'xero-connections',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: {
    hidden: true,
    useAsTitle: 'tenantName',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'singletonKey',
      type: 'text',
      defaultValue: 'business-accounting',
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'oauthClientId',
      type: 'text',
      hidden: true,
      maxLength: 200,
    },
    {
      name: 'oauthClientSecretEnvelope',
      type: 'textarea',
      hidden: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'oauthConfigurationVersion',
          type: 'number',
          defaultValue: 0,
          hidden: true,
          min: 0,
        },
        { name: 'oauthConfiguredAt', type: 'date', hidden: true },
        {
          name: 'oauthConfiguredBy',
          type: 'relationship',
          hidden: true,
          relationTo: 'users',
        },
      ],
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'disconnected',
      index: true,
      options: [
        { label: 'Connected', value: 'connected' },
        { label: 'Action required', value: 'action-required' },
        { label: 'Disconnected', value: 'disconnected' },
      ],
      required: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'tenantId', type: 'text', index: true, maxLength: 100 },
        { name: 'connectionId', type: 'text', maxLength: 100 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'tenantName', type: 'text', maxLength: 255 },
        { name: 'tenantType', type: 'text', maxLength: 50 },
      ],
    },
    {
      name: 'grantedScopes',
      type: 'select',
      hasMany: true,
      options: [
        { label: 'Offline access', value: 'offline_access' },
        { label: 'Invoices', value: 'accounting.invoices' },
        { label: 'Contacts', value: 'accounting.contacts' },
        { label: 'Settings read', value: 'accounting.settings.read' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'authenticationEventId', type: 'text', maxLength: 100 },
        { name: 'authorizingXeroUserId', type: 'text', maxLength: 100 },
      ],
    },
    {
      name: 'initiatedBy',
      type: 'relationship',
      relationTo: 'users',
    },
    {
      type: 'row',
      fields: [
        { name: 'authorizedAt', type: 'date' },
        { name: 'accessTokenExpiresAt', type: 'date' },
      ],
    },
    {
      name: 'accessTokenEnvelope',
      type: 'textarea',
      hidden: true,
    },
    {
      name: 'refreshTokenEnvelope',
      type: 'textarea',
      hidden: true,
    },
    {
      name: 'tokenVersion',
      type: 'number',
      defaultValue: 0,
      min: 0,
      required: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'refreshLockId', type: 'text', hidden: true },
        { name: 'refreshLockExpiresAt', type: 'date', hidden: true },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'lastRefreshedAt', type: 'date' },
        { name: 'lastSuccessfulRequestAt', type: 'date' },
        { name: 'lastHealthCheckAt', type: 'date' },
        { name: 'lastReferenceDataSyncAt', type: 'date' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'lastErrorCode', type: 'text', maxLength: 100 },
        { name: 'lastErrorMessage', type: 'text', maxLength: 500 },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'disconnectedAt', type: 'date' },
        {
          name: 'disconnectedBy',
          type: 'relationship',
          relationTo: 'users',
        },
      ],
    },
    {
      name: 'disconnectReason',
      type: 'textarea',
      maxLength: 1_000,
    },
  ],
  lockDocuments: false,
  timestamps: true,
}
