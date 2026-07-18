import { redirect } from 'next/navigation'

import { getAppSession } from '@/lib/member-app/session'

export default async function HomePage() {
  const session = await getAppSession()

  redirect(session ? '/app' : '/login')
}
