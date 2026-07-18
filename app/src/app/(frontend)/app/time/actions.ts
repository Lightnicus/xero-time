'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ValidationError } from 'payload'

import { hasActiveRole } from '@/access/roles'
import {
  isValidCalendarDate,
  isValidIanaTimezone,
  MAX_TIME_ENTRY_SECONDS,
} from '@/lib/domain/validation'
import { findMyTimeEntry } from '@/lib/member-app/data'
import { localDateTimeToISOString } from '@/lib/member-app/date-time'
import { canLogTime, requireAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { deleteUnbilledTimeEntryAsAdministrator } from '@/lib/time-entry/administration'

import type { Where } from 'payload'

export type TimeEntryField =
  | 'description'
  | 'endLocal'
  | 'enteredHours'
  | 'enteredMinutes'
  | 'inputMode'
  | 'project'
  | 'privilegedCorrectionReason'
  | 'startLocal'
  | 'timezone'
  | 'workDate'

export type TimeEntryActionState = {
  fieldErrors?: Partial<Record<TimeEntryField, string>>
  message: string | null
  overlapWarning?: boolean
}

type ParsedTimeEntry = {
  data?: Record<string, unknown>
  state?: TimeEntryActionState
}

const emptyState: TimeEntryActionState = { message: null }

const limitTimeCommand = async (
  session: Awaited<ReturnType<typeof requireAppSession>>,
): Promise<void> =>
  enforceRateLimit(session.payload, {
    key: rateLimitKey(await headers(), String(session.user.id)),
    limit: 120,
    scope: 'command.time-entry',
    windowMs: 15 * 60_000,
  })

const stringValue = (formData: FormData, name: string): string => {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

const wholeNumber = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const validationState = (
  fieldErrors: NonNullable<TimeEntryActionState['fieldErrors']>,
): TimeEntryActionState => ({
  fieldErrors,
  message: 'Check the highlighted fields and try again.',
})

const parseTimeEntry = (formData: FormData): ParsedTimeEntry => {
  const description = stringValue(formData, 'description').trim()
  const inputMode = stringValue(formData, 'inputMode')
  const project = stringValue(formData, 'project')
  const timezone = stringValue(formData, 'timezone')
  const fieldErrors: NonNullable<TimeEntryActionState['fieldErrors']> = {}

  if (project.length === 0 || project.length > 100) {
    fieldErrors.project = 'Select a project.'
  }
  if (description.length === 0) {
    fieldErrors.description = 'Describe the work performed.'
  } else if (description.length > 2_000) {
    fieldErrors.description = 'Keep the description to 2,000 characters or fewer.'
  }
  if (!isValidIanaTimezone(timezone)) {
    fieldErrors.timezone = 'Select a valid timezone.'
  }
  if (inputMode !== 'duration' && inputMode !== 'range') {
    fieldErrors.inputMode = 'Choose hours/minutes or start/finish.'
  }

  const data: Record<string, unknown> = {
    billable: stringValue(formData, 'billable') === 'true',
    description,
    inputMode,
    project,
    timezone,
  }
  const correctionReason = stringValue(formData, 'privilegedCorrectionReason').trim()
  if (correctionReason) data.privilegedCorrectionReason = correctionReason

  if (inputMode === 'duration') {
    const workDate = stringValue(formData, 'workDate')
    const enteredHours = wholeNumber(stringValue(formData, 'enteredHours'))
    const enteredMinutes = wholeNumber(stringValue(formData, 'enteredMinutes'))

    if (!isValidCalendarDate(workDate)) {
      fieldErrors.workDate = 'Enter a valid work date.'
    }
    if (enteredHours === null || enteredHours < 0 || enteredHours > 24) {
      fieldErrors.enteredHours = 'Enter whole hours from 0 to 24.'
    }
    if (enteredMinutes === null || enteredMinutes < 0 || enteredMinutes > 59) {
      fieldErrors.enteredMinutes = 'Enter whole minutes from 0 to 59.'
    }

    if (enteredHours !== null && enteredMinutes !== null) {
      const durationSeconds = (enteredHours * 60 + enteredMinutes) * 60

      if (durationSeconds <= 0 || durationSeconds > MAX_TIME_ENTRY_SECONDS) {
        fieldErrors.enteredMinutes = 'Enter a duration greater than zero and no more than 24 hours.'
      }
    }

    data.enteredHours = enteredHours
    data.enteredMinutes = enteredMinutes
    data.workDate = workDate
  }

  if (inputMode === 'range') {
    const startLocal = stringValue(formData, 'startLocal')
    const endLocal = stringValue(formData, 'endLocal')
    const startAt = localDateTimeToISOString(startLocal, timezone)
    const endAt = localDateTimeToISOString(endLocal, timezone)

    if (!startAt) {
      fieldErrors.startLocal = 'Enter a valid, unambiguous start time in the selected timezone.'
    }
    if (!endAt) {
      fieldErrors.endLocal = 'Enter a valid, unambiguous finish time in the selected timezone.'
    }

    if (startAt && endAt) {
      const durationSeconds = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 1_000

      if (durationSeconds <= 0) {
        fieldErrors.endLocal = 'Finish must be after start.'
      } else if (durationSeconds > MAX_TIME_ENTRY_SECONDS) {
        fieldErrors.endLocal = 'A time entry cannot exceed 24 hours.'
      }
    }

    data.endAt = endAt
    data.startAt = startAt
    data.workDate = startLocal.slice(0, 10)
  }

  return Object.keys(fieldErrors).length > 0 ? { state: validationState(fieldErrors) } : { data }
}

const pathAliases: Record<string, TimeEntryField> = {
  endAt: 'endLocal',
  startAt: 'startLocal',
}

const stateFromError = (error: unknown): TimeEntryActionState => {
  if (error instanceof ValidationError) {
    const fieldErrors: NonNullable<TimeEntryActionState['fieldErrors']> = {}

    for (const item of error.data.errors) {
      const field = (pathAliases[item.path] ?? item.path) as TimeEntryField
      fieldErrors[field] = item.message
    }

    return {
      fieldErrors,
      message: error.data.errors[0]?.message ?? 'The time entry could not be saved.',
    }
  }

  return { message: 'The time entry could not be saved. Please try again.' }
}

const overlapWarning = async (
  session: Awaited<ReturnType<typeof requireAppSession>>,
  data: Record<string, unknown>,
  formData: FormData,
  excludeID?: string,
): Promise<TimeEntryActionState | null> => {
  if (
    data.inputMode !== 'range' ||
    typeof data.startAt !== 'string' ||
    typeof data.endAt !== 'string' ||
    stringValue(formData, 'confirmOverlap') === 'yes'
  ) {
    return null
  }
  const clauses: Where[] = [
    { owner: { equals: session.user.id } },
    { inputMode: { equals: 'range' } },
    { startAt: { less_than: data.endAt } },
    { endAt: { greater_than: data.startAt } },
  ]
  if (excludeID) clauses.push({ id: { not_equals: excludeID } })
  const overlaps = await session.payload.find({
    collection: 'time-entries',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: session.req,
    where: { and: clauses },
  })
  return overlaps.docs.length > 0
    ? {
        message:
          'This range overlaps another entry. Review both entries, then confirm if this is intentional.',
        overlapWarning: true,
      }
    : null
}

export async function createTimeEntryAction(
  _previousState: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const session = await requireAppSession()

  if (!canLogTime(session.user)) {
    return { message: 'Your account does not have permission to record time.' }
  }

  const parsed = parseTimeEntry(formData)
  if (!parsed.data) return parsed.state ?? emptyState

  try {
    await limitTimeCommand(session)
    const warning = await overlapWarning(session, parsed.data, formData)
    if (warning) return warning
    await session.payload.create({
      collection: 'time-entries',
      data: parsed.data as never,
      overrideAccess: false,
      req: session.req,
    })
  } catch (error) {
    return stateFromError(error)
  }

  revalidatePath('/app')
  redirect('/app?created=1')
}

export async function updateTimeEntryAction(
  _previousState: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const session = await requireAppSession()

  if (!canLogTime(session.user)) {
    return { message: 'Your account does not have permission to change time.' }
  }

  const id = stringValue(formData, 'entryID')
  if (id.length === 0 || id.length > 100) return { message: 'The time entry was not found.' }

  const parsed = parseTimeEntry(formData)
  if (!parsed.data) return parsed.state ?? emptyState

  try {
    await limitTimeCommand(session)
    const existing = await findMyTimeEntry(session, id)

    if (!existing) return { message: 'The time entry was not found.' }
    if (existing.billingStatus !== 'unbilled') {
      return { message: 'This entry is locked because it is reserved or exported.' }
    }

    if (
      hasActiveRole(session.user, ['owner', 'admin']) &&
      stringValue(formData, 'privilegedCorrectionReason').trim().length < 10
    ) {
      return validationState({
        privilegedCorrectionReason: 'Enter an audit reason of at least 10 characters.',
      })
    }

    const warning = await overlapWarning(session, parsed.data, formData, id)
    if (warning) return warning

    await session.payload.update({
      collection: 'time-entries',
      id,
      data: parsed.data as never,
      overrideAccess: false,
      req: session.req,
    })
  } catch (error) {
    return stateFromError(error)
  }

  revalidatePath('/app')
  redirect('/app?updated=1')
}

export async function deleteTimeEntryAction(
  _previousState: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const session = await requireAppSession()

  if (!canLogTime(session.user)) {
    return { message: 'Your account does not have permission to delete time.' }
  }

  const id = stringValue(formData, 'entryID')
  if (id.length === 0 || id.length > 100) return { message: 'The time entry was not found.' }

  try {
    await limitTimeCommand(session)
    const existing = await findMyTimeEntry(session, id)

    if (!existing) return { message: 'The time entry was not found.' }
    if (existing.billingStatus !== 'unbilled') {
      return { message: 'Locked time cannot be deleted. An administrator must release it first.' }
    }

    if (hasActiveRole(session.user, ['owner', 'admin'])) {
      await deleteUnbilledTimeEntryAsAdministrator(session, {
        entryID: id,
        reason: stringValue(formData, 'privilegedCorrectionReason'),
      })
    } else {
      await session.payload.delete({
        collection: 'time-entries',
        id,
        overrideAccess: false,
        req: session.req,
      })
    }
  } catch (error) {
    return stateFromError(error)
  }

  revalidatePath('/app')
  redirect('/app?deleted=1')
}
