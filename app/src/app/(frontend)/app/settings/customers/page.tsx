import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { getBusinessSettings } from '@/lib/member-app/data'
import { requireAppSession } from '@/lib/member-app/session'
import { searchXeroContacts, type XeroContactView } from '@/lib/xero/accounting/contacts'

import {
  createContactAction,
  importContactAction,
  linkContactAction,
  refreshContactAction,
} from './actions'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Customer Xero mappings | Project Time' }

type Params = { page?: string | string[]; query?: string | string[]; status?: string | string[] }

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

  return (
    <div className="wide-page page-stack">
      <div className="breadcrumb">
        <Link href="/app">My time</Link>
        <span aria-hidden="true">/</span>
        <span>Customer mappings</span>
      </div>
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Xero contacts</p>
          <h1>Customer mappings</h1>
          <p>
            Search and select contacts by ContactID. Names are display snapshots and are never used
            to remap a customer automatically.
          </p>
        </div>
        <Link className="button button-secondary" href="/admin/collections/customers">
          Edit local customers
        </Link>
      </section>

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

      <section className="panel page-stack">
        <div>
          <h2>Search Xero contacts</h2>
          <p>Results include active and archived contacts and show any existing local mapping.</p>
        </div>
        <form className="filter-bar" method="get">
          <label className="field">
            <span>Contact name, email, or number</span>
            <input defaultValue={query} maxLength={100} minLength={2} name="query" required />
          </label>
          <button className="button button-primary" type="submit">
            Search Xero
          </button>
        </form>
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
                    <button className="button button-secondary" type="submit">
                      Link this customer
                    </button>
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
                    <button className="button button-danger" type="submit">
                      Change Xero link
                    </button>
                  </form>
                )}
                <form action={importContactAction} className="compact-form">
                  <input name="contactID" type="hidden" value={contact.contactID} />
                  <input name="localName" type="hidden" value={contact.name} />
                  <input name="currency" type="hidden" value={settings.baseCurrency} />
                  <button className="button button-secondary" type="submit">
                    Import as new {settings.baseCurrency} customer
                  </button>
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
                <button className="button button-primary" type="submit">
                  Create contact in Xero
                </button>
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
                <button className="button button-secondary" type="submit">
                  Refresh from Xero
                </button>
              </form>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
