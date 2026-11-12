'use client'

import { useActionState } from 'react'

import { PendingSubmitButton } from './PendingControls'
import { deleteTimeEntryAction, type TimeEntryActionState } from '../app/time/actions'

const initialState: TimeEntryActionState = { message: null }

export function DeleteTimeEntryButton({ entryID }: { entryID: string }) {
  const [state, formAction] = useActionState(deleteTimeEntryAction, initialState)

  return (
    <form
      action={formAction}
      className="delete-form"
      onSubmit={(event) => {
        if (!window.confirm('Delete this time entry? This cannot be undone.')) {
          event.preventDefault()
        }
      }}
    >
      <input name="entryID" type="hidden" value={entryID} />
      <PendingSubmitButton className="button button-danger" pendingLabel="Deleting…">
        Delete entry
      </PendingSubmitButton>
      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>
    </form>
  )
}
