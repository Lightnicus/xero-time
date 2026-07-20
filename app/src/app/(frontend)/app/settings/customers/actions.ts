'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import {
  customerHasInvoiceReferenceSequence,
  normalizeInvoiceReferenceCode,
  validateInvoiceReferenceCode,
} from '@/collections/Customers'
import { requireAppSession } from '@/lib/member-app/session'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import {
  createXeroContact,
  importXeroContact,
  linkXeroContact,
  refreshCustomerContact,
} from '@/lib/xero/accounting/contacts'

const value = (formData: FormData, name: string): string => {
  const item = formData.get(name)
  return typeof item === 'string' ? item : ''
}

class CustomerInvoiceReferenceLockedError extends Error {}
class CustomerInvoiceReferenceDuplicateError extends Error {}

const referenceRedirect = (status: string, customerID: string): never =>
  redirect(
    `/app/settings/customers?reference=${encodeURIComponent(status)}&customer=${encodeURIComponent(customerID)}#customer-reference-${encodeURIComponent(customerID)}`,
  )

const runCommand = async (operation: () => Promise<void>, success: string): Promise<never> => {
  try {
    await operation()
  } catch {
    redirect('/app/settings/customers?status=failed')
  }
  revalidatePath('/app/settings/customers')
  redirect(`/app/settings/customers?status=${success}`)
}

const commandSession = async (scope = 'xero-contact') => {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')
  await enforceRateLimit(session.payload, {
    key: rateLimitKey(await headers(), String(session.user.id)),
    limit: 40,
    scope: `command.${scope}`,
    windowMs: 15 * 60_000,
  })
  return session
}

export async function updateCustomerInvoiceReferenceAction(formData: FormData): Promise<void> {
  const session = await commandSession('customer-invoice-reference')
  const customerID = value(formData, 'customerID')
  const code = normalizeInvoiceReferenceCode(value(formData, 'invoiceReferenceCode'))
  const startValue = value(formData, 'invoiceReferenceStartNumber')
  const startNumber = Number(startValue)

  if (
    !customerID ||
    code === null ||
    validateInvoiceReferenceCode(code) !== true ||
    !/^\d+$/.test(startValue) ||
    !Number.isSafeInteger(startNumber) ||
    startNumber < 1
  ) {
    referenceRedirect('invalid', customerID)
  }

  try {
    await withPayloadTransaction(
      session.payload,
      async (req) => {
        const customer = await session.payload.findByID({
          collection: 'customers',
          depth: 0,
          id: customerID,
          overrideAccess: true,
          req,
        })
        const lastSequence = (customer as unknown as Record<string, unknown>)
          .lastInvoiceReferenceSequence

        if (
          typeof lastSequence === 'number' ||
          (await customerHasInvoiceReferenceSequence(req, customer.id))
        ) {
          throw new CustomerInvoiceReferenceLockedError()
        }

        const duplicate = await session.payload.find({
          collection: 'customers',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          where: { invoiceReferenceCode: { equals: code } },
        })
        if (duplicate.docs[0] && String(duplicate.docs[0].id) !== String(customer.id)) {
          throw new CustomerInvoiceReferenceDuplicateError()
        }

        await session.payload.update({
          collection: 'customers',
          data: {
            invoiceReferenceCode: code,
            invoiceReferenceStartNumber: startNumber,
          } as never,
          id: customer.id,
          overrideAccess: true,
          req,
        })
      },
      { user: session.user },
    )
  } catch (error) {
    referenceRedirect(
      error instanceof CustomerInvoiceReferenceLockedError
        ? 'locked'
        : error instanceof CustomerInvoiceReferenceDuplicateError
          ? 'duplicate'
          : 'failed',
      customerID,
    )
  }

  revalidatePath('/app/settings/customers')
  revalidatePath('/app/billing')
  referenceRedirect('saved', customerID)
}

export async function linkContactAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  await runCommand(
    () =>
      linkXeroContact(session, {
        confirmHistoricalChange: value(formData, 'confirmHistoricalChange') === 'yes',
        contactID: value(formData, 'contactID'),
        customerID: value(formData, 'customerID'),
        reason: value(formData, 'reason'),
      }),
    'linked',
  )
}

export async function importContactAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  await runCommand(async () => {
    await importXeroContact(session, {
      contactID: value(formData, 'contactID'),
      currency: value(formData, 'currency'),
      localName: value(formData, 'localName'),
    })
  }, 'imported')
}

export async function createContactAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  await runCommand(
    () =>
      createXeroContact(session, {
        confirmation: value(formData, 'confirmation') === 'yes',
        customerID: value(formData, 'customerID'),
      }),
    'created',
  )
}

export async function refreshContactAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  await runCommand(
    () => refreshCustomerContact(session, value(formData, 'customerID')),
    'refreshed',
  )
}
