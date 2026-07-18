'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { deleteTimeEntryAction, type TimeEntryActionState } from '../app/time/actions'

const initialState: TimeEntryActionState = { message: null }

function DeleteSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button className="button button-danger" disabled={pending} type="submit">
      {pending ? 'Deleting…' : 'Delete entry'}
    </button>
  )
}

export function DeleteTimeEntryButton({
  entryID,
  requiresReason = false,
}: {
  entryID: string
  requiresReason?: boolean
}) {
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
      {requiresReason && (
        <label className="field" htmlFor="deleteCorrectionReason">
          <span>Deletion reason</span>
          <textarea
            id="deleteCorrectionReason"
            maxLength={1_000}
            minLength={10}
            name="privilegedCorrectionReason"
            required
            rows={3}
          />
        </label>
      )}
      <DeleteSubmitButton />
      <div aria-live="polite" className="form-message form-message-error" role="status">
        {state.message}
      </div>
    </form>
  )
}
