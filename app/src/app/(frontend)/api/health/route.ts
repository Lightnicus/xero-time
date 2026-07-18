import { getPayload } from 'payload'

import config from '@/payload.config'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const database = payload.db.connection.db
    if (!database) throw new Error('Database unavailable.')
    await database.command({ ping: 1 }, { timeoutMS: 2_000 })
    return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' }, status: 200 })
  } catch {
    return Response.json(
      { ready: false },
      { headers: { 'Cache-Control': 'no-store' }, status: 503 },
    )
  }
}
