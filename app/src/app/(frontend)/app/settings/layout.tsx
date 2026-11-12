import { requireAppSession } from '@/lib/member-app/session'

import '../../settings-workflow.css'
import { SettingsNavigation } from './SettingsNavigation'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAppSession()

  return (
    <div className="settings-workspace">
      <SettingsNavigation />
      <div className="settings-content">{children}</div>
    </div>
  )
}
