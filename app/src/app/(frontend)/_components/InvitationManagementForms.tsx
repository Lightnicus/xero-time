'use client'

import { useActionState, useState } from 'react'

import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'
import type { InvitationActionState } from '@/app/(frontend)/app/settings/users/actions'
import {
  createInvitationAction,
  resendInvitationAction,
  revokeInvitationAction,
} from '@/app/(frontend)/app/settings/users/actions'
import type { InvitationManagementItem, InviteRole } from '@/lib/account-lifecycle/service'

type TimezoneOption = { label: string; value: string }

const initialState: InvitationActionState = { message: null }

function Result({ state }: { state: InvitationActionState }) {
  if (!state.message) return null
  return (
    <div
      aria-live="polite"
      className={state.success ? 'notice notice-success' : 'notice notice-warning'}
      role="status"
    >
      <p>{state.message}</p>
      {state.setupURL && (
        <p>
          Development setup link: <a href={state.setupURL}>open invitation</a>. Treat this link as a
          password until it is used or revoked.
        </p>
      )}
    </div>
  )
}

export function InvitationCreateForm({
  defaultTimezone,
  roles,
  timezones,
}: {
  defaultTimezone: string
  roles: Array<{ label: string; value: InviteRole }>
  timezones: TimezoneOption[]
}) {
  const [state, formAction] = useActionState(createInvitationAction, initialState)
  const [timezone, setTimezone] = useState(defaultTimezone)

  return (
    <form action={formAction} className="form-section invitation-create-form">
      <div>
        <h2>Invite a user</h2>
        <p>The role is assigned locally and cannot be changed by the invitation recipient.</p>
      </div>

      <Result state={state} />

      <div className="form-grid">
        <label className="field" htmlFor="invitationDisplayName">
          <span>Display name</span>
          <input id="invitationDisplayName" maxLength={120} name="displayName" required />
        </label>
        <label className="field" htmlFor="invitationEmail">
          <span>Email address</span>
          <input
            autoCapitalize="none"
            autoComplete="off"
            id="invitationEmail"
            maxLength={320}
            name="email"
            required
            type="email"
          />
        </label>
        <label className="field" htmlFor="invitationRole">
          <span>Role</span>
          <select id="invitationRole" name="role" required>
            {roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="invitationTimezone">
          <span>Timezone</span>
          <input
            id="invitationTimezone"
            list="invitation-timezone-options"
            name="timezone"
            onChange={(event) => setTimezone(event.target.value)}
            required
            value={timezone}
          />
          <datalist id="invitation-timezone-options">
            {timezones.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </datalist>
        </label>
      </div>
      <div className="form-actions">
        <PendingSubmitButton className="button button-primary" pendingLabel="Issuing…">
          Issue invitation
        </PendingSubmitButton>
      </div>
    </form>
  )
}

export function InvitationRowActions({ invitation }: { invitation: InvitationManagementItem }) {
  const [resendState, resendAction] = useActionState(resendInvitationAction, initialState)
  const [revokeState, revokeAction] = useActionState(revokeInvitationAction, initialState)
  if (invitation.status === 'accepted' || invitation.status === 'revoked') return null

  return (
    <div className="invitation-actions">
      <form action={resendAction}>
        <input name="invitationID" type="hidden" value={invitation.id} />
        <PendingSubmitButton className="button button-primary" pendingLabel="Resending…">
          Rotate and resend
        </PendingSubmitButton>
        <Result state={resendState} />
      </form>
      <details>
        <summary>Revoke invitation</summary>
        <form action={revokeAction} className="compact-action-form">
          <input name="invitationID" type="hidden" value={invitation.id} />
          <label className="field">
            <span>Reason</span>
            <textarea minLength={10} name="reason" required rows={2} />
          </label>
          <PendingSubmitButton className="button button-primary" pendingLabel="Revoking…">
            Revoke
          </PendingSubmitButton>
          <Result state={revokeState} />
        </form>
      </details>
    </div>
  )
}
