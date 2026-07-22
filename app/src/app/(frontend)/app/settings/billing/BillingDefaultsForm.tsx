'use client'

import Link from 'next/link'
import { useActionState } from 'react'

import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'
import type { BillingDefaultOption } from '@/lib/billing/default-options'

import { type BillingDefaultsActionState, updateBillingDefaultsAction } from './actions'

type BillingDefaultsFormProps = {
  accountOptions: BillingDefaultOption[]
  initialAccountCode: string
  initialTaxType: string
  taxOptions: BillingDefaultOption[]
  taxRequired: boolean
}

const initialState: BillingDefaultsActionState = { message: null }

export function BillingDefaultsForm({
  accountOptions,
  initialAccountCode,
  initialTaxType,
  taxOptions,
  taxRequired,
}: BillingDefaultsFormProps) {
  const [state, formAction] = useActionState(updateBillingDefaultsAction, initialState)
  const cannotSave = accountOptions.length === 0 || (taxRequired && taxOptions.length === 0)

  return (
    <form action={formAction} className="entry-form">
      {state.message && (
        <div aria-live="polite" className="notice notice-warning" role="status">
          {state.message}
        </div>
      )}

      <section aria-labelledby="xero-invoice-defaults-heading" className="form-section">
        <div className="form-section-heading">
          <span>1</span>
          <div>
            <h2 id="xero-invoice-defaults-heading">Xero invoice defaults</h2>
            <p>These values apply when a customer or project does not provide an override.</p>
          </div>
        </div>

        <div className="form-grid">
          <label className="field" htmlFor="billingDefaultAccountCode">
            <span>Revenue account</span>
            <select
              aria-invalid={Boolean(state.fieldErrors?.accountCode)}
              defaultValue={initialAccountCode}
              disabled={accountOptions.length === 0}
              id="billingDefaultAccountCode"
              name="accountCode"
              required
            >
              <option value="">Choose a Xero revenue account</option>
              {accountOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>Only active Xero income accounts are available.</small>
            {state.fieldErrors?.accountCode && (
              <small className="field-error">{state.fieldErrors.accountCode}</small>
            )}
          </label>

          <label className="field" htmlFor="billingDefaultTaxType">
            <span>{taxRequired ? 'Tax type' : 'Tax type (optional)'}</span>
            <select
              aria-invalid={Boolean(state.fieldErrors?.taxType)}
              defaultValue={initialTaxType}
              disabled={taxOptions.length === 0}
              id="billingDefaultTaxType"
              name="taxType"
              required={taxRequired}
            >
              <option value="">
                {taxRequired ? 'Choose a Xero tax type' : 'No default tax type'}
              </option>
              {taxOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>
              {taxRequired
                ? 'Only active tax rates that Xero permits on revenue are available.'
                : 'Invoices currently use “No tax”, so a tax type is not required.'}
            </small>
            {state.fieldErrors?.taxType && (
              <small className="field-error">{state.fieldErrors.taxType}</small>
            )}
          </label>
        </div>
      </section>

      <div className="form-actions">
        <Link className="button button-secondary" href="/app/billing">
          Back to billing
        </Link>
        <PendingSubmitButton
          className="button button-primary"
          disabled={cannotSave}
          pendingLabel="Saving…"
        >
          Save invoice defaults
        </PendingSubmitButton>
      </div>
    </form>
  )
}
