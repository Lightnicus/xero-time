import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { formatScaledAmount } from '@/lib/domain/money'
import { requireAppSession } from '@/lib/member-app/session'
import { previewProjectRateRecalculation } from '@/lib/projects/rate-recalculation'
import { buildProjectXeroItemOptions } from '@/lib/projects/xero-items'

import { recalculateProjectRatesAction } from './actions'
import { ProjectXeroItemForm } from './ProjectXeroItemForm'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Projects, rates and Xero items | Project Time' }

type SearchParams = {
  error?: string
  item?: string
  itemProject?: string
  project?: string
  updated?: string
}

type ProjectItemFields = {
  xeroItemCodeSnapshot?: null | string
  xeroItemId?: null | string
  xeroItemNameSnapshot?: null | string
}

const projectItemFields = (project: unknown): ProjectItemFields => project as ProjectItemFields

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')
  const params = await searchParams
  const [projects, connections] = await Promise.all([
    session.payload.find({
      collection: 'projects',
      depth: 1,
      overrideAccess: false,
      pagination: false,
      req: session.req,
      sort: 'code',
    }),
    session.payload.find({
      collection: 'xero-connections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req: session.req,
      where: {
        and: [
          { singletonKey: { equals: 'business-accounting' } },
          { status: { equals: 'connected' } },
        ],
      },
    }),
  ])
  const connection = connections.docs[0]
  const tenantID = connection?.tenantId
  const itemReferences = tenantID
    ? await session.payload.find({
        collection: 'xero-reference-data',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        req: session.req,
        sort: ['code', 'name'],
        where: {
          and: [
            { sourceTenantId: { equals: tenantID } },
            { resourceType: { equals: 'item' } },
            { status: { equals: 'active' } },
          ],
        } as never,
      })
    : null
  const itemOptions = buildProjectXeroItemOptions(itemReferences?.docs ?? [])
  const referencesLoaded = Boolean(
    connection?.lastReferenceDataSyncAt || (itemReferences?.docs.length ?? 0) > 0,
  )
  const lastReferenceRefresh = connection?.lastReferenceDataSyncAt
    ? new Intl.DateTimeFormat('en-NZ', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: session.user.timezone,
      }).format(new Date(connection.lastReferenceDataSyncAt))
    : null
  const itemProject =
    typeof params.itemProject === 'string'
      ? projects.docs.find((project) => String(project.id) === params.itemProject)
      : null
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
        <span>Projects, rates and Xero items</span>
      </div>
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Commercial settings</p>
          <h1>Projects, rates and Xero items</h1>
          <p>
            Map each project to its Xero sales item, and manage the rates applied to time and
            invoice previews.
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

      {params.item === 'saved' && (
        <div className="notice notice-success" role="status">
          Xero invoice item saved
          {itemProject ? ` for ${itemProject.code} — ${itemProject.name}` : ''}.
        </div>
      )}

      <section className="panel page-stack" id="xero-items">
        <div>
          <h2>Xero invoice items</h2>
          <p>
            The selected sales item fills Xero’s Item column on future invoice lines for that
            project. Existing reserved and exported invoice snapshots never change.
          </p>
          <p className="muted-copy">
            Tracked inventory items are labelled; Xero may reject them when the invoiced quantity
            exceeds available stock.
          </p>
          {connection && (
            <p className="muted-copy">
              Catalogue: {connection.tenantName ?? 'connected Xero organisation'} · Last refreshed{' '}
              {lastReferenceRefresh ?? 'never'}
            </p>
          )}
        </div>

        {!connection && (
          <div className="notice notice-warning" role="alert">
            Connect a Xero organisation before selecting project invoice items.{' '}
            <Link href="/app/settings/xero">Open Xero settings</Link>.
          </div>
        )}
        {connection && !referencesLoaded && (
          <div className="notice notice-warning" role="alert">
            Xero item data has not been loaded yet.{' '}
            <Link href="/app/settings/xero#reference-data">Refresh Xero reference data</Link> before
            assigning project items.
          </div>
        )}
        {connection && referencesLoaded && itemOptions.length === 0 && (
          <div className="notice notice-warning" role="alert">
            No active Xero sales items are available.{' '}
            <Link href="/app/settings/xero#reference-data">Refresh Xero reference data</Link>, then
            check that the item is enabled for sales in Xero.
          </div>
        )}

        <div className="mapping-list">
          {projects.docs.map((project) => {
            const mapping = projectItemFields(project)
            return (
              <article className="mapping-row" id={`project-item-${project.id}`} key={project.id}>
                <div>
                  <strong>{project.code}</strong>
                  <p>{project.name}</p>
                  <small>
                    {typeof project.customer === 'object'
                      ? project.customer.name
                      : project.customer}
                  </small>
                </div>
                <ProjectXeroItemForm
                  configuredCode={mapping.xeroItemCodeSnapshot ?? null}
                  configuredID={mapping.xeroItemId ?? null}
                  configuredName={mapping.xeroItemNameSnapshot ?? null}
                  connected={Boolean(connection)}
                  options={itemOptions}
                  projectID={String(project.id)}
                  referencesLoaded={referencesLoaded}
                />
              </article>
            )
          })}
        </div>
      </section>

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
