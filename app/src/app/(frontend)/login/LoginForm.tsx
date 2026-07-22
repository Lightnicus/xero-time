'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'

import { loginAction, type LoginActionState } from './actions'

const initialState: LoginActionState = { message: null }

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [state, formAction] = useActionState(loginAction, initialState)

  return (
    <form action={formAction} className="auth-form">
      <input name="next" type="hidden" value={nextPath} />

      <label className="field">
        <span>Email address</span>
        <input
          autoCapitalize="none"
          autoComplete="username"
          autoFocus
          inputMode="email"
          maxLength={320}
          name="email"
          required
          type="email"
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input autoComplete="current-password" name="password" required type="password" />
      </label>

      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>

      <PendingSubmitButton className="button button-primary button-wide" pendingLabel="Signing in…">
        Sign in
      </PendingSubmitButton>
      <Link className="auth-secondary-link" href="/forgot-password">
        Forgot your password?
      </Link>
    </form>
  )
}
