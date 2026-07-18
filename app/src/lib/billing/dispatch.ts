import 'server-only'

import { randomUUID } from 'node:crypto'

import { requireMongoModel } from '@/lib/payload/mongo'

import type { Payload, PayloadRequest } from 'payload'

const XERO_QUEUE = 'xero'
const ATTACHING_STALE_MS = 2 * 60 * 1_000

type QueueResult = { id: number | string }
type QueueFunction = (args: {
  input: { exportID: string }
  meta: Record<string, unknown>
  queue: string
  req?: PayloadRequest
  task: 'create-xero-invoice'
}) => Promise<QueueResult>

const queueFunction = (payload: Payload): QueueFunction =>
  payload.jobs.queue as unknown as QueueFunction

const findAttachedJob = async (
  payload: Payload,
  exportID: string,
): Promise<{ _id: number | string } | null> => {
  const collection = payload.db.collections['payload-jobs']
  if (!collection) return null
  return (await collection.findOne({
    'meta.exportID': exportID,
    queue: XERO_QUEUE,
    taskSlug: 'create-xero-invoice',
  })) as { _id: number | string } | null
}

export async function dispatchInvoiceExport(
  payload: Payload,
  exportID: string,
  req?: PayloadRequest,
): Promise<{ jobID?: string; state: 'already-dispatched' | 'dispatched' | 'not-dispatchable' }> {
  const collection = requireMongoModel(payload, 'invoice-exports')
  const existing = await collection.findOne({ _id: exportID })
  if (!existing || existing.state !== 'preparing') return { state: 'not-dispatchable' }
  if (existing.dispatchState === 'dispatched' && existing.jobId) {
    return { jobID: String(existing.jobId), state: 'already-dispatched' }
  }

  if (existing.dispatchState === 'attached') {
    const attached = await findAttachedJob(payload, exportID)
    if (attached) {
      await collection.updateOne(
        { _id: exportID, dispatchState: 'attached' },
        {
          $set: {
            dispatchState: 'dispatched',
            jobId: String(attached._id),
            queuedAt: new Date(),
            state: 'queued',
            updatedAt: new Date(),
          },
        },
      )
      return { jobID: String(attached._id), state: 'dispatched' }
    }
    const updatedAt =
      existing.updatedAt instanceof Date
        ? existing.updatedAt.getTime()
        : Date.parse(String(existing.updatedAt))
    if (Number.isFinite(updatedAt) && updatedAt > Date.now() - ATTACHING_STALE_MS) {
      return { state: 'not-dispatchable' }
    }
    await collection.updateOne(
      { _id: exportID, dispatchState: 'attached' },
      { $set: { dispatchState: 'pending', jobId: null, updatedAt: new Date() } },
    )
  }

  const dispatchToken = randomUUID()
  const claim = await collection.findOneAndUpdate(
    { _id: exportID, dispatchState: 'pending', state: 'preparing' },
    {
      $set: {
        dispatchState: 'attached',
        jobId: `attaching:${dispatchToken}`,
        updatedAt: new Date(),
      },
    },
    { new: true },
  )
  if (!claim) return { state: 'not-dispatchable' }

  try {
    const job = await queueFunction(payload)({
      input: { exportID },
      meta: { dispatchToken, exportID },
      queue: XERO_QUEUE,
      req,
      task: 'create-xero-invoice',
    })
    await collection.updateOne(
      { _id: exportID, dispatchState: 'attached', jobId: `attaching:${dispatchToken}` },
      {
        $set: {
          dispatchState: 'dispatched',
          jobId: String(job.id),
          queuedAt: new Date(),
          state: 'queued',
          updatedAt: new Date(),
        },
      },
    )
    return { jobID: String(job.id), state: 'dispatched' }
  } catch (error) {
    await collection.updateOne(
      { _id: exportID, jobId: `attaching:${dispatchToken}` },
      {
        $set: {
          dispatchState: 'pending',
          jobId: null,
          lastErrorCode: 'job-attachment-failed',
          lastErrorMessage: 'The durable export is waiting for the dispatcher to attach a job.',
          updatedAt: new Date(),
        },
      },
    )
    throw error
  }
}

export async function dispatchPreparingExports(
  payload: Payload,
  req?: PayloadRequest,
  limit = 25,
): Promise<{ dispatched: number; errors: number }> {
  const exports = await payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: Math.min(Math.max(limit, 1), 100),
    overrideAccess: true,
    req,
    sort: 'createdAt',
    where: { state: { equals: 'preparing' } },
  })
  let dispatched = 0
  let errors = 0
  for (const item of exports.docs) {
    try {
      const result = await dispatchInvoiceExport(payload, String(item.id), req)
      if (result.state === 'dispatched') dispatched += 1
    } catch {
      errors += 1
    }
  }
  return { dispatched, errors }
}

export async function runExportJobWithTimeout(
  payload: Payload,
  jobID: string,
  req?: PayloadRequest,
  timeoutMS = 8_000,
): Promise<'completed' | 'continuing-in-background'> {
  const run = payload.jobs.runByID({ id: jobID, overrideAccess: true, req, silent: true })
  const timeout = new Promise<'continuing-in-background'>((resolve) => {
    setTimeout(() => resolve('continuing-in-background'), timeoutMS)
  })
  const result = await Promise.race([run.then(() => 'completed' as const), timeout])
  return result
}
