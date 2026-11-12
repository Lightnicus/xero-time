import { redirect } from 'next/navigation'

import { getAppSession } from '@/lib/member-app/session'

import { LoginForm } from './LoginForm'

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
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const session = await getAppSession()

  if (session) redirect('/app')

  const params = await searchParams
  const nextPath = safeNextPath(params.next)

  return (
    <main className="auth-page">
      <section aria-labelledby="login-heading" className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          PT
        </div>
        <p className="eyebrow">Project Time</p>
        <h1 id="login-heading">Welcome back</h1>
        <p className="auth-intro">Sign in to record and review your project time.</p>
        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  )
}
