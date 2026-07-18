import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { environment } from '@/lib/env'
import { requireAppSession } from '@/lib/member-app/session'
import { getAccountingConnectionView } from '@/lib/xero/accounting/service'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Operations | Project Time' }

export default async function OperationsPage() {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  const [
    activeUsers,
    unmappedCustomers,
    unbilledEntries,
    queuedExports,
    actionExports,
    pendingWebhooks,
    externalSessions,
    authSettings,
    billingSettings,
    accounting,
    settingsAudits,
  ] = await Promise.all([
    session.payload.count({
      collection: 'users',
      overrideAccess: true,
      req: session.req,
      where: { active: { equals: true } },
    }),
    session.payload.count({
      collection: 'customers',
      overrideAccess: true,
      req: session.req,
      where: { xeroMappingStatus: { not_equals: 'active' } },
    }),
    session.payload.count({
      collection: 'time-entries',
      overrideAccess: true,
      req: session.req,
      where: { billingStatus: { equals: 'unbilled' } },
    }),
    session.payload.count({
      collection: 'invoice-exports',
      overrideAccess: true,
      req: session.req,
      where: { state: { in: ['preparing', 'queued', 'processing', 'retry-wait', 'reconciling'] } },
    }),
    session.payload.count({
      collection: 'invoice-exports',
      overrideAccess: true,
      req: session.req,
      where: { state: { in: ['action-required', 'manual-review'] } },
    }),
    session.payload.count({
      collection: 'xero-webhook-receipts',
      overrideAccess: true,
      req: session.req,
      where: { status: { in: ['pending', 'failed', 'processing'] } },
    }),
    session.payload.count({
      collection: 'external-auth-sessions',
      overrideAccess: true,
      req: session.req,
      where: { revokedAt: { exists: false } },
    }),
    session.payload.findGlobal({
      slug: 'authentication-settings',
      overrideAccess: true,
      req: session.req,
    }),
    session.payload.findGlobal({
      slug: 'billing-settings',
      overrideAccess: true,
      req: session.req,
    }),
    getAccountingConnectionView(session),
    session.payload.find({
      collection: 'audit-events',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      req: session.req,
      sort: '-occurredAt',
      where: {
        eventType: {
          in: [
            'settings.authentication-changed',
            'settings.billing-changed',
            'settings.business-changed',
            'security.kill-switch-changed',
          ],
        },
      },
    }),
  ])

  const actorIDs = [
    ...new Set(
      settingsAudits.docs.flatMap((event) =>
        typeof event.actor === 'string' || typeof event.actor === 'number'
          ? [String(event.actor)]
          : [],
      ),
    ),
  ]
  const actors = actorIDs.length
    ? await session.payload.find({
        collection: 'users',
        depth: 0,
        limit: actorIDs.length,
        overrideAccess: true,
        req: session.req,
        where: { id: { in: actorIDs } },
      })
    : { docs: [] }
  const actorNames = new Map(actors.docs.map((user) => [String(user.id), user.displayName]))

  const cards = [
    ['Active users', activeUsers.totalDocs, '/app/settings/users'],
    ['Unmapped customers', unmappedCustomers.totalDocs, '/app/settings/customers'],
    ['Unbilled entries', unbilledEntries.totalDocs, '/app/billing'],
    ['Queued or active exports', queuedExports.totalDocs, '/app/billing/exports'],
    ['Action required', actionExports.totalDocs, '/app/billing/exports'],
    ['Pending webhook work', pendingWebhooks.totalDocs, '/admin/collections/xero-webhook-receipts'],
  ] as const

  return (
    <div className="wide-page page-stack">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Safe diagnostics</p>
          <h1>Operations</h1>
          <p>
            Counts and health states only. Tokens, OAuth artifacts, and invoice payloads are never
            shown here.
          </p>
        </div>
      </section>

      <section aria-label="Operational counts" className="summary-grid">
        {cards.map(([label, count, href]) => (
          <Link className="summary-card" href={href} key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
            <small>Open details</small>
          </Link>
        ))}
      </section>

      <section className="panel page-stack">
        <div>
          <h2>Independent integration health</h2>
          <p>An outage or kill switch in one boundary does not imply failure in the other.</p>
        </div>
        <dl className="detail-list">
          <div>
            <dt>Xero identity configuration</dt>
            <dd>{environment.xeroIdentity.configured ? 'Configured' : 'Not configured'}</dd>
          </div>
          <div>
            <dt>Xero identity sign-in</dt>
            <dd>{authSettings.xeroIdentityLoginEnabled ? 'Enabled' : 'Disabled'}</dd>
          </div>
          <div>
            <dt>Active external sessions</dt>
            <dd>{externalSessions.totalDocs}</dd>
          </div>
          <div>
            <dt>Xero accounting</dt>
            <dd>{accounting.status.replaceAll('-', ' ')}</dd>
          </div>
          <div>
            <dt>Accepting new exports</dt>
            <dd>{billingSettings.acceptingNewExports ? 'Yes' : 'Paused'}</dd>
          </div>
          <div>
            <dt>Accounting processing</dt>
            <dd>{billingSettings.processingEnabled ? 'Enabled' : 'Paused safely'}</dd>
          </div>
          <div>
            <dt>Last accounting health check</dt>
            <dd>
              {accounting.lastHealthCheckAt
                ? new Date(accounting.lastHealthCheckAt).toLocaleString()
                : 'Not yet'}
            </dd>
          </div>
          <div>
            <dt>Last reference refresh</dt>
            <dd>
              {accounting.lastReferenceDataSyncAt
                ? new Date(accounting.lastReferenceDataSyncAt).toLocaleString()
                : 'Not yet'}
            </dd>
          </div>
        </dl>
        <div className="button-row">
          <Link className="button button-secondary" href="/app/settings/xero">
            Accounting controls
          </Link>
          <Link className="button button-secondary" href="/app/billing/exports">
            Export diagnostics
          </Link>
          <Link className="button button-secondary" href="/admin/collections/audit-events">
            Audit trail
          </Link>
        </div>
      </section>

      <section className="panel page-stack">
        <div>
          <h2>Recent settings changes</h2>
          <p>Security-sensitive changes include the recorded actor and exact audit timestamp.</p>
        </div>
        {settingsAudits.docs.length === 0 ? (
          <p>No settings changes have been recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Setting area</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Changed</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {settingsAudits.docs.map((event) => {
                  const actorID =
                    typeof event.actor === 'string' || typeof event.actor === 'number'
                      ? String(event.actor)
                      : null
                  return (
                    <tr key={event.id}>
                      <td>{event.eventType.replaceAll('.', ' ')}</td>
                      <td>
                        {actorID
                          ? (actorNames.get(actorID) ?? 'Former or unavailable user')
                          : (event.machineActor ?? 'Application')}
                      </td>
                      <td>{new Date(event.occurredAt).toLocaleString()}</td>
                      <td>{event.reason ?? 'No reason required'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
