'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { billingDefaultFieldErrors, type BillingDefaultField } from '@/lib/billing/default-options'
import { validateXeroBillingDefaults } from '@/lib/billing/default-validation'
import { requireAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'

export type BillingDefaultsActionState = {
  fieldErrors?: Partial<Record<BillingDefaultField, string>>
  message: null | string
}

const value = (formData: FormData, field: string): string => {
  const item = formData.get(field)
  return typeof item === 'string' ? item.trim().toUpperCase() : ''
}

export async function updateBillingDefaultsAction(
  _previousState: BillingDefaultsActionState,
  formData: FormData,
): Promise<BillingDefaultsActionState> {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    return { message: 'Only an owner or administrator can change invoice defaults.' }
  }

  const accountCode = value(formData, 'accountCode')
  const taxType = value(formData, 'taxType')
  const settings = await session.payload.findGlobal({
    slug: 'billing-settings',
    overrideAccess: false,
    req: session.req,
  })
  const taxRequired = settings.lineAmountType !== 'NoTax'
  const fieldErrors = billingDefaultFieldErrors({ accountCode, taxRequired, taxType })

  if (Object.keys(fieldErrors).length > 0) {
    return {
      fieldErrors,
      message: 'Choose the missing Xero invoice defaults and try again.',
    }
  }

  try {
    await enforceRateLimit(session.payload, {
      key: rateLimitKey(await headers(), String(session.user.id)),
      limit: 20,
      scope: 'command.billing-defaults',
      windowMs: 15 * 60_000,
    })
    await validateXeroBillingDefaults(session.req, {
      accountCode,
      taxType: taxType || undefined,
    })
    await session.payload.updateGlobal({
      slug: 'billing-settings',
      data: {
        defaultRevenueAccountCode: accountCode,
        defaultTaxType: taxType || null,
      },
      overrideAccess: false,
      req: session.req,
    })
  } catch (error) {
    return {
      message:
        error instanceof AccountingIntegrationError
          ? error.message
          : 'The invoice defaults could not be saved. Refresh Xero data and try again.',
    }
  }

  revalidatePath('/app/settings/billing')
  revalidatePath('/app/billing')
  redirect('/app/settings/billing?saved=1')
}
