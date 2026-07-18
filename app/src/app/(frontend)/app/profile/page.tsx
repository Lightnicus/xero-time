import { cookies } from 'next/headers'
import Link from 'next/link'
import { getPayload } from 'payload'

import { IdentitySecurityPanel } from '@/app/(frontend)/_components/IdentitySecurityPanel'
import { PasswordChangeForm } from '@/app/(frontend)/_components/PasswordChangeForm'
import { ProfileForm } from '@/app/(frontend)/_components/ProfileForm'
import { timezoneOptionsIncluding } from '@/lib/member-app/date-time'
import { requireAppSession } from '@/lib/member-app/session'
import {
  EXTERNAL_SESSION_COOKIE,
  getIdentitySecurityView,
  identityFeatureView,
} from '@/lib/xero/identity/service'
import config from '@/payload.config'

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
    security?: string | string[]
    xero?: string | string[]
  }>
}) {
  const session = await requireAppSession()
  const params = await searchParams
  const saved = params.saved === '1'
  const rawExternalToken = (await cookies()).get(EXTERNAL_SESSION_COOKIE)?.value
  const [security, identityFeatures] = await Promise.all([
    getIdentitySecurityView(session, rawExternalToken),
    identityFeatureView(await getPayload({ config })),
  ])

  return (
    <div className="narrow-page page-stack">
      <div className="breadcrumb">
        <Link href="/app">My time</Link>
        <span aria-hidden="true">/</span>
        <span>Profile</span>
      </div>

      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>Profile</h1>
          <p>Choose how your name appears and which timezone the application uses by default.</p>
        </div>
      </section>

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
      {params.xero === 'linked' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero identity linked. The business accounting connection was not changed.
        </div>
      )}
      {params.xero && params.xero !== 'linked' && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          Xero identity could not be linked. Your existing login methods are unchanged.
        </div>
      )}
      {params.security === 'identity-unlinked' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero identity unlinked and its local sessions revoked.
        </div>
      )}
      {params.security && params.security !== 'identity-unlinked' && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          The security change could not be completed.
        </div>
      )}

      <section aria-label="Account access" className="panel account-summary">
        <dl className="detail-list">
          <div>
            <dt>Email</dt>
            <dd>{session.user.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd className="text-capitalize">{session.user.role}</dd>
          </div>
        </dl>
        <p>Email addresses and roles are managed by an administrator.</p>
      </section>

      <ProfileForm
        initialDisplayName={session.user.displayName}
        initialTimezone={session.user.timezone}
        timezones={timezoneOptionsIncluding(session.user.timezone)}
      />
      <PasswordChangeForm />
      <IdentitySecurityPanel
        canLink={identityFeatures.loginEnabled && identityFeatures.linkingEnabled}
        configured={identityFeatures.configured}
        security={security}
      />
    </div>
  )
}
