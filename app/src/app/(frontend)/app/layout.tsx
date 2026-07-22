import Link from 'next/link'

import { AppNavigation } from '@/app/(frontend)/_components/AppNavigation'
import { getBusinessSettings } from '@/lib/member-app/data'
import { navigationForRole } from '@/lib/member-app/navigation'
import { requireAppSession } from '@/lib/member-app/session'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAppSession()
  const settings = await getBusinessSettings(session)
  const navigation = navigationForRole(session.user.role)

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <Link className="app-brand" href={navigation.homeHref}>
            <span className="app-brand-mark" aria-hidden="true">
              PT
            </span>
            <span>
              <strong>{settings.businessName}</strong>
              <small>Project time</small>
            </span>
          </Link>

          <AppNavigation
            displayName={session.user.displayName}
            navigation={navigation}
            roleLabel={session.user.role}
          />
        </div>
      </header>

      <main className="app-main">{children}</main>

      {settings.supportEmail && (
        <footer className="app-footer">
          <a href={`mailto:${settings.supportEmail}`}>Help and support · {settings.supportEmail}</a>
        </footer>
      )}
    </div>
  )
}
