'use client'

import { useFormStatus } from 'react-dom'

import { logoutAction } from '../login/actions'

function LogoutSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button className="account-sign-out" disabled={pending} type="submit">
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}

export function LogoutButton() {
  return (
    <form action={logoutAction} className="account-sign-out-form">
      <LogoutSubmitButton />
    </form>
  )
}
