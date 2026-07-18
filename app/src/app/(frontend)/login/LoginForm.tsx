'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { loginAction, type LoginActionState } from './actions'

const initialState: LoginActionState = { message: null }

function LoginSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button className="button button-primary button-wide" disabled={pending} type="submit">
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

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

      <LoginSubmitButton />
      <Link className="auth-secondary-link" href="/forgot-password">
        Forgot your password?
      </Link>
    </form>
  )
}
