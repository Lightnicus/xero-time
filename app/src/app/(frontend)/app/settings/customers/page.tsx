import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import {
  PendingNavigationForm,
  PendingSubmitButton,
} from '@/app/(frontend)/_components/PendingControls'
import { getBusinessSettings } from '@/lib/member-app/data'
import { requireAppSession } from '@/lib/member-app/session'
import { searchXeroContacts, type XeroContactView } from '@/lib/xero/accounting/contacts'

import {
  createContactAction,
  importContactAction,
  linkContactAction,
  refreshContactAction,
  updateCustomerInvoiceReferenceAction,
} from './actions'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Customer billing | Project Time' }

type Params = {
  customer?: string | string[]
  page?: string | string[]
  query?: string | string[]
  reference?: string | string[]
  status?: string | string[]
}

type CustomerReferenceFields = {
  invoiceReferenceCode?: null | string
  invoiceReferenceStartNumber?: null | number
  lastInvoiceReferenceSequence?: null | number
}

const customerReferenceFields = (customer: unknown): CustomerReferenceFields =>
  customer as CustomerReferenceFields

const referenceNumber = (value: number): string => String(value).padStart(4, '0')

export default async function CustomerMappingPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')
  const params = await searchParams
  const query = typeof params.query === 'string' ? params.query.trim() : ''
  const page = typeof params.page === 'string' ? Number(params.page) : 1
  const [customers, settings] = await Promise.all([
    session.payload.find({
      collection: 'customers',
      depth: 0,
      limit: 200,
      overrideAccess: true,
      req: session.req,
      sort: 'name',
    }),
    getBusinessSettings(session),
  ])
  let contacts: XeroContactView[] = []
  let searchFailed = false
  if (query.length >= 2) {
    try {
      contacts = (await searchXeroContacts(session, { page, query })).contacts
    } catch {
      searchFailed = true
    }
  }
  const unmapped = customers.docs.filter((customer) => !customer.xeroContactId)
  const mapped = customers.docs.filter((customer) => customer.xeroContactId)
  const referenceStatus = typeof params.reference === 'string' ? params.reference : null
  const referenceCustomerID = typeof params.customer === 'string' ? params.customer : null
  const referenceCustomer = customers.docs.find(
    (customer) => String(customer.id) === referenceCustomerID,
  )
  const referenceStatusMessage =
    referenceStatus === 'saved'
      ? `Invoice reference settings saved${referenceCustomer ? ` for ${referenceCustomer.name}` : ''}.`
      : referenceStatus === 'invalid'
        ? 'Enter a code of up to 30 letters and numbers, with single hyphens between them, and a starting number of at least 1.'
        : referenceStatus === 'locked'
          ? 'These invoice reference settings are permanent because this customer has already reserved an invoice reference.'
          : referenceStatus === 'duplicate'
            ? 'Another customer already uses that invoice reference code. Choose a unique code.'
            : referenceStatus === 'failed'
              ? 'The invoice reference settings could not be saved. Review the values and try again.'
              : null

  return (
    <div className="wide-page page-stack">
      <PageHeader
        action={
          <Link className="button button-secondary" href="/admin/collections/customers">
            Manage customers in Payload Admin ↗
          </Link>
        }
        breadcrumb={{ current: 'Customer billing', href: '/app/settings', label: 'Settings' }}
        description="Configure readable invoice references and map each customer to a Xero contact. Contact names are display snapshots and are never used to remap automatically."
        title="Customer billing"
      />

      {params.status && (
        <div
          className={params.status === 'failed' ? 'notice notice-warning' : 'notice notice-success'}
          role="status"
        >
          {params.status === 'failed'
            ? 'The mapping operation could not be completed. Check the connection and mapping state.'
            : 'Customer mapping updated.'}
        </div>
      )}

      {referenceStatusMessage && (
        <div
          className={
            referenceStatus === 'saved' ? 'notice notice-success' : 'notice notice-warning'
          }
          role={referenceStatus === 'saved' ? 'status' : 'alert'}
        >
          {referenceStatusMessage}
        </div>
      )}

      <section className="panel page-stack">
        <div>
          <h2>Customer invoice references</h2>
          <p>
            Give each customer a unique, stable code. Draft invoices then count upward for that
            customer—such as CUSTOMER-0001, CUSTOMER-0002—even when an invoice contains several
            projects.
          </p>
          <p className="muted-copy">
            Spaces are saved as hyphens. The code and starting number become permanent as soon as
            the first invoice reference is reserved.
          </p>
        </div>
        <div className="mapping-list">
          {customers.docs.map((customer) => {
            const reference = customerReferenceFields(customer)
            const code = reference.invoiceReferenceCode ?? ''
            const startNumber = reference.invoiceReferenceStartNumber ?? 1
            const lastSequence = reference.lastInvoiceReferenceSequence
            const locked = typeof lastSequence === 'number'
            const nextSequence = locked ? lastSequence + 1 : startNumber
            const exampleCode = code || 'CUSTOMER'

            return (
              <article
                className="mapping-row"
                id={`customer-reference-${customer.id}`}
                key={customer.id}
              >
                <div>
                  <strong>{customer.name}</strong>
                  <p>
                    Next reference: {exampleCode}-{referenceNumber(nextSequence)}
                  </p>
                  <small>
                    {locked
                      ? 'Reference numbering has started; these values can no longer change.'
                      : code
                        ? `The first reserved reference will use sequence ${referenceNumber(startNumber)}.`
                        : 'Set a code before this customer can be included in an export.'}
                  </small>
                </div>
                <form action={updateCustomerInvoiceReferenceAction} className="compact-form">
                  <input name="customerID" type="hidden" value={customer.id} />
                  <label className="field">
                    <span>Customer reference code</span>
                    <input
                      autoCapitalize="characters"
                      defaultValue={code}
                      disabled={locked}
                      maxLength={30}
                      name="invoiceReferenceCode"
                      placeholder="CUSTOMER"
                      required
                    />
                    <small>
                      Unique across customers; use letters and numbers with single hyphens between
                      them.
                    </small>
                  </label>
                  <label className="field">
                    <span>Starting number</span>
                    <input
                      defaultValue={startNumber}
                      disabled={locked}
                      min={1}
                      name="invoiceReferenceStartNumber"
                      required
                      step={1}
                      type="number"
                    />
                    <small>
                      Start above any references already used for this customer in Xero.
                    </small>
                  </label>
                  <PendingSubmitButton
                    className="button button-secondary"
                    disabled={locked}
                    pendingLabel="Saving invoice reference…"
                  >
                    {locked ? 'Reference numbering started' : 'Save invoice reference'}
                  </PendingSubmitButton>
                </form>
              </article>
            )
          })}
        </div>
      </section>

      <section className="panel page-stack">
        <div>
          <h2>Search Xero contacts</h2>
          <p>Results include active and archived contacts and show any existing local mapping.</p>
        </div>
        <PendingNavigationForm action="/app/settings/customers" className="filter-bar" method="get">
          <label className="field">
            <span>Contact name, email, or number</span>
            <input defaultValue={query} maxLength={100} minLength={2} name="query" required />
          </label>
          <PendingSubmitButton className="button button-primary" pendingLabel="Searching Xero…">
            Search Xero
          </PendingSubmitButton>
        </PendingNavigationForm>
        {searchFailed && (
          <div className="notice notice-warning" role="alert">
            Xero contact search is unavailable. Check the accounting connection and retry.
          </div>
        )}
        {contacts.map((contact) => (
          <article className="mapping-row" key={contact.contactID}>
            <div>
              <strong>{contact.name}</strong>
              <p>
                {contact.email ?? 'No email'} · {contact.contactNumber ?? 'No contact number'}
              </p>
              <small>
                {contact.status} · ContactID {contact.contactID}
                {contact.locallyMappedCustomerID
                  ? ` · linked to customer ${contact.locallyMappedCustomerID}`
                  : ''}
              </small>
            </div>
            {contact.locallyMappedCustomerID ? (
              <Link
                className="button button-secondary"
                href={`/admin/collections/customers/${contact.locallyMappedCustomerID}`}
              >
                Open mapped customer
              </Link>
            ) : (
              <div className="mapping-actions">
                {unmapped.length > 0 && (
                  <form action={linkContactAction} className="compact-form">
                    <input name="contactID" type="hidden" value={contact.contactID} />
                    <label className="field">
                      <span>Link local customer</span>
                      <select name="customerID" required>
                        {unmapped.map((customer) => (
                          <option key={customer.id} value={customer.id}>
                            {customer.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <PendingSubmitButton
                      className="button button-secondary"
                      pendingLabel="Linking customer…"
                    >
                      Link this customer
                    </PendingSubmitButton>
                  </form>
                )}
                {mapped.length > 0 && (
                  <form action={linkContactAction} className="compact-form">
                    <input name="contactID" type="hidden" value={contact.contactID} />
                    <label className="field">
                      <span>Change an existing Xero link</span>
                      <select name="customerID" required>
                        {mapped.map((customer) => (
                          <option key={customer.id} value={customer.id}>
                            {customer.name} — currently {customer.xeroContactNameSnapshot}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Remap reason</span>
                      <textarea maxLength={1_000} minLength={10} name="reason" required rows={2} />
                    </label>
                    <label className="confirmation-field">
                      <input name="confirmHistoricalChange" required type="checkbox" value="yes" />
                      <span>
                        I understand historical invoices keep their original ContactID snapshot.
                      </span>
                    </label>
                    <PendingSubmitButton
                      className="button button-danger"
                      pendingLabel="Changing Xero link…"
                    >
                      Change Xero link
                    </PendingSubmitButton>
                  </form>
                )}
                <form action={importContactAction} className="compact-form">
                  <input name="contactID" type="hidden" value={contact.contactID} />
                  <input name="localName" type="hidden" value={contact.name} />
                  <input name="currency" type="hidden" value={settings.baseCurrency} />
                  <PendingSubmitButton
                    className="button button-secondary"
                    pendingLabel="Importing customer…"
                  >
                    Import as new {settings.baseCurrency} customer
                  </PendingSubmitButton>
                </form>
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="panel page-stack">
        <div>
          <h2>Local customers</h2>
          <p>Create missing contacts explicitly or refresh existing mapping status.</p>
        </div>
        <div className="mapping-list">
          {unmapped.map((customer) => (
            <article className="mapping-row" key={customer.id}>
              <div>
                <strong>{customer.name}</strong>
                <p>{customer.billingEmail ?? 'No billing email'} · Unmapped</p>
              </div>
              <form action={createContactAction} className="compact-form">
                <input name="customerID" type="hidden" value={customer.id} />
                <label className="confirmation-field">
                  <input name="confirmation" required type="checkbox" value="yes" />
                  <span>
                    Create exactly “{customer.name}”
                    {customer.billingEmail ? ` (${customer.billingEmail})` : ''} in Xero.
                  </span>
                </label>
                <PendingSubmitButton
                  className="button button-primary"
                  pendingLabel="Creating contact…"
                >
                  Create contact in Xero
                </PendingSubmitButton>
              </form>
            </article>
          ))}
          {mapped.map((customer) => (
            <article className="mapping-row" key={customer.id}>
              <div>
                <strong>{customer.name}</strong>
                <p>
                  {customer.xeroContactNameSnapshot} · {customer.xeroMappingStatus}
                </p>
                <small>ContactID {customer.xeroContactId}</small>
              </div>
              <form action={refreshContactAction}>
                <input name="customerID" type="hidden" value={customer.id} />
                <PendingSubmitButton
                  className="button button-secondary"
                  pendingLabel="Refreshing from Xero…"
                >
                  Refresh from Xero
                </PendingSubmitButton>
              </form>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
