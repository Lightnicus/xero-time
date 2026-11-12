import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { PasswordChangeForm } from '@/app/(frontend)/_components/PasswordChangeForm'
import { ProfileForm } from '@/app/(frontend)/_components/ProfileForm'
import { timezoneOptionsIncluding } from '@/lib/member-app/date-time'
import { requireAppSession } from '@/lib/member-app/session'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Profile | Project Time',
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{
    password?: string | string[]
    saved?: string | string[]
  }>
}) {
  const session = await requireAppSession()
  const params = await searchParams
  const saved = params.saved === '1'

  return (
    <div className="narrow-page page-stack account-workflow-page">
      <PageHeader
        breadcrumb={{
          current: 'Profile',
          href: '/app',
          label: 'My time',
        }}
        description="Your name, default timezone, and password."
        title="Profile"
      />

      {saved && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Profile saved.
        </div>
      )}
      {params.password === 'changed' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Password changed. Other browser sessions were revoked.
        </div>
      )}
      {params.password === 'reset' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Password reset complete. Other browser sessions were revoked.
        </div>
      )}
      <section aria-label="Account access" className="panel account-summary">
        <dl className="detail-list">
          <div>
            <dt>Email</dt>
            <dd>{session.user.email}</dd>
          </div>
        </dl>
      </section>

      <ProfileForm
        initialDisplayName={session.user.displayName}
        initialTimezone={session.user.timezone}
        timezones={timezoneOptionsIncluding(session.user.timezone)}
      />

      <section aria-labelledby="account-security-heading" className="account-security-stack">
        <div className="account-section-heading">
          <h2 id="account-security-heading">Password</h2>
        </div>
        <PasswordChangeForm />
      </section>
    </div>
  )
}
