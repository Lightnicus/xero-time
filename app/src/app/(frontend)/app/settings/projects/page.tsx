import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { formatScaledAmount } from '@/lib/domain/money'
import { requireAppSession } from '@/lib/member-app/session'
import { previewProjectRateRecalculation } from '@/lib/projects/rate-recalculation'

import { recalculateProjectRatesAction } from './actions'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Projects and rates | Project Time' }

type SearchParams = { error?: string; project?: string; updated?: string }

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')
  const params = await searchParams
  const projects = await session.payload.find({
    collection: 'projects',
    depth: 1,
    limit: 500,
    overrideAccess: false,
    pagination: false,
    req: session.req,
    sort: 'code',
  })
  let preview = null
  if (params.project) {
    try {
      preview = await previewProjectRateRecalculation(session, params.project)
    } catch {
      preview = null
    }
  }

  return (
    <div className="wide-page page-stack">
      <div className="breadcrumb">
        <Link href="/app">My time</Link>
        <span aria-hidden="true">/</span>
        <span>Projects and rates</span>
      </div>
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Commercial settings</p>
          <h1>Projects and rates</h1>
          <p>
            Rate changes normally affect new time only. Preview and explicitly recalculate older
            unbilled entries when the new commercial rate must apply retrospectively.
          </p>
        </div>
        <Link className="button button-secondary" href="/admin/collections/projects">
          Edit projects
        </Link>
      </section>

      {params.updated && (
        <div className="notice notice-success" role="status">
          Updated {params.updated} unbilled time {params.updated === '1' ? 'entry' : 'entries'}.
        </div>
      )}
      {params.error && (
        <div className="notice notice-warning" role="alert">
          The project or eligible time changed. Review a fresh recalculation preview.
        </div>
      )}

      <section className="panel page-stack">
        <div>
          <h2>Project rates</h2>
          <p>Reserved and exported entries can never be recalculated.</p>
        </div>
        <div className="table-wrap">
          <table className="time-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Current rate</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.docs.map((project) => (
                <tr key={project.id}>
                  <td>
                    <strong>{project.code}</strong>
                    <small>{project.name}</small>
                  </td>
                  <td>
                    {typeof project.customer === 'object'
                      ? project.customer.name
                      : project.customer}
                  </td>
                  <td>
                    <span className={`status status-${project.status}`}>{project.status}</span>
                  </td>
                  <td>{formatScaledAmount(project.hourlyRateScaled, project.currency)}</td>
                  <td className="table-action">
                    <Link href={`/app/settings/projects?project=${project.id}`}>
                      Preview recalculation
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {preview && (
        <section className="form-section page-stack" id="recalculation-preview">
          <div>
            <p className="eyebrow">Exact preview</p>
            <h2>
              {preview.projectCode} — {preview.projectName}
            </h2>
            <p>
              {preview.affectedCount} unbilled{' '}
              {preview.affectedCount === 1 ? 'entry has' : 'entries have'} a different snapshot
              rate.
            </p>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Current project rate</dt>
              <dd>{formatScaledAmount(preview.currentRateScaled, preview.currency)}</dd>
            </div>
            <div>
              <dt>Affected entries</dt>
              <dd>{preview.affectedCount}</dd>
            </div>
            <div>
              <dt>Value before</dt>
              <dd>{formatScaledAmount(preview.oldValueScaled, preview.currency)}</dd>
            </div>
            <div>
              <dt>Value after</dt>
              <dd>{formatScaledAmount(preview.newValueScaled, preview.currency)}</dd>
            </div>
          </dl>
          {preview.affectedCount > 0 ? (
            <form action={recalculateProjectRatesAction} className="compact-form">
              <input name="expectedHash" type="hidden" value={preview.hash} />
              <input name="projectID" type="hidden" value={preview.projectID} />
              <label className="field">
                <span>Commercial reason</span>
                <textarea maxLength={1_000} minLength={10} name="reason" required rows={3} />
              </label>
              <label className="field">
                <span>Type RECALCULATE</span>
                <input autoComplete="off" name="confirmation" pattern="RECALCULATE" required />
              </label>
              <button className="button button-danger" type="submit">
                Recalculate unbilled snapshots
              </button>
            </form>
          ) : (
            <div className="notice">No unbilled entries need recalculation.</div>
          )}
        </section>
      )}
    </div>
  )
}
