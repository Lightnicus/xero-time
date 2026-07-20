'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ProjectXeroItemOption } from '@/lib/projects/xero-items'

import { type ProjectXeroItemActionState, updateProjectXeroItemAction } from './actions'

type ProjectXeroItemFormProps = {
  configuredCode: null | string
  configuredID: null | string
  configuredName: null | string
  connected: boolean
  options: ProjectXeroItemOption[]
  projectID: string
  referencesLoaded: boolean
}

const initialState: ProjectXeroItemActionState = { message: null }

function SaveButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus()

  return (
    <button className="button button-secondary" disabled={disabled || pending} type="submit">
      {pending ? 'Saving…' : label}
    </button>
  )
}

export function ProjectXeroItemForm({
  configuredCode,
  configuredID,
  configuredName,
  connected,
  options,
  projectID,
  referencesLoaded,
}: ProjectXeroItemFormProps) {
  const [state, formAction] = useActionState(updateProjectXeroItemAction, initialState)
  const configuredIsCurrent = Boolean(
    configuredID && options.some((option) => option.value === configuredID),
  )
  const hasSelectableItems = connected && options.length > 0
  const mappingIsUnavailable = Boolean(
    configuredID && connected && referencesLoaded && !configuredIsCurrent,
  )
  const mappingIsUnverified = Boolean(configuredID && (!connected || !referencesLoaded))
  const disabled = !hasSelectableItems
  const selectID = `project-xero-item-${projectID}`

  return (
    <form action={formAction} className="compact-form">
      <input name="projectID" type="hidden" value={projectID} />

      {state.message && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          {state.message}
        </div>
      )}

      {mappingIsUnavailable && (
        <div className="notice notice-warning">
          The previous mapping
          {configuredCode
            ? ` “${configuredCode}${configuredName ? ` — ${configuredName}` : ''}”`
            : ''}{' '}
          is not an active sales item in the refreshed Xero data. Choose an active replacement.
        </div>
      )}
      {mappingIsUnverified && (
        <div className="notice">
          Saved mapping
          {configuredCode
            ? `: ${configuredCode}${configuredName ? ` — ${configuredName}` : ''}`
            : ''}
          . {connected ? 'Refresh Xero data to verify it.' : 'Reconnect Xero to verify it.'}
        </div>
      )}

      <label className="field" htmlFor={selectID}>
        <span>Xero invoice item</span>
        <select
          aria-invalid={Boolean(state.fieldErrors?.xeroItemId)}
          defaultValue={configuredIsCurrent ? (configuredID ?? '') : ''}
          disabled={disabled}
          id={selectID}
          name="xeroItemId"
          required
        >
          <option value="">Choose a Xero sales item</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <small>
          Sets Xero’s Item column on future invoice lines for this project. Account, tax, rate, and
          description remain explicit.
        </small>
        {state.fieldErrors?.xeroItemId && (
          <small className="field-error">{state.fieldErrors.xeroItemId}</small>
        )}
      </label>

      <label className="confirmation-field">
        <input name="confirmUnbilledImpact" type="checkbox" value="yes" />
        <span>
          I understand existing unbilled entries may use this item in their next invoice preview.
        </span>
      </label>
      {state.fieldErrors?.confirmUnbilledImpact && (
        <small className="field-error">{state.fieldErrors.confirmUnbilledImpact}</small>
      )}

      <label className="field">
        <span>Commercial reason</span>
        <textarea
          aria-invalid={Boolean(state.fieldErrors?.commercialChangeReason)}
          maxLength={1_000}
          minLength={10}
          name="commercialChangeReason"
          placeholder="Required when this project has unbilled time"
          rows={2}
        />
        {state.fieldErrors?.commercialChangeReason && (
          <small className="field-error">{state.fieldErrors.commercialChangeReason}</small>
        )}
      </label>

      <SaveButton
        disabled={disabled}
        label={mappingIsUnavailable && hasSelectableItems ? 'Replace Xero item' : 'Save Xero item'}
      />
    </form>
  )
}
