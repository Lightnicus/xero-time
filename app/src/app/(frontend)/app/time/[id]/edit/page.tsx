import Link from 'next/link'
import { notFound } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { DeleteTimeEntryButton } from '@/app/(frontend)/_components/DeleteTimeEntryButton'
import { TimeEntryForm, type TimeEntryFormValues } from '@/app/(frontend)/_components/TimeEntryForm'
import { relationshipID } from '@/lib/domain/validation'
import { findMyTimeEntry, listActiveProjectOptions } from '@/lib/member-app/data'
import { instantToLocalDateTime, timezoneOptionsIncluding } from '@/lib/member-app/date-time'
import { canLogTime, requireAppSession } from '@/lib/member-app/session'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Time entry | Project Time',
}

const formatDuration = (seconds: number): string => {
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours > 0 ? `${hours}h ` : ''}${minutes > 0 ? `${minutes}m` : ''}`.trim()
}

export default async function EditTimeEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAppSession()
  const { id } = await params
  const entry = await findMyTimeEntry(session, id)

  if (!entry) notFound()

  const editable = canLogTime(session.user) && entry.billingStatus === 'unbilled'
  const privileged = hasActiveRole(session.user, ['owner', 'admin'])

  if (!editable) {
    return (
      <div className="narrow-page page-stack">
        <div className="breadcrumb">
          <Link href="/app">My time</Link>
          <span aria-hidden="true">/</span>
          <span>View time</span>
        </div>

        <section className="page-heading compact">
          <div>
            <p className="eyebrow">Read only</p>
            <h1>Time entry</h1>
            <p>This entry cannot be changed from the member application.</p>
          </div>
        </section>

        <div className="notice notice-warning">
          {entry.billingStatus === 'unbilled'
            ? 'Your current role cannot edit time.'
            : `This entry is ${entry.billingStatus} and locked. An administrator can release it for rebilling.`}
        </div>

        <section className="panel detail-panel">
          <dl className="detail-list">
            <div>
              <dt>Date</dt>
              <dd>{entry.workDate}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                {entry.projectCodeSnapshot} — {entry.projectNameSnapshot}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(entry.durationSeconds)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`status status-${entry.billingStatus}`}>
                  {entry.billingStatus}
                </span>
              </dd>
            </div>
            <div className="detail-wide">
              <dt>Description</dt>
              <dd>{entry.description}</dd>
            </div>
            <div>
              <dt>Billing</dt>
              <dd>{entry.billable ? 'Billable' : 'Non-billable'}</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>{entry.timezone.replaceAll('_', ' ')}</dd>
            </div>
          </dl>
        </section>

        <div className="form-actions">
          <Link className="button button-secondary" href="/app">
            Back to my time
          </Link>
          {entry.currentExport && hasActiveRole(session.user, ['owner', 'admin', 'biller']) && (
            <Link
              className="button button-secondary"
              href={`/app/billing/exports/${relationshipID(entry.currentExport)}`}
            >
              Open export
            </Link>
          )}
        </div>
      </div>
    )
  }

  const projects = await listActiveProjectOptions(session)
  const currentProjectID = relationshipID(entry.project)

  if (currentProjectID !== null && !projects.some((project) => project.id === currentProjectID)) {
    projects.unshift({
      billableByDefault: entry.billable,
      code: entry.projectCodeSnapshot,
      id: String(currentProjectID),
      name: `${entry.projectNameSnapshot} (current)`,
    })
  }

  const fallbackHours = Math.floor(entry.durationSeconds / 3_600)
  const fallbackMinutes = Math.floor((entry.durationSeconds % 3_600) / 60)
  const initialValues: TimeEntryFormValues = {
    billable: entry.billable !== false,
    description: entry.description,
    endLocal: entry.endAt ? (instantToLocalDateTime(entry.endAt, entry.timezone) ?? '') : '',
    enteredHours: entry.enteredHours ?? fallbackHours,
    enteredMinutes: entry.enteredMinutes ?? fallbackMinutes,
    inputMode: entry.inputMode,
    project: currentProjectID === null ? '' : String(currentProjectID),
    startLocal: entry.startAt ? (instantToLocalDateTime(entry.startAt, entry.timezone) ?? '') : '',
    timezone: entry.timezone,
    workDate: entry.workDate,
  }

  return (
    <div className="narrow-page page-stack">
      <div className="breadcrumb">
        <Link href="/app">My time</Link>
        <span aria-hidden="true">/</span>
        <span>Edit time</span>
      </div>

      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Unbilled entry</p>
          <h1>Edit time</h1>
          <p>Changes update this entry while preserving the project billing snapshot rules.</p>
        </div>
        <Link className="button button-secondary" href={`/app/time/new?duplicate=${entry.id}`}>
          Duplicate entry
        </Link>
      </section>

      <TimeEntryForm
        entryID={entry.id}
        initialValues={initialValues}
        mode="edit"
        projects={projects}
        requiresCorrectionReason={privileged}
        timezones={timezoneOptionsIncluding(entry.timezone, session.user.timezone)}
      />

      <section className="danger-zone">
        <div>
          <h2>Delete entry</h2>
          <p>Only unbilled time can be deleted. This action cannot be undone.</p>
        </div>
        <DeleteTimeEntryButton entryID={entry.id} requiresReason={privileged} />
      </section>
    </div>
  )
}
