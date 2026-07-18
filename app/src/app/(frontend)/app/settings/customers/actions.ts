'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { requireAppSession } from '@/lib/member-app/session'
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

const runCommand = async (operation: () => Promise<void>, success: string): Promise<never> => {
  try {
    await operation()
  } catch {
    redirect('/app/settings/customers?status=failed')
  }
  revalidatePath('/app/settings/customers')
  redirect(`/app/settings/customers?status=${success}`)
}

const commandSession = async () => {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')
  await enforceRateLimit(session.payload, {
    key: rateLimitKey(await headers(), String(session.user.id)),
    limit: 40,
    scope: 'command.xero-contact',
    windowMs: 15 * 60_000,
  })
  return session
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
