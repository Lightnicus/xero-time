'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { requireAppSession } from '@/lib/member-app/session'
import { confirmProjectRateRecalculation } from '@/lib/projects/rate-recalculation'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'

const value = (formData: FormData, name: string): string => {
  const item = formData.get(name)
  return typeof item === 'string' ? item : ''
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
