import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { defaultAppHome } from '@/lib/member-app/navigation'
import { getAppSession } from '@/lib/member-app/session'
import { identityFeatureView } from '@/lib/xero/identity/service'
import config from '@/payload.config'

import { LoginForm } from './LoginForm'
import { XeroIdentityButton } from '../_components/XeroIdentityButton'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sign in | Project Time',
}

const safeNextPath = (value: string | string[] | undefined): string => {
  if (typeof value !== 'string') return '/app'

  const isAppPath = value === '/app' || value.startsWith('/app/') || value.startsWith('/app?')

  return isAppPath && !value.startsWith('//') ? value : '/app'
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; xero?: string | string[] }>
}) {
  const session = await getAppSession()

  if (session) redirect(defaultAppHome(session.user.role))

  const params = await searchParams
  const nextPath = safeNextPath(params.next)
  const identity = await identityFeatureView(await getPayload({ config }))

  return (
    <main className="auth-page">
      <section aria-labelledby="login-heading" className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1 id="login-heading">Welcome back</h1>
        <p className="auth-intro">Sign in to record and review your project time.</p>
        {params.xero && (
          <div className="notice notice-warning" role="alert">
            Xero sign-in could not be completed. You can retry or use email and password.
          </div>
        )}
        <LoginForm nextPath={nextPath} />
        {identity.configured && identity.loginEnabled && (
          <>
            <div className="auth-separator">
              <span>or</span>
            </div>
            <XeroIdentityButton purpose="sign-in" returnPath={nextPath} />
          </>
        )}
      </section>
    </main>
  )
}
