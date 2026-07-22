import { ValidationError } from 'payload'

import {
  adminOnly,
  authenticatedField,
  createTimeEntry,
  deleteOwnUnbilledTime,
  financialField,
  ownerAdminField,
  readTimeEntries,
  systemFieldWrite,
  updateOwnUnbilledTime,
} from '@/access/domain'
import { isActiveOwnerOrAdmin, isActiveUser, ownerOrAdmin } from '@/access/roles'
import {
  DEFAULT_TIMEZONE,
  MAX_TIME_ENTRY_SECONDS,
  formatCalendarDateInTimezone,
  isRecord,
  isValidCalendarDate,
  isValidCurrencyCode,
  isValidIanaTimezone,
  relationshipID,
  timezoneOptions,
  validateCalendarDate,
  validateIanaTimezone,
} from '@/lib/domain/validation'

import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  CollectionBeforeValidateHook,
  CollectionSlug,
  FilterOptions,
  PayloadRequest,
  Validate,
  Where,
} from 'payload'

const CUSTOMERS_SLUG = 'customers' as CollectionSlug
const PROJECTS_SLUG = 'projects' as CollectionSlug
const USERS_SLUG = 'users' as CollectionSlug
const MINUTE_MS = 60_000
const deleteAccessOverrides = new WeakMap<PayloadRequest, boolean>()
const requestedUpdateFields = new WeakMap<PayloadRequest, Set<string>>()

/** Required on trusted Local API calls that perform one exact billing transition. */
export const TIME_ENTRY_BILLING_MUTATION_CONTEXT = 'allowTimeEntryBillingMutation'
export type TimeEntryBillingMutation = 'export' | 'release' | 'reserve'
export const TIME_ENTRY_PRIVILEGED_MUTATION_CONTEXT = 'privilegedTimeEntryMutation'

type TimeEntryHookDocument = Record<string, unknown> & { id: number | string }

const activeOrCurrentTimeRelationship =
  (field: 'owner' | 'project', activeFilter: Where): FilterOptions =>
  async ({ id, req }) => {
    if (typeof id === 'undefined') return activeFilter

    try {
      const existingEntry = await req.payload.findByID({
        collection: 'time-entries' as CollectionSlug,
        id,
        depth: 0,
        overrideAccess: true,
        req,
      })
      const existingRelationshipID = relationshipID(
        isRecord(existingEntry) ? existingEntry[field] : null,
      )

      return existingRelationshipID === null
        ? activeFilter
        : {
            or: [activeFilter, { id: { equals: existingRelationshipID } }],
          }
    } catch {
      return activeFilter
    }
  }

const activeOrCurrentOwner = activeOrCurrentTimeRelationship('owner', {
  active: { equals: true },
})
const activeOrCurrentProject = activeOrCurrentTimeRelationship('project', {
  status: { equals: 'active' },
})

const timeEntryValidationError = (path: string, message: string, req: PayloadRequest): never => {
  throw new ValidationError({
    collection: 'time-entries',
    errors: [{ message, path }],
    req,
  })
}

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null

  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const activeUserTimezone = (user: unknown): string | null => {
  if (!isRecord(user) || !isActiveUser(user)) {
    return null
  }

  const timezone = (user as Record<string, unknown>).timezone

  return isValidIanaTimezone(timezone) ? timezone : null
}

const validateDescription: Validate<string> = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? true : 'Describe the work performed.'

/**
 * Produces one canonical, minute-precise duration while retaining only the fields
 * belonging to the selected source mode.
 */
const normalizeTimeInput: CollectionBeforeValidateHook<TimeEntryHookDocument> = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const merged = { ...originalDoc, ...data }
  const inputMode = merged.inputMode
  const timezoneCandidate = merged.timezone ?? activeUserTimezone(req.user) ?? DEFAULT_TIMEZONE

  if (!isValidIanaTimezone(timezoneCandidate)) {
    return timeEntryValidationError('timezone', 'Select a valid IANA timezone.', req)
  }

  data.timezone = timezoneCandidate

  if (inputMode === 'range') {
    const start = parseDate(merged.startAt)
    const end = parseDate(merged.endAt)

    if (!start) {
      return timeEntryValidationError('startAt', 'Enter a valid start date and time.', req)
    }
    if (!end) {
      return timeEntryValidationError('endAt', 'Enter a valid finish date and time.', req)
    }
    if (start.getTime() % MINUTE_MS !== 0 || end.getTime() % MINUTE_MS !== 0) {
      return timeEntryValidationError(
        'startAt',
        'Start and finish times must use whole-minute precision.',
        req,
      )
    }

    const durationSeconds = (end.getTime() - start.getTime()) / 1_000

    if (durationSeconds <= 0) {
      return timeEntryValidationError('endAt', 'Finish must be after start.', req)
    }
    if (durationSeconds > MAX_TIME_ENTRY_SECONDS) {
      return timeEntryValidationError('endAt', 'A time entry cannot exceed 24 hours.', req)
    }

    data.startAt = start.toISOString()
    data.endAt = end.toISOString()
    data.enteredHours = null
    data.enteredMinutes = null
    data.durationSeconds = durationSeconds
    data.workDate = formatCalendarDateInTimezone(start, timezoneCandidate)
  } else if (inputMode === 'duration') {
    const hours = merged.enteredHours ?? 0
    const minutes = merged.enteredMinutes ?? 0

    if (!Number.isSafeInteger(hours) || (hours as number) < 0 || (hours as number) > 24) {
      return timeEntryValidationError(
        'enteredHours',
        'Hours must be a whole number from 0 to 24.',
        req,
      )
    }
    if (!Number.isSafeInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 59) {
      return timeEntryValidationError(
        'enteredMinutes',
        'Minutes must be a whole number from 0 to 59.',
        req,
      )
    }
    if (!isValidCalendarDate(merged.workDate)) {
      return timeEntryValidationError(
        'workDate',
        'Enter a valid work date in YYYY-MM-DD format.',
        req,
      )
    }

    const durationSeconds = ((hours as number) * 60 + (minutes as number)) * 60

    if (durationSeconds <= 0) {
      return timeEntryValidationError('enteredMinutes', 'Enter a duration greater than zero.', req)
    }
    if (durationSeconds > MAX_TIME_ENTRY_SECONDS) {
      return timeEntryValidationError('enteredHours', 'A time entry cannot exceed 24 hours.', req)
    }

    data.startAt = null
    data.endAt = null
    data.enteredHours = hours
    data.enteredMinutes = minutes
    data.durationSeconds = durationSeconds
    data.workDate = merged.workDate
  } else {
    return timeEntryValidationError(
      'inputMode',
      'Choose either start/finish or hours/minutes.',
      req,
    )
  }

  if (operation === 'create') {
    if (isActiveOwnerOrAdmin(req.user)) {
      data.owner = relationshipID(data.owner) ?? req.user.id
    } else if (isActiveUser(req.user)) {
      data.owner = req.user.id
    }

    data.billingStatus = 'unbilled'
    data.currentExport = null
    data.reservedAt = null
    data.exportedAt = null
  }

  return data
}

/** Snapshots the project/customer billing boundary whenever an entry is created or reprojected. */
const deriveProjectBillingData: CollectionBeforeValidateHook<TimeEntryHookDocument> = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const projectWasSubmitted = Object.hasOwn(data, 'project')
  const submittedProjectID = relationshipID(data.project)
  const originalProjectID = relationshipID(originalDoc?.project)
  const projectChanged =
    operation === 'create' ||
    (projectWasSubmitted && String(submittedProjectID) !== String(originalProjectID))

  if (operation === 'update' && !projectChanged) return data

  const projectID = submittedProjectID ?? originalProjectID
  if (projectID === null) return data

  let project: unknown

  try {
    project = await req.payload.findByID({
      collection: PROJECTS_SLUG,
      id: projectID,
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch {
    return timeEntryValidationError('project', 'Select an existing project.', req)
  }

  if (!isRecord(project)) {
    return timeEntryValidationError('project', 'Select an existing project.', req)
  }
  if (project.status !== 'active') {
    return timeEntryValidationError('project', 'Time can only be added to an active project.', req)
  }

  const customerID = relationshipID(project.customer)
  if (customerID === null) {
    return timeEntryValidationError(
      'project',
      'The selected project does not have a valid customer.',
      req,
    )
  }

  let customer: unknown

  try {
    customer = await req.payload.findByID({
      collection: CUSTOMERS_SLUG,
      id: customerID,
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch {
    return timeEntryValidationError('project', 'The project customer could not be loaded.', req)
  }

  if (!isRecord(customer)) {
    return timeEntryValidationError('project', 'The project customer could not be loaded.', req)
  }
  if (customer.status !== 'active') {
    return timeEntryValidationError(
      'project',
      'Time can only be added while the project customer is active.',
      req,
    )
  }

  if (
    typeof project.name !== 'string' ||
    typeof project.code !== 'string' ||
    typeof customer.name !== 'string' ||
    !Number.isSafeInteger(project.hourlyRateScaled) ||
    !isValidCurrencyCode(project.currency) ||
    project.currency !== customer.currency
  ) {
    return timeEntryValidationError(
      'project',
      'The selected project has incomplete or inconsistent billing defaults.',
      req,
    )
  }

  data.customer = customerID
  data.customerNameSnapshot = customer.name
  data.projectNameSnapshot = project.name
  data.projectCodeSnapshot = project.code
  data.rateSnapshotScaled = project.hourlyRateScaled
  data.currencySnapshot = project.currency

  if (operation === 'create' && typeof data.billable !== 'boolean') {
    data.billable = project.billableByDefault !== false
  }

  return data
}

const billingMutationIntent = (req: PayloadRequest): null | TimeEntryBillingMutation => {
  const value = req.context?.[TIME_ENTRY_BILLING_MUTATION_CONTEXT]
  return value === 'reserve' || value === 'export' || value === 'release' ? value : null
}

const sameBillingValue = (field: string, left: unknown, right: unknown): boolean => {
  if (left == null && right == null) return true

  if (field === 'currentExport') {
    const leftID = relationshipID(left)
    const rightID = relationshipID(right)
    return leftID !== null && rightID !== null && String(leftID) === String(rightID)
  }

  if (field === 'reservedAt' || field === 'exportedAt') {
    const leftDate = parseDate(left)
    const rightDate = parseDate(right)
    return leftDate !== null && rightDate !== null && leftDate.getTime() === rightDate.getTime()
  }

  return left === right
}

const assertBillingTransition = (
  intent: TimeEntryBillingMutation,
  data: Partial<TimeEntryHookDocument>,
  originalDoc: TimeEntryHookDocument | undefined,
  req: PayloadRequest,
): void => {
  const requestedFields = requestedUpdateFields.get(req)
  const allowedFields = new Set(['billingStatus', 'currentExport', 'exportedAt', 'reservedAt'])

  if (!requestedFields || [...requestedFields].some((field) => !allowedFields.has(field))) {
    return timeEntryValidationError(
      'billingStatus',
      'A protected billing transition may only change billing status timestamps.',
      req,
    )
  }

  const previousStatus = originalDoc?.billingStatus
  const nextStatus = data.billingStatus
  const reservedAt = data.reservedAt
  const exportedAt = data.exportedAt
  const previousExport = relationshipID(originalDoc?.currentExport)
  const nextExport = relationshipID(data.currentExport)

  const validTransition =
    (intent === 'reserve' &&
      previousStatus === 'unbilled' &&
      nextStatus === 'reserved' &&
      nextExport !== null &&
      parseDate(reservedAt) !== null &&
      exportedAt == null) ||
    (intent === 'export' &&
      previousStatus === 'reserved' &&
      nextStatus === 'exported' &&
      previousExport !== null &&
      nextExport !== null &&
      String(nextExport) === String(previousExport) &&
      parseDate(reservedAt) !== null &&
      parseDate(exportedAt) !== null) ||
    (intent === 'release' &&
      (previousStatus === 'reserved' || previousStatus === 'exported') &&
      nextStatus === 'unbilled' &&
      nextExport === null &&
      reservedAt == null &&
      exportedAt == null)

  if (!validTransition) {
    return timeEntryValidationError(
      'billingStatus',
      `Invalid ${intent} transition from ${String(previousStatus)} to ${String(nextStatus)}.`,
      req,
    )
  }
}

const protectBillingLock: CollectionBeforeChangeHook<TimeEntryHookDocument> = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation === 'create') return data

  const mutationIntent = billingMutationIntent(req)
  const changesBillingState = ['billingStatus', 'currentExport', 'reservedAt', 'exportedAt'].some(
    (field) =>
      Object.hasOwn(data, field) && !sameBillingValue(field, data[field], originalDoc?.[field]),
  )
  const existingEntryIsLocked = originalDoc?.billingStatus !== 'unbilled'

  if ((changesBillingState || existingEntryIsLocked) && mutationIntent === null) {
    return timeEntryValidationError(
      'billingStatus',
      'This entry is locked by billing. Use the protected export or release/rebill workflow.',
      req,
    )
  }

  if (mutationIntent !== null) {
    assertBillingTransition(mutationIntent, data, originalDoc, req)
  }

  return data
}

const requirePrivilegedCorrectionReason: CollectionBeforeChangeHook<TimeEntryHookDocument> = ({
  data,
  operation,
  req,
}) => {
  if (
    operation !== 'update' ||
    !isActiveOwnerOrAdmin(req.user) ||
    billingMutationIntent(req) !== null ||
    req.context?.[TIME_ENTRY_PRIVILEGED_MUTATION_CONTEXT] === 'rate-recalculation'
  ) {
    return data
  }

  const reason = data.privilegedCorrectionReason
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 1_000) {
    return timeEntryValidationError(
      'privilegedCorrectionReason',
      'Owner/admin corrections require a reason from 10 to 1,000 characters.',
      req,
    )
  }
  req.context = {
    ...(req.context ?? {}),
    auditReason: reason.trim(),
    [TIME_ENTRY_PRIVILEGED_MUTATION_CONTEXT]: 'correction',
  }
  return data
}

const auditPrivilegedCorrection: CollectionAfterChangeHook<TimeEntryHookDocument> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (
    operation !== 'update' ||
    req.context?.[TIME_ENTRY_PRIVILEGED_MUTATION_CONTEXT] !== 'correction'
  ) {
    return doc
  }
  const { recordAuditEvent } = await import('@/lib/audit/service')
  await recordAuditEvent(
    req.payload,
    {
      actor: req.user?.id,
      after: {
        billable: doc.billable,
        description: doc.description,
        durationSeconds: doc.durationSeconds,
        owner: relationshipID(doc.owner),
        project: relationshipID(doc.project),
        timezone: doc.timezone,
        workDate: doc.workDate,
      },
      before: {
        billable: previousDoc.billable,
        description: previousDoc.description,
        durationSeconds: previousDoc.durationSeconds,
        owner: relationshipID(previousDoc.owner),
        project: relationshipID(previousDoc.project),
        timezone: previousDoc.timezone,
        workDate: previousDoc.workDate,
      },
      eventType: 'time-entry.privileged-correction',
      reason: typeof req.context.auditReason === 'string' ? req.context.auditReason : undefined,
      targetCollection: 'time-entries',
      targetId: doc.id,
    },
    req,
  )
  return doc
}

const rememberOperationAccessMode: CollectionBeforeOperationHook = ({
  args,
  operation,
  overrideAccess,
  req,
}) => {
  if (operation === 'delete' || operation === 'deleteByID') {
    deleteAccessOverrides.set(req, overrideAccess === true)
  }

  if (operation === 'update' || operation === 'updateByID') {
    const submittedData = 'data' in args && isRecord(args.data) ? args.data : {}
    requestedUpdateFields.set(req, new Set(Object.keys(submittedData)))
  }
}

const protectLockedDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  // Ordinary user requests are already filtered to unbilled entries by collection access.
  // The hook is the extra invariant for trusted Local API calls that bypass access entirely.
  if (deleteAccessOverrides.get(req) !== true) return

  const entry = await req.payload.findByID({
    collection: 'time-entries' as CollectionSlug,
    id,
    depth: 0,
    overrideAccess: true,
    req,
  })

  if (isRecord(entry) && entry.billingStatus !== 'unbilled') {
    return timeEntryValidationError(
      'billingStatus',
      'A billing-locked entry cannot be deleted. Release/rebill preserves its history.',
      req,
    )
  }
}

export const TimeEntries: CollectionConfig = {
  slug: 'time-entries' as CollectionSlug,
  labels: {
    plural: 'Time Entries',
    singular: 'Time Entry',
  },
  access: {
    admin: adminOnly,
    create: createTimeEntry,
    delete: deleteOwnUnbilledTime,
    read: readTimeEntries,
    readVersions: ownerOrAdmin,
    update: updateOwnUnbilledTime,
  },
  admin: {
    defaultColumns: [
      'workDate',
      'owner',
      'project',
      'durationSeconds',
      'billable',
      'billingStatus',
    ],
    description:
      'Manual time only: enter either a start/finish range or a duration. There is no running timer.',
    group: 'Time',
    listSearchableFields: [
      'description',
      'projectNameSnapshot',
      'projectCodeSnapshot',
      'customerNameSnapshot',
    ],
  },
  defaultSort: '-workDate',
  disableBulkDelete: true,
  disableDuplicate: true,
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Time',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'owner',
                  type: 'relationship',
                  relationTo: USERS_SLUG,
                  required: true,
                  index: true,
                  maxDepth: 0,
                  filterOptions: activeOrCurrentOwner,
                  access: {
                    create: ownerAdminField,
                    read: authenticatedField,
                    update: ownerAdminField,
                  },
                  admin: {
                    allowCreate: false,
                    allowEdit: false,
                    description:
                      'Members are always assigned to themselves; an owner or admin may choose another active user.',
                    width: '50%',
                  },
                },
                {
                  name: 'project',
                  type: 'relationship',
                  relationTo: PROJECTS_SLUG,
                  required: true,
                  index: true,
                  filterOptions: activeOrCurrentProject,
                  admin: {
                    allowCreate: false,
                    description: 'Determines customer, currency, and hourly-rate snapshots.',
                    width: '50%',
                  },
                },
              ],
            },
            {
              name: 'currentExport',
              type: 'relationship',
              relationTo: 'invoice-exports',
              maxDepth: 0,
              index: true,
              access: {
                create: systemFieldWrite,
                read: financialField,
                update: systemFieldWrite,
              },
              admin: {
                description:
                  'The active reservation/export allocation. Only billing commands can set or clear it.',
                readOnly: true,
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'inputMode',
                  type: 'select',
                  required: true,
                  defaultValue: 'duration',
                  options: [
                    { label: 'Hours and minutes', value: 'duration' },
                    { label: 'Start and finish', value: 'range' },
                  ],
                  admin: { width: '33%' },
                },
                {
                  name: 'workDate',
                  type: 'text',
                  required: true,
                  index: true,
                  maxLength: 10,
                  validate: validateCalendarDate,
                  admin: {
                    description:
                      'YYYY-MM-DD. For start/finish entries this is derived from the start in the selected timezone.',
                    placeholder: '2026-07-18',
                    width: '33%',
                  },
                },
                {
                  name: 'timezone',
                  type: 'select',
                  required: true,
                  options: timezoneOptions,
                  validate: validateIanaTimezone,
                  admin: {
                    description: 'Defaults to the user timezone, then Pacific/Auckland.',
                    width: '34%',
                  },
                },
              ],
            },
            {
              type: 'row',
              admin: {
                condition: (_, siblingData) =>
                  isRecord(siblingData) && siblingData.inputMode === 'range',
              },
              fields: [
                {
                  name: 'startAt',
                  type: 'date',
                  admin: {
                    date: { pickerAppearance: 'dayAndTime', timeIntervals: 1 },
                    description: 'Whole-minute precision.',
                    width: '50%',
                  },
                },
                {
                  name: 'endAt',
                  type: 'date',
                  admin: {
                    date: { pickerAppearance: 'dayAndTime', timeIntervals: 1 },
                    description: 'Must be after start and no more than 24 hours later.',
                    width: '50%',
                  },
                },
              ],
            },
            {
              type: 'row',
              admin: {
                condition: (_, siblingData) =>
                  isRecord(siblingData) && siblingData.inputMode === 'duration',
              },
              fields: [
                {
                  name: 'enteredHours',
                  type: 'number',
                  min: 0,
                  max: 24,
                  defaultValue: 0,
                  admin: { step: 1, width: '50%' },
                },
                {
                  name: 'enteredMinutes',
                  type: 'number',
                  min: 0,
                  max: 59,
                  defaultValue: 0,
                  admin: { step: 1, width: '50%' },
                },
              ],
            },
            {
              name: 'description',
              type: 'textarea',
              required: true,
              maxLength: 2_000,
              validate: validateDescription,
              admin: {
                description:
                  'Required. Each entry remains a separate mapped line in the Xero invoice preview.',
              },
              hooks: {
                beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
              },
            },
            {
              name: 'billable',
              type: 'checkbox',
              admin: {
                description: 'Defaults from the selected project when the entry is first created.',
              },
            },
            {
              name: 'privilegedCorrectionReason',
              type: 'textarea',
              virtual: true,
              maxLength: 1_000,
              access: { read: ownerAdminField },
              admin: {
                description:
                  'Required when an owner or administrator corrects an existing unbilled entry. Recorded in the audit trail.',
              },
            },
          ],
        },
        {
          label: 'Billing snapshot',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'durationSeconds',
                  type: 'number',
                  required: true,
                  min: 60,
                  max: MAX_TIME_ENTRY_SECONDS,
                  access: {
                    create: systemFieldWrite,
                    read: authenticatedField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description:
                      'Canonical whole-minute duration derived from the selected input mode.',
                    readOnly: true,
                    step: 60,
                    width: '33%',
                  },
                },
                {
                  name: 'rateSnapshotScaled',
                  label: 'Rate snapshot',
                  type: 'number',
                  required: true,
                  min: 0,
                  access: {
                    create: systemFieldWrite,
                    read: financialField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    components: {
                      Cell: '/components/admin/ScaledCurrencyCell',
                      Field: '/components/admin/ScaledCurrencyField',
                    },
                    custom: { currencyField: 'currencySnapshot' },
                    description:
                      'Exact project hourly rate captured when the entry is created or reprojected.',
                    disableGroupBy: true,
                    disableListFilter: true,
                    readOnly: true,
                    step: 1,
                    width: '33%',
                  },
                },
                {
                  name: 'currencySnapshot',
                  type: 'text',
                  required: true,
                  maxLength: 3,
                  access: {
                    create: systemFieldWrite,
                    read: authenticatedField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description: 'ISO project/customer currency captured with the rate.',
                    readOnly: true,
                    width: '34%',
                  },
                },
              ],
            },
            {
              name: 'customer',
              type: 'relationship',
              relationTo: CUSTOMERS_SLUG,
              required: true,
              index: true,
              maxDepth: 0,
              access: {
                create: systemFieldWrite,
                read: authenticatedField,
                update: systemFieldWrite,
              },
              admin: {
                description:
                  'Derived from the selected project; direct reassignment is prohibited.',
                readOnly: true,
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'customerNameSnapshot',
                  type: 'text',
                  required: true,
                  maxLength: 200,
                  access: {
                    create: systemFieldWrite,
                    read: authenticatedField,
                    update: systemFieldWrite,
                  },
                  admin: { readOnly: true, width: '34%' },
                },
                {
                  name: 'projectNameSnapshot',
                  type: 'text',
                  required: true,
                  maxLength: 200,
                  access: {
                    create: systemFieldWrite,
                    read: authenticatedField,
                    update: systemFieldWrite,
                  },
                  admin: { readOnly: true, width: '33%' },
                },
                {
                  name: 'projectCodeSnapshot',
                  type: 'text',
                  required: true,
                  maxLength: 40,
                  access: {
                    create: systemFieldWrite,
                    read: authenticatedField,
                    update: systemFieldWrite,
                  },
                  admin: { readOnly: true, width: '33%' },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'billingStatus',
                  type: 'select',
                  required: true,
                  defaultValue: 'unbilled',
                  index: true,
                  options: [
                    { label: 'Unbilled', value: 'unbilled' },
                    { label: 'Reserved for export', value: 'reserved' },
                    { label: 'Exported', value: 'exported' },
                  ],
                  access: {
                    create: systemFieldWrite,
                    read: authenticatedField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    description:
                      'Only unbilled entries can be edited or deleted. Export and release/rebill workflows update this field with overrideAccess.',
                    readOnly: true,
                    width: '34%',
                  },
                },
                {
                  name: 'reservedAt',
                  type: 'date',
                  access: {
                    create: systemFieldWrite,
                    read: financialField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    date: { pickerAppearance: 'dayAndTime' },
                    readOnly: true,
                    width: '33%',
                  },
                },
                {
                  name: 'exportedAt',
                  type: 'date',
                  access: {
                    create: systemFieldWrite,
                    read: financialField,
                    update: systemFieldWrite,
                  },
                  admin: {
                    date: { pickerAppearance: 'dayAndTime' },
                    readOnly: true,
                    width: '33%',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  hooks: {
    afterChange: [auditPrivilegedCorrection],
    beforeChange: [protectBillingLock, requirePrivilegedCorrectionReason],
    beforeDelete: [protectLockedDelete],
    beforeOperation: [rememberOperationAccessMode],
    beforeValidate: [normalizeTimeInput, deriveProjectBillingData],
  },
  indexes: [
    { fields: ['owner', 'workDate'] },
    { fields: ['project', 'workDate'] },
    { fields: ['customer', 'billingStatus', 'billable', 'workDate'] },
  ],
  timestamps: true,
  versions: {
    drafts: false,
    maxPerDoc: 100,
  },
}
