import { notFound, redirect } from 'next/navigation'

import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { TimeEntryForm, type TimeEntryFormValues } from '@/app/(frontend)/_components/TimeEntryForm'
import { formatCalendarDateInTimezone, relationshipID } from '@/lib/domain/validation'
import { findMyTimeEntry, listActiveProjectOptions } from '@/lib/member-app/data'
import { instantToLocalDateTime, timezoneOptionsIncluding } from '@/lib/member-app/date-time'
import { canLogTime, requireAppSession } from '@/lib/member-app/session'

import '../../../time-workflow.css'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Add time | Project Time',
}

export default async function NewTimeEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ duplicate?: string | string[] }>
}) {
  const session = await requireAppSession()

  if (!canLogTime(session.user)) redirect('/app')

  const params = await searchParams
  const duplicateID =
    typeof params.duplicate === 'string' && params.duplicate.length <= 100 ? params.duplicate : ''
  const [projects, source] = await Promise.all([
    listActiveProjectOptions(session),
    duplicateID ? findMyTimeEntry(session, duplicateID) : Promise.resolve(null),
  ])

  if (duplicateID && (!source || source.billingStatus !== 'unbilled')) notFound()

  const workDate = formatCalendarDateInTimezone(new Date(), session.user.timezone)
  const firstProject = projects[0]
  const sourceProjectID = source ? relationshipID(source.project) : null
  const sourceProjectAvailable =
    sourceProjectID !== null &&
    projects.some((project) => String(project.id) === String(sourceProjectID))
  const fallbackHours = source ? Math.floor(source.durationSeconds / 3_600) : 1
  const fallbackMinutes = source ? Math.floor((source.durationSeconds % 3_600) / 60) : 0
  const initialValues: TimeEntryFormValues = source
    ? {
        billable: source.billable !== false,
        description: source.description,
        endLocal: source.endAt ? (instantToLocalDateTime(source.endAt, source.timezone) ?? '') : '',
        enteredHours: source.enteredHours ?? fallbackHours,
        enteredMinutes: source.enteredMinutes ?? fallbackMinutes,
        inputMode: source.inputMode,
        project: sourceProjectAvailable ? String(sourceProjectID) : '',
        startLocal: source.startAt
          ? (instantToLocalDateTime(source.startAt, source.timezone) ?? '')
          : '',
        timezone: source.timezone,
        workDate: source.workDate,
      }
    : {
        billable: firstProject?.billableByDefault !== false,
        description: '',
        endLocal: `${workDate}T10:00`,
        enteredHours: 1,
        enteredMinutes: 0,
        inputMode: 'duration',
        project: firstProject?.id ?? '',
        startLocal: `${workDate}T09:00`,
        timezone: session.user.timezone,
        workDate,
      }
  const duplicate = Boolean(source)

  return (
    <div className="narrow-page page-stack time-form-page">
      <PageHeader
        breadcrumb={{
          current: duplicate ? 'Duplicate time' : 'Add time',
          href: '/app',
          label: 'My time',
        }}
        description={
          duplicate
            ? 'Review the copied work before adding it as a separate entry.'
            : 'Record completed work with a duration or exact start and finish.'
        }
        title={duplicate ? 'Duplicate time' : 'Add time'}
      />

      {duplicate && !sourceProjectAvailable && (
        <div className="notice notice-warning">
          The original project is no longer available. Choose an active project before saving the
          copy.
        </div>
      )}

      <TimeEntryForm
        initialValues={initialValues}
        mode="create"
        projects={projects}
        timezones={timezoneOptionsIncluding(initialValues.timezone, session.user.timezone)}
      />
    </div>
  )
}
