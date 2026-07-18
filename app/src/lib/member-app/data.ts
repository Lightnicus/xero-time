import 'server-only'

import type { BusinessSetting, Project, TimeEntry } from '@/payload-types'

import {
  dateRangeForFilters,
  shiftCalendarDate,
  weekKeyForCalendarDate,
  type TimeEntryFilters,
} from './time-filters'

import type { AppSession } from './session'
import type { Where } from 'payload'

export type ProjectOption = Pick<Project, 'billableByDefault' | 'code' | 'id' | 'name'>
export type TimeProjectFilterOption = Pick<ProjectOption, 'code' | 'id' | 'name'>
export type TimeCustomerFilterOption = { id: string; name: string }

export type TimeTotal = {
  date: string
  durationSeconds: number
  entryCount: number
}

export type TimeEntrySummary = {
  billableSeconds: number
  daily: TimeTotal[]
  durationSeconds: number
  entryCount: number
  lockedCount: number
  unbilledCount: number
  weekly: TimeTotal[]
}

export async function getBusinessSettings(session: AppSession): Promise<BusinessSetting> {
  return session.payload.findGlobal({
    slug: 'business-settings',
    overrideAccess: false,
    req: session.req,
  })
}

export async function listMyTimeEntries(
  session: AppSession,
  requestedPage = 1,
  filters?: TimeEntryFilters,
): Promise<{
  entries: TimeEntry[]
  hasNextPage: boolean
  hasPrevPage: boolean
  page: number
  summary: TimeEntrySummary
  total: number
  totalPages: number
}> {
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const clauses: Where[] = [{ owner: { equals: session.user.id } }]
  const range = filters ? dateRangeForFilters(filters) : null

  if (range) {
    clauses.push({
      and: [
        { workDate: { greater_than_equal: range.from } },
        { workDate: { less_than_equal: range.to } },
      ],
    })
  }
  if (filters?.project) clauses.push({ project: { equals: filters.project } })
  if (filters?.customer) clauses.push({ customer: { equals: filters.customer } })
  if (filters?.billingStatus) {
    clauses.push({ billingStatus: { equals: filters.billingStatus } })
  }
  if (filters?.billable) clauses.push({ billable: { equals: filters.billable === 'yes' } })

  const where: Where = { and: clauses }
  const [result, summaryResult] = await Promise.all([
    session.payload.find({
      collection: 'time-entries',
      depth: 0,
      limit: 25,
      overrideAccess: false,
      page,
      req: session.req,
      sort: ['-workDate', '-createdAt', '-id'],
      where,
    }),
    session.payload.find({
      collection: 'time-entries',
      depth: 0,
      overrideAccess: false,
      pagination: false,
      req: session.req,
      sort: 'workDate',
      where,
    }),
  ])
  const dailyTotals = new Map<string, TimeTotal>()
  const weeklyTotals = new Map<string, TimeTotal>()

  if (range) {
    for (let date = range.from; date <= range.to; date = shiftCalendarDate(date, 1)) {
      dailyTotals.set(date, { date, durationSeconds: 0, entryCount: 0 })

      const weekDate = weekKeyForCalendarDate(date)
      if (!weeklyTotals.has(weekDate)) {
        weeklyTotals.set(weekDate, { date: weekDate, durationSeconds: 0, entryCount: 0 })
      }
    }
  }

  let billableSeconds = 0
  let durationSeconds = 0
  let unbilledCount = 0

  for (const entry of summaryResult.docs) {
    durationSeconds += entry.durationSeconds
    if (entry.billable) billableSeconds += entry.durationSeconds
    if (entry.billingStatus === 'unbilled') unbilledCount += 1

    const daily = dailyTotals.get(entry.workDate) ?? {
      date: entry.workDate,
      durationSeconds: 0,
      entryCount: 0,
    }
    daily.durationSeconds += entry.durationSeconds
    daily.entryCount += 1
    dailyTotals.set(entry.workDate, daily)

    const weekDate = weekKeyForCalendarDate(entry.workDate)
    const weekly = weeklyTotals.get(weekDate) ?? {
      date: weekDate,
      durationSeconds: 0,
      entryCount: 0,
    }
    weekly.durationSeconds += entry.durationSeconds
    weekly.entryCount += 1
    weeklyTotals.set(weekDate, weekly)
  }

  const daily = [...dailyTotals.values()].sort((left, right) =>
    filters?.view === 'all'
      ? right.date.localeCompare(left.date)
      : left.date.localeCompare(right.date),
  )
  const weekly = [...weeklyTotals.values()].sort((left, right) =>
    right.date.localeCompare(left.date),
  )

  return {
    entries: result.docs,
    hasNextPage: result.hasNextPage,
    hasPrevPage: result.hasPrevPage,
    page: result.page ?? page,
    summary: {
      billableSeconds,
      daily,
      durationSeconds,
      entryCount: summaryResult.docs.length,
      lockedCount: summaryResult.docs.length - unbilledCount,
      unbilledCount,
      weekly,
    },
    total: result.totalDocs,
    totalPages: result.totalPages,
  }
}

export async function findMyTimeEntry(session: AppSession, id: string): Promise<TimeEntry | null> {
  const result = await session.payload.find({
    collection: 'time-entries',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: session.req,
    where: {
      and: [{ id: { equals: id } }, { owner: { equals: session.user.id } }],
    },
  })

  return result.docs[0] ?? null
}

export async function listActiveProjectOptions(session: AppSession): Promise<ProjectOption[]> {
  const customers = await session.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 500,
    overrideAccess: false,
    pagination: false,
    req: session.req,
    where: {
      status: { equals: 'active' },
    },
  })
  const customerIDs = customers.docs.map((customer) => customer.id)

  if (customerIDs.length === 0) return []

  const result = await session.payload.find({
    collection: 'projects',
    depth: 0,
    limit: 500,
    overrideAccess: false,
    pagination: false,
    req: session.req,
    sort: 'code',
    where: {
      and: [{ status: { equals: 'active' } }, { customer: { in: customerIDs } }],
    },
  })

  return result.docs.map(({ billableByDefault, code, id, name }) => ({
    billableByDefault,
    code,
    id,
    name,
  }))
}

export async function listMyProjectFilterOptions(
  session: AppSession,
): Promise<TimeProjectFilterOption[]> {
  const result = await session.payload.find({
    collection: 'time-entries',
    depth: 0,
    overrideAccess: false,
    pagination: false,
    req: session.req,
    sort: 'projectCodeSnapshot',
    where: {
      owner: { equals: session.user.id },
    },
  })
  const projects = new Map<string, TimeProjectFilterOption>()

  for (const entry of result.docs) {
    const projectID =
      typeof entry.project === 'string' || typeof entry.project === 'number'
        ? String(entry.project)
        : entry.project.id

    projects.set(projectID, {
      code: entry.projectCodeSnapshot,
      id: projectID,
      name: entry.projectNameSnapshot,
    })
  }

  return [...projects.values()].sort((left, right) => left.code.localeCompare(right.code))
}

export async function listMyCustomerFilterOptions(
  session: AppSession,
): Promise<TimeCustomerFilterOption[]> {
  const result = await session.payload.find({
    collection: 'time-entries',
    depth: 0,
    overrideAccess: false,
    pagination: false,
    req: session.req,
    sort: 'customerNameSnapshot',
    where: { owner: { equals: session.user.id } },
  })
  const customers = new Map<string, TimeCustomerFilterOption>()
  for (const entry of result.docs) {
    const customerID =
      typeof entry.customer === 'string' || typeof entry.customer === 'number'
        ? String(entry.customer)
        : String(entry.customer.id)
    customers.set(customerID, { id: customerID, name: entry.customerNameSnapshot })
  }
  return [...customers.values()].sort((left, right) => left.name.localeCompare(right.name))
}
