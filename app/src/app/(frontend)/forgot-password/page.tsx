import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getAppSession } from '@/lib/member-app/session'

import { ForgotPasswordForm } from './ForgotPasswordForm'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: 'Reset password | Project Time',
}

export default async function ForgotPasswordPage() {
  if (await getAppSession()) redirect('/app/profile')

  return (
    <main className="auth-page">
      <section aria-labelledby="forgot-heading" className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1 id="forgot-heading">Reset your password</h1>
        <p className="auth-intro">
          Enter your account email. The response is the same whether or not an account exists.
        </p>
        <ForgotPasswordForm />
        <Link className="auth-secondary-link" href="/login">
          Return to sign in
        </Link>
      </section>
    </main>
  )
}
