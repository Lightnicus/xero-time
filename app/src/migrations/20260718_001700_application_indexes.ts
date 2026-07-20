import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-mongodb'

export type ApplicationIndex = {
  collection: string
  expireAfterSeconds?: number
  key: Record<string, -1 | 1>
  name: string
  partialFilterExpression?: Record<string, unknown>
  sparse?: boolean
  unique?: boolean
}

/** Indexes required for correctness or the application's bounded query paths. */
export const APPLICATION_INDEXES: readonly ApplicationIndex[] = [
  { collection: 'users', key: { email: 1 }, name: 'email_1', unique: true },
  {
    collection: 'users',
    key: { bootstrapMarker: 1 },
    name: 'bootstrapMarker_1',
    sparse: true,
    unique: true,
  },
  { collection: 'invitations', key: { email: 1 }, name: 'email_1', unique: true },
  { collection: 'invitations', key: { tokenHash: 1 }, name: 'tokenHash_1', unique: true },
  { collection: 'invitations', key: { status: 1, expiresAt: 1 }, name: 'status_1_expiresAt_1' },
  {
    collection: 'invitations',
    expireAfterSeconds: 0,
    key: { cleanupAt: 1 },
    name: 'cleanupAt_1',
  },
  {
    collection: 'auth-identities',
    key: { provider: 1, issuer: 1, subject: 1 },
    name: 'provider_1_issuer_1_subject_1',
    unique: true,
  },
  {
    collection: 'auth-identities',
    key: { user: 1, provider: 1 },
    name: 'user_1_provider_1',
    unique: true,
  },
  {
    collection: 'auth-identities',
    key: { status: 1, lastUsedAt: 1 },
    name: 'status_1_lastUsedAt_1',
  },
  {
    collection: 'external-auth-sessions',
    key: { tokenHash: 1 },
    name: 'tokenHash_1',
    unique: true,
  },
  {
    collection: 'external-auth-sessions',
    key: { user: 1, status: 1, absoluteExpiresAt: 1 },
    name: 'user_1_status_1_absoluteExpiresAt_1',
  },
  {
    collection: 'external-auth-sessions',
    key: { identity: 1, status: 1 },
    name: 'identity_1_status_1',
  },
  {
    collection: 'external-auth-sessions',
    key: { status: 1, idleExpiresAt: 1 },
    name: 'status_1_idleExpiresAt_1',
  },
  {
    collection: 'external-auth-sessions',
    expireAfterSeconds: 0,
    key: { cleanupAt: 1 },
    name: 'cleanupAt_1',
  },
  {
    collection: 'xero-oauth-states',
    key: { stateHash: 1 },
    name: 'stateHash_1',
    unique: true,
  },
  {
    collection: 'xero-oauth-states',
    expireAfterSeconds: 0,
    key: { expiresAt: 1 },
    name: 'expiresAt_1',
  },
  {
    collection: 'xero-oauth-states',
    key: { family: 1, status: 1, expiresAt: 1 },
    name: 'family_1_status_1_expiresAt_1',
  },
  {
    collection: 'xero-oauth-states',
    key: { family: 1, initiatingUser: 1, status: 1 },
    name: 'family_1_initiatingUser_1_status_1',
  },
  {
    collection: 'xero-oauth-states',
    key: { family: 1, invitation: 1, status: 1 },
    name: 'family_1_invitation_1_status_1',
  },
  { collection: 'customers', key: { status: 1, name: 1 }, name: 'status_1_name_1' },
  {
    collection: 'customers',
    key: { xeroContactId: 1 },
    name: 'xeroContactId_1',
    sparse: true,
    unique: true,
  },
  {
    collection: 'customers',
    key: { currency: 1, status: 1 },
    name: 'currency_1_status_1',
  },
  { collection: 'projects', key: { code: 1 }, name: 'code_1', unique: true },
  {
    collection: 'projects',
    key: { customer: 1, status: 1 },
    name: 'customer_1_status_1',
  },
  { collection: 'projects', key: { status: 1, name: 1 }, name: 'status_1_name_1' },
  {
    collection: 'time-entries',
    key: { owner: 1, workDate: 1 },
    name: 'owner_1_workDate_1',
  },
  {
    collection: 'time-entries',
    key: { project: 1, workDate: 1 },
    name: 'project_1_workDate_1',
  },
  {
    collection: 'time-entries',
    key: { customer: 1, billingStatus: 1, billable: 1, workDate: 1 },
    name: 'customer_1_billingStatus_1_billable_1_workDate_1',
  },
  { collection: 'time-entries', key: { currentExport: 1 }, name: 'currentExport_1' },
  {
    collection: 'xero-connections',
    key: { singletonKey: 1 },
    name: 'singletonKey_1',
    unique: true,
  },
  { collection: 'xero-connections', key: { status: 1 }, name: 'status_1' },
  {
    collection: 'xero-reference-datas',
    key: { sourceTenantId: 1, resourceType: 1, xeroId: 1 },
    name: 'sourceTenantId_1_resourceType_1_xeroId_1',
    unique: true,
  },
  {
    collection: 'xero-reference-datas',
    key: { sourceTenantId: 1, resourceType: 1, code: 1 },
    name: 'sourceTenantId_1_resourceType_1_code_1',
  },
  {
    collection: 'xero-reference-datas',
    key: { resourceType: 1, status: 1, name: 1 },
    name: 'resourceType_1_status_1_name_1',
  },
  {
    collection: 'export-batches',
    key: { applicationReference: 1 },
    name: 'applicationReference_1',
    unique: true,
  },
  {
    collection: 'export-batches',
    key: { requestedBy: 1, createdAt: 1 },
    name: 'requestedBy_1_createdAt_1',
  },
  {
    collection: 'export-batches',
    key: { status: 1, createdAt: 1 },
    name: 'status_1_createdAt_1',
  },
  {
    collection: 'invoice-exports',
    key: { applicationReference: 1 },
    name: 'applicationReference_1',
    unique: true,
  },
  {
    collection: 'invoice-exports',
    key: { state: 1, createdAt: 1 },
    name: 'state_1_createdAt_1',
  },
  {
    collection: 'invoice-exports',
    key: { dispatchState: 1, jobId: 1, createdAt: 1 },
    name: 'dispatchState_1_jobId_1_createdAt_1',
  },
  {
    collection: 'invoice-exports',
    key: { state: 1, nextAttemptAt: 1 },
    name: 'state_1_nextAttemptAt_1',
  },
  {
    collection: 'invoice-exports',
    key: { xeroInvoiceId: 1 },
    name: 'xeroInvoiceId_unique_when_present',
    partialFilterExpression: { xeroInvoiceId: { $type: 'string' } },
    unique: true,
  },
  {
    collection: 'invoice-export-entries',
    key: { invoiceExport: 1, timeEntry: 1 },
    name: 'invoiceExport_1_timeEntry_1',
    unique: true,
  },
  {
    collection: 'invoice-export-entries',
    key: { invoiceExport: 1, lineOrdinal: 1 },
    name: 'invoiceExport_1_lineOrdinal_1',
    unique: true,
  },
  {
    collection: 'invoice-export-entries',
    key: { timeEntry: 1, releasedAt: 1 },
    name: 'timeEntry_1_releasedAt_1',
  },
  {
    collection: 'xero-attempts',
    key: { invoiceExport: 1, attemptNumber: 1 },
    name: 'invoiceExport_1_attemptNumber_1',
    unique: true,
  },
  {
    collection: 'xero-attempts',
    key: { idempotencyKey: 1 },
    name: 'idempotencyKey_1',
    unique: true,
  },
  {
    collection: 'xero-attempts',
    key: { result: 1, leaseExpiresAt: 1 },
    name: 'result_1_leaseExpiresAt_1',
  },
  {
    collection: 'xero-contact-operations',
    key: { applicationReference: 1 },
    name: 'applicationReference_1',
    unique: true,
  },
  {
    collection: 'xero-contact-operations',
    key: { idempotencyKey: 1 },
    name: 'idempotencyKey_1',
    unique: true,
  },
  {
    collection: 'xero-contact-operations',
    key: { state: 1, createdAt: 1 },
    name: 'state_1_createdAt_1',
  },
  {
    collection: 'xero-webhook-receipts',
    key: { deduplicationKey: 1 },
    name: 'deduplicationKey_1',
    unique: true,
  },
  {
    collection: 'xero-webhook-receipts',
    key: { status: 1, receivedAt: 1 },
    name: 'status_1_receivedAt_1',
  },
  {
    collection: 'xero-webhook-receipts',
    key: { tenantId: 1, resourceType: 1, resourceId: 1, eventAt: 1 },
    name: 'tenantId_1_resourceType_1_resourceId_1_eventAt_1',
  },
  {
    collection: 'release-actions',
    key: { sourceExport: 1 },
    name: 'sourceExport_1',
    unique: true,
  },
  {
    collection: 'release-actions',
    key: { actor: 1, releasedAt: 1 },
    name: 'actor_1_releasedAt_1',
  },
  {
    collection: 'audit-events',
    key: { occurredAt: 1, eventType: 1 },
    name: 'occurredAt_1_eventType_1',
  },
  {
    collection: 'audit-events',
    key: { actor: 1, occurredAt: 1 },
    name: 'actor_1_occurredAt_1',
  },
  {
    collection: 'audit-events',
    key: { targetCollection: 1, targetId: 1, occurredAt: 1 },
    name: 'targetCollection_1_targetId_1_occurredAt_1',
  },
  {
    collection: 'audit-events',
    key: { customerId: 1, occurredAt: 1 },
    name: 'customerId_1_occurredAt_1',
  },
  {
    collection: 'audit-events',
    key: { exportId: 1, occurredAt: 1 },
    name: 'exportId_1_occurredAt_1',
  },
  {
    collection: 'application_rate_limits',
    expireAfterSeconds: 0,
    key: { cleanupAt: 1 },
    name: 'cleanupAt_1',
  },
]

export async function up({ payload }: MigrateUpArgs): Promise<void> {
  const database = payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable while creating application indexes.')

  for (const definition of APPLICATION_INDEXES) {
    const { collection, expireAfterSeconds, key, name, partialFilterExpression, sparse, unique } =
      definition
    await database.collection(collection).createIndex(key, {
      ...(typeof expireAfterSeconds === 'number' ? { expireAfterSeconds } : {}),
      ...(partialFilterExpression ? { partialFilterExpression } : {}),
      ...(sparse ? { sparse: true } : {}),
      ...(unique ? { unique: true } : {}),
      name,
    })
  }
}

export async function down({ payload }: MigrateDownArgs): Promise<void> {
  payload.logger.warn(
    'Application indexes are retained on down migration; dropping correctness indexes requires a separately reviewed maintenance operation.',
  )
}
