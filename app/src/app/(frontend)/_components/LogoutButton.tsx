'use client'

import { PendingSubmitButton } from './PendingControls'
import { logoutAction } from '../login/actions'

export function LogoutButton() {
  return (
    <form action={logoutAction} className="account-sign-out-form">
      <PendingSubmitButton className="account-sign-out" pendingLabel="Signing out…">
        Sign out
      </PendingSubmitButton>
    </form>
  )
}
