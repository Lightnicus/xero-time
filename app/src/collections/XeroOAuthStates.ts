import type { CollectionConfig } from 'payload'

const denyAll = () => false

export const XeroOAuthStates: CollectionConfig = {
  slug: 'xero-oauth-states',
  access: {
    admin: denyAll,
    create: denyAll,
    delete: denyAll,
    read: denyAll,
    update: denyAll,
  },
  admin: {
    hidden: true,
    useAsTitle: 'id',
  },
  disableBulkDelete: true,
  disableBulkEdit: true,
  disableDuplicate: true,
  endpoints: false,
  fields: [
    {
      name: 'family',
      type: 'select',
      defaultValue: 'accounting',
      index: true,
      options: [
        { label: 'Accounting', value: 'accounting' },
        { label: 'Identity', value: 'identity' },
      ],
      required: true,
    },
    {
      name: 'purpose',
      type: 'select',
      options: [
        { label: 'Initial connection', value: 'initial-connect' },
        { label: 'Reconnect', value: 'reconnect' },
        { label: 'Authorizer handover', value: 'authorizer-handover' },
        { label: 'Identity sign-in', value: 'sign-in' },
        { label: 'Invitation acceptance', value: 'invite-acceptance' },
        { label: 'Identity link', value: 'identity-link' },
      ],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      index: true,
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Consumed', value: 'consumed' },
        { label: 'Awaiting tenant selection', value: 'awaiting-selection' },
        { label: 'Completed', value: 'completed' },
        { label: 'Failed', value: 'failed' },
      ],
      required: true,
    },
    {
      name: 'stateHash',
      type: 'text',
      hidden: true,
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'browserBindingHash',
      type: 'text',
      hidden: true,
      required: true,
    },
    {
      name: 'initiatingUser',
      type: 'relationship',
      relationTo: 'users',
      maxDepth: 0,
    },
    {
      name: 'invitation',
      type: 'relationship',
      relationTo: 'invitations',
      maxDepth: 0,
    },
    {
      name: 'returnPath',
      type: 'text',
      maxLength: 500,
      defaultValue: '/app',
    },
    {
      type: 'row',
      fields: [
        { name: 'nonceEnvelope', type: 'textarea', hidden: true },
        { name: 'pkceVerifierEnvelope', type: 'textarea', hidden: true },
      ],
    },
    {
      name: 'pinnedTenantId',
      type: 'text',
      maxLength: 100,
    },
    {
      name: 'handoverReason',
      type: 'textarea',
      hidden: true,
      maxLength: 1_000,
    },
    {
      type: 'row',
      fields: [
        { name: 'expiresAt', type: 'date', required: true },
        { name: 'consumedAt', type: 'date' },
        { name: 'completedAt', type: 'date' },
      ],
    },
    {
      name: 'pendingConnections',
      type: 'json',
      hidden: true,
    },
    {
      name: 'pendingGrantEnvelope',
      type: 'textarea',
      hidden: true,
    },
    {
      type: 'row',
      fields: [
        { name: 'failureCode', type: 'text', maxLength: 100 },
        { name: 'selectedTenantId', type: 'text', maxLength: 100 },
      ],
    },
  ],
  indexes: [
    { fields: ['family', 'status', 'expiresAt'] },
    { fields: ['family', 'initiatingUser', 'status'] },
    { fields: ['family', 'invitation', 'status'] },
  ],
  lockDocuments: false,
  timestamps: true,
}
