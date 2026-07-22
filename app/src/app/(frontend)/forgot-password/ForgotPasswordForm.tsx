'use client'

import { useActionState } from 'react'

import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'

import { forgotPasswordAction, type ForgotPasswordState } from './actions'

const initialState: ForgotPasswordState = { message: null }

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
      <PendingSubmitButton className="button button-primary button-wide" pendingLabel="Requesting…">
        Send reset instructions
      </PendingSubmitButton>
    </form>
  )
}
