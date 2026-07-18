import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getAppSession } from '@/lib/member-app/session'

import { ResetPasswordForm } from './ResetPasswordForm'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: 'Choose new password | Project Time',
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  if (await getAppSession()) redirect('/app/profile')
  const suppliedToken = (await searchParams).token
  const token = typeof suppliedToken === 'string' ? suppliedToken : ''
  const tokenShapeValid = /^[a-f0-9]{40}$/i.test(token)

  return (
    <main className="auth-page">
      <section aria-labelledby="reset-heading" className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1 id="reset-heading">Choose a new password</h1>
        {tokenShapeValid ? (
          <ResetPasswordForm token={token} />
        ) : (
          <div className="page-stack">
            <div className="notice notice-warning" role="alert">
              This password reset link is invalid or expired.
            </div>
            <Link className="button button-secondary button-wide" href="/forgot-password">
              Request another link
            </Link>
          </div>
        )}
      </section>
    </main>
  )
}
