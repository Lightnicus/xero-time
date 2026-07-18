'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { forgotPasswordAction, type ForgotPasswordState } from './actions'

const initialState: ForgotPasswordState = { message: null }

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button className="button button-primary button-wide" disabled={pending} type="submit">
      {pending ? 'Requesting…' : 'Send reset instructions'}
    </button>
  )
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, initialState)
  return (
    <form action={action} className="auth-form">
      <label className="field">
        <span>Email address</span>
        <input
          autoCapitalize="none"
          autoComplete="email"
          autoFocus
          inputMode="email"
          maxLength={320}
          name="email"
          required
          type="email"
        />
      </label>
      <div
        aria-live="polite"
        className={state.success ? 'form-message form-message-success' : 'form-message'}
        role="status"
      >
        {state.message}
      </div>
      <SubmitButton />
    </form>
  )
}
