import Link from 'next/link'

import type { XeroConnectionAlert } from '@/lib/xero/accounting/connection-alert'

const waitingText = (count: number): string =>
  count === 0
    ? 'New invoice exports are on hold until it is reconnected.'
    : `${count} invoice ${count === 1 ? 'export is' : 'exports are'} paused and will resume automatically once it is reconnected.`

export function XeroConnectionBanner({ alert }: { alert: XeroConnectionAlert }) {
  const organisation = alert.tenantName ? `Xero (${alert.tenantName})` : 'Xero'
  return (
    <div className="app-alert" role="alert">
      <div className="app-alert-inner notice notice-warning">
        <p>
          <strong>{organisation} needs to be reconnected.</strong>{' '}
          {waitingText(alert.waitingExports)}
        </p>
        {alert.canReconnect ? (
          <Link className="button button-secondary" href="/app/settings/xero">
            Reconnect Xero
          </Link>
        ) : (
          <p>Ask an owner or admin to reconnect Xero in Settings.</p>
        )}
      </div>
    </div>
  )
}
