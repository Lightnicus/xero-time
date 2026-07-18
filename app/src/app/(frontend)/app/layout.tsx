import Link from 'next/link'

import { LogoutButton } from '@/app/(frontend)/_components/LogoutButton'
import { getBusinessSettings } from '@/lib/member-app/data'
import { canLogTime, requireAppSession } from '@/lib/member-app/session'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAppSession()
  const settings = await getBusinessSettings(session)
  const showAdmin = session.user.role === 'owner' || session.user.role === 'admin'
  const showBilling = showAdmin || session.user.role === 'biller'
  const showNewTime = canLogTime(session.user)

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <Link className="app-brand" href="/app">
            <span className="app-brand-mark" aria-hidden="true">
              PT
            </span>
            <span>
              <strong>{settings.businessName}</strong>
              <small>Project time</small>
            </span>
          </Link>

          <nav aria-label="Primary" className="app-nav">
            <Link href="/app">My time</Link>
            {showNewTime && <Link href="/app/time/new">Add time</Link>}
            <Link href="/app/profile">Profile</Link>
            {showBilling && <Link href="/app/billing">Billing</Link>}
            {showAdmin && <Link href="/app/settings/users">People</Link>}
            {showAdmin && <Link href="/app/settings/customers">Customers</Link>}
            {showAdmin && <Link href="/app/settings/projects">Projects</Link>}
            {showAdmin && <Link href="/app/settings/xero">Xero</Link>}
            {showAdmin && <Link href="/app/operations">Operations</Link>}
            {showAdmin && <Link href="/admin">Admin</Link>}
          </nav>

          <div className="account-menu">
            <span className="account-copy">
              <strong>{session.user.displayName}</strong>
              <small>{session.user.role}</small>
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="app-main">{children}</main>

      <footer className="app-footer">
        <span>{settings.businessName}</span>
        {settings.supportEmail && (
          <a href={`mailto:${settings.supportEmail}`}>Need help? {settings.supportEmail}</a>
        )}
      </footer>
    </div>
  )
}
