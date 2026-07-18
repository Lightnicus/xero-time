'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  changePasswordAction,
  type PasswordActionState,
} from '@/app/(frontend)/app/profile/actions'
import { MIN_PASSWORD_LENGTH } from '@/lib/account-lifecycle/password-policy'

const initialState: PasswordActionState = { message: null }

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button className="button button-primary" disabled={pending} type="submit">
      {pending ? 'Changing…' : 'Change password'}
    </button>
  )
}

export function PasswordChangeForm() {
  const [state, action] = useActionState(changePasswordAction, initialState)
  return (
    <form action={action} className="form-section password-change-form">
      <div>
        <h2>Change password</h2>
        <p>Changing your password signs out every other browser session.</p>
      </div>
      <div className="form-grid">
        <label className="field field-full">
          <span>Current password</span>
          <input autoComplete="current-password" name="currentPassword" required type="password" />
        </label>
        <label className="field">
          <span>New password</span>
          <input
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            name="newPassword"
            required
            type="password"
          />
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
      </div>
      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>
      <div className="form-actions">
        <SubmitButton />
      </div>
    </form>
  )
}
