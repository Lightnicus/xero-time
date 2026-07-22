import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { getInvitationPreview } from '@/lib/account-lifecycle/service'
import { defaultAppHome } from '@/lib/member-app/navigation'
import { getAppSession } from '@/lib/member-app/session'
import { identityFeatureView } from '@/lib/xero/identity/service'
import config from '@/payload.config'

import { AcceptInvitationForm } from './AcceptInvitationForm'
import { XeroIdentityButton } from '../_components/XeroIdentityButton'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: 'Set up account | Project Time',
}

export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; xero?: string | string[] }>
}) {
  const session = await getAppSession()
  if (session) redirect(defaultAppHome(session.user.role))
  const params = await searchParams
  const suppliedToken = params.token
  const token = typeof suppliedToken === 'string' ? suppliedToken : ''
  const payload = await getPayload({ config })
  const [preview, identity] = await Promise.all([
    getInvitationPreview(payload, token),
    identityFeatureView(payload),
  ])

  return (
    <main className="auth-page">
      <section aria-labelledby="invite-heading" className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1 id="invite-heading">Set up your account</h1>
        {preview ? (
          <>
            <p className="auth-intro">
              Welcome, {preview.displayName}. This invitation creates the {preview.role} account for{' '}
              {preview.email}.
            </p>
            {params.xero && (
              <div className="notice notice-warning" role="alert">
                Xero setup could not be completed. Retry or choose a password below.
              </div>
            )}
            <AcceptInvitationForm token={token} />
            {identity.configured && identity.loginEnabled && identity.inviteAcceptanceEnabled && (
              <>
                <div className="auth-separator">
                  <span>or</span>
                </div>
                <XeroIdentityButton
                  invitationToken={token}
                  purpose="invite-acceptance"
                  returnPath="/app"
                />
              </>
            )}
          </>
        ) : (
          <div className="page-stack">
            <div className="notice notice-warning" role="alert">
              This invitation is invalid, expired, revoked, or already used.
            </div>
            <Link className="button button-secondary button-wide" href="/login">
              Return to sign in
            </Link>
          </div>
        )}
      </section>
    </main>
  )
}
