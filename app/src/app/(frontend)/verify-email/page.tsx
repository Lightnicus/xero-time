import Link from 'next/link'

import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'

import { verifyEmailAction } from './actions'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: 'Verify email | Project Time',
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; token?: string | string[] }>
}) {
  const params = await searchParams
  const token = typeof params.token === 'string' ? params.token : ''
  const validShape = token.length > 0 && token.length <= 1_000

  return (
    <main className="auth-page">
      <section aria-labelledby="verify-heading" className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1 id="verify-heading">Verify email</h1>
        {validShape && params.status !== 'invalid' ? (
          <form action={verifyEmailAction} className="auth-form">
            <input name="token" type="hidden" value={token} />
            <p className="auth-intro">Confirm this email address before signing in.</p>
            <PendingSubmitButton
              className="button button-primary button-wide"
              pendingLabel="Verifying…"
            >
              Verify email address
            </PendingSubmitButton>
          </form>
        ) : (
          <div className="page-stack">
            <div className="notice notice-warning" role="alert">
              This verification link is invalid or expired.
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
