import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { requireAppSession } from '@/lib/member-app/session'

import '../../settings-workflow.css'
import { SettingsNavigation } from './SettingsNavigation'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  return (
    <div className="settings-workspace">
      <SettingsNavigation />
      <div className="settings-content">{children}</div>
    </div>
  )
}
