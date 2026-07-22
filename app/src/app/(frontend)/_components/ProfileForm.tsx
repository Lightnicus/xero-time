'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  type ProfileActionState,
  type ProfileField,
  updateProfileAction,
} from '../app/profile/actions'

type TimezoneOption = {
  label: string
  value: string
}

type ProfileFormProps = {
  initialDisplayName: string
  initialTimezone: string
  timezones: TimezoneOption[]
}

const initialState: ProfileActionState = { message: null }

function FieldError({ field, state }: { field: ProfileField; state: ProfileActionState }) {
  const message = state.fieldErrors?.[field]
  return message ? <small className="field-error">{message}</small> : null
}

function SaveButton() {
  const { pending } = useFormStatus()

  return (
    <button className="button button-primary" disabled={pending} type="submit">
      {pending ? 'Saving…' : 'Save profile'}
    </button>
  )
}

export function ProfileForm({ initialDisplayName, initialTimezone, timezones }: ProfileFormProps) {
  const [state, formAction] = useActionState(updateProfileAction, initialState)
  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [timezone, setTimezone] = useState(initialTimezone)

  return (
    <form
      action={formAction}
      aria-labelledby="profile-details-heading"
      className="form-section profile-details-form"
    >
      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>

      <div className="account-section-heading">
        <h2 id="profile-details-heading">Profile</h2>
        <p>Choose your display name and the timezone used for new entries and date views.</p>
      </div>

      <div className="form-grid">
        <label className="field field-full" htmlFor="displayName">
          <span>Display name</span>
          <input
            aria-invalid={Boolean(state.fieldErrors?.displayName)}
            autoComplete="name"
            id="displayName"
            maxLength={120}
            name="displayName"
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
          <FieldError field="displayName" state={state} />
        </label>

        <label className="field field-full" htmlFor="profileTimezone">
          <span>Timezone</span>
          <input
            aria-invalid={Boolean(state.fieldErrors?.timezone)}
            autoComplete="off"
            id="profileTimezone"
            list="profile-timezone-options"
            name="timezone"
            onChange={(event) => setTimezone(event.target.value)}
            placeholder="Search IANA timezones"
            required
            value={timezone}
          />
          <datalist id="profile-timezone-options">
            {timezones.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </datalist>
          <small>Use an IANA name such as Pacific/Auckland or Australia/Sydney.</small>
          <FieldError field="timezone" state={state} />
        </label>
      </div>

      <div className="form-actions">
        <SaveButton />
      </div>
    </form>
  )
}
