'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ValidationError } from 'payload'

import { hasActiveRole } from '@/access/roles'
import { validateOptionalXeroID } from '@/lib/domain/validation'
import { requireAppSession } from '@/lib/member-app/session'
import { confirmProjectRateRecalculation } from '@/lib/projects/rate-recalculation'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'

const value = (formData: FormData, name: string): string => {
  const item = formData.get(name)
  return typeof item === 'string' ? item : ''
}

export type ProjectXeroItemField = 'commercialChangeReason' | 'confirmUnbilledImpact' | 'xeroItemId'

export type ProjectXeroItemActionState = {
  fieldErrors?: Partial<Record<ProjectXeroItemField, string>>
  message: null | string
}

export async function updateProjectXeroItemAction(
  _previousState: ProjectXeroItemActionState,
  formData: FormData,
): Promise<ProjectXeroItemActionState> {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    return { message: 'Only an owner or administrator can change project invoice items.' }
  }

  const projectID = value(formData, 'projectID').trim()
  const xeroItemId = value(formData, 'xeroItemId').trim()
  const commercialChangeReason = value(formData, 'commercialChangeReason').trim()
  const fieldErrors: NonNullable<ProjectXeroItemActionState['fieldErrors']> = {}
  if (!projectID || projectID.length > 100) {
    return { message: 'The selected project is unavailable.' }
  }
  if (!xeroItemId) {
    fieldErrors.xeroItemId = 'Choose a Xero invoice item.'
  } else if (validateOptionalXeroID(xeroItemId) !== true) {
    fieldErrors.xeroItemId = 'Choose a Xero invoice item from the refreshed list.'
  }
  if (commercialChangeReason.length > 1_000) {
    fieldErrors.commercialChangeReason = 'Keep the commercial reason to 1,000 characters or fewer.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, message: 'Check the project item settings and try again.' }
  }

  try {
    await enforceRateLimit(session.payload, {
      key: rateLimitKey(await headers(), String(session.user.id)),
      limit: 40,
      scope: 'command.project-xero-item',
      windowMs: 15 * 60_000,
    })
    await session.payload.update({
      collection: 'projects',
      data: {
        commercialChangeReason,
        confirmUnbilledImpact: value(formData, 'confirmUnbilledImpact') === 'yes',
        xeroItemId: xeroItemId || null,
      } as never,
      depth: 0,
      id: projectID,
      overrideAccess: true,
      req: session.req,
    })
  } catch (error) {
    if (error instanceof ValidationError) {
      const payloadErrors: NonNullable<ProjectXeroItemActionState['fieldErrors']> = {}
      for (const item of error.data.errors) {
        if (
          item.path === 'xeroItemId' ||
          item.path === 'confirmUnbilledImpact' ||
          item.path === 'commercialChangeReason'
        ) {
          payloadErrors[item.path] = item.message
        }
      }
      return {
        fieldErrors: payloadErrors,
        message: error.data.errors[0]?.message ?? 'The project invoice item could not be saved.',
      }
    }
    return {
      message:
        'The project invoice item could not be saved. Refresh Xero reference data and try again.',
    }
  }

  revalidatePath('/app/settings/projects')
  revalidatePath('/app/billing')
  redirect(
    `/app/settings/projects?item=saved&itemProject=${encodeURIComponent(projectID)}#project-item-${encodeURIComponent(projectID)}`,
  )
}

export async function recalculateProjectRatesAction(formData: FormData): Promise<void> {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  try {
    await enforceRateLimit(session.payload, {
      key: rateLimitKey(await headers(), String(session.user.id)),
      limit: 20,
      scope: 'command.project-rate',
      windowMs: 15 * 60_000,
    })
    const count = await confirmProjectRateRecalculation(session, {
      confirmation: value(formData, 'confirmation'),
      expectedHash: value(formData, 'expectedHash'),
      projectID: value(formData, 'projectID'),
      reason: value(formData, 'reason'),
    })
    revalidatePath('/app/settings/projects')
    revalidatePath('/app/billing')
    redirect(`/app/settings/projects?updated=${count}`)
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error
    redirect(
      `/app/settings/projects?project=${encodeURIComponent(value(formData, 'projectID'))}&error=stale`,
    )
  }
}
