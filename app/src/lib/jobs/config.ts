import { hasActiveRole } from '@/access/roles'

import type { JobsConfig, TaskConfig } from 'payload'

type ExportTask = {
  input: { exportID: string }
  output: { state: string }
}

type WebhookTask = {
  input: { receiptID: string }
  output: { state: string }
}

type MaintenanceTask = {
  input: { reason: string }
  output: { state: string }
}

const createXeroInvoice: TaskConfig<ExportTask> = {
  concurrency: () => 'xero-accounting-tenant',
  handler: async ({ input, req }) => {
    const { processInvoiceExport } = await import('@/lib/xero/export/processor')
    return { output: await processInvoiceExport(req, input.exportID) }
  },
  inputSchema: [{ name: 'exportID', type: 'text', maxLength: 100, required: true }],
  label: 'Create one Xero draft invoice',
  outputSchema: [{ name: 'state', type: 'text', maxLength: 50, required: true }],
  retries: 0,
  slug: 'create-xero-invoice',
}

const reconcileXeroInvoice: TaskConfig<ExportTask> = {
  concurrency: () => 'xero-accounting-tenant',
  handler: async ({ input, req }) => {
    const { reconcileInvoiceExport } = await import('@/lib/xero/export/reconciliation')
    return { output: await reconcileInvoiceExport(req, input.exportID) }
  },
  inputSchema: [{ name: 'exportID', type: 'text', maxLength: 100, required: true }],
  label: 'Reconcile one Xero invoice',
  outputSchema: [{ name: 'state', type: 'text', maxLength: 50, required: true }],
  retries: 0,
  slug: 'reconcile-xero-invoice',
}

const processWebhookReceipt: TaskConfig<WebhookTask> = {
  concurrency: ({ input }) => `xero-webhook-${input.receiptID}`,
  handler: async ({ input, req }) => {
    const { processWebhookReceipt } = await import('@/lib/xero/export/webhooks')
    return { output: await processWebhookReceipt(req, input.receiptID) }
  },
  inputSchema: [{ name: 'receiptID', type: 'text', maxLength: 100, required: true }],
  label: 'Process one Xero webhook receipt',
  outputSchema: [{ name: 'state', type: 'text', maxLength: 50, required: true }],
  retries: { attempts: 3, backoff: { delay: 30_000, type: 'exponential' } },
  slug: 'process-xero-webhook-receipt',
}

const refreshXeroInvoiceStatus: TaskConfig<ExportTask> = {
  concurrency: () => 'xero-accounting-tenant',
  handler: async ({ input, req }) => {
    const { refreshInvoiceExportStatus } = await import('@/lib/xero/export/reconciliation')
    const result = await refreshInvoiceExportStatus(req, input.exportID)
    return { output: { state: result.state } }
  },
  inputSchema: [{ name: 'exportID', type: 'text', maxLength: 100, required: true }],
  label: 'Refresh one Xero invoice status',
  outputSchema: [{ name: 'state', type: 'text', maxLength: 50, required: true }],
  retries: { attempts: 3, backoff: { delay: 30_000, type: 'exponential' } },
  slug: 'refresh-xero-invoice-status',
}

const maintainXeroAccounting: TaskConfig<MaintenanceTask> = {
  concurrency: () => 'xero-accounting-tenant',
  handler: async ({ input, req }) => {
    const { maintainXeroAccountingConnection } = await import('@/lib/xero/export/maintenance')
    return { output: await maintainXeroAccountingConnection(req, input.reason) }
  },
  inputSchema: [{ name: 'reason', type: 'text', maxLength: 100, required: true }],
  label: 'Maintain Xero accounting connection',
  outputSchema: [{ name: 'state', type: 'text', maxLength: 50, required: true }],
  retries: { attempts: 2, backoff: { delay: 60_000, type: 'exponential' } },
  slug: 'maintain-xero-accounting',
}

export const jobsConfig: JobsConfig = {
  addParentToTaskLog: true,
  deleteJobOnComplete: false,
  depth: 0,
  enableConcurrencyControl: true,
  jobsCollectionOverrides: ({ defaultJobsCollection }) => ({
    ...defaultJobsCollection,
    access: {
      ...defaultJobsCollection.access,
      create: () => false,
      delete: () => false,
      read: ({ req }) => hasActiveRole(req.user, ['owner', 'admin']),
      update: () => false,
    },
    admin: { ...defaultJobsCollection.admin, hidden: true },
  }),
  processingOrder: { queues: { xero: 'createdAt' } },
  tasks: [
    createXeroInvoice,
    reconcileXeroInvoice,
    processWebhookReceipt,
    refreshXeroInvoiceStatus,
    maintainXeroAccounting,
  ],
}
