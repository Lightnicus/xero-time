'use client'

import { useFormStatus } from 'react-dom'

import { logoutAction } from '../login/actions'

function LogoutSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button className="button button-quiet" disabled={pending} type="submit">
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <LogoutSubmitButton />
    </form>
  )
}
