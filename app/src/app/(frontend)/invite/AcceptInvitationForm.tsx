'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { MIN_PASSWORD_LENGTH } from '@/lib/account-lifecycle/password-policy'

import { acceptInvitationAction, type AcceptInvitationState } from './actions'

const initialState: AcceptInvitationState = { message: null }

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button className="button button-primary button-wide" disabled={pending} type="submit">
      {pending ? 'Creating account…' : 'Create account'}
    </button>
  )
}

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInvitationAction, initialState)
  return (
    <form action={action} className="auth-form">
      <input name="token" type="hidden" value={token} />
      <label className="field">
        <span>Choose password</span>
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
        <span>Confirm password</span>
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
