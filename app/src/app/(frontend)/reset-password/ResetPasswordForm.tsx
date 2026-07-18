'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { MIN_PASSWORD_LENGTH } from '@/lib/account-lifecycle/password-policy'

import { resetPasswordAction, type ResetPasswordState } from './actions'

const initialState: ResetPasswordState = { message: null }

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button className="button button-primary button-wide" disabled={pending} type="submit">
      {pending ? 'Resetting…' : 'Set new password'}
    </button>
  )
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, initialState)
  return (
    <form action={action} className="auth-form">
      <input name="token" type="hidden" value={token} />
      <label className="field">
        <span>New password</span>
        <input
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          name="password"
          required
          type="password"
        />
        <small>Use at least {MIN_PASSWORD_LENGTH} characters.</small>
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          name="passwordConfirmation"
          required
          type="password"
        />
      </label>
      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>
      <SubmitButton />
    </form>
  )
}
