import { getPayload } from 'payload'

import { logServerEvent } from '@/lib/observability/logger'
import { readBoundedText, RequestInputError } from '@/lib/security/request-input'
import { persistXeroWebhook, validXeroWebhookSignature } from '@/lib/xero/export/webhooks'
import config from '@/payload.config'

export const dynamic = 'force-dynamic'
export const maxDuration = 5

const response = (status: number): Response =>
  new Response(null, {
    headers: { 'Cache-Control': 'no-store' },
    status,
  })

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return response(415)
  }
  let rawBody: string
  try {
    rawBody = await readBoundedText(request)
  } catch (error) {
    return response(error instanceof RequestInputError ? 413 : 400)
  }
  const signature = request.headers.get('x-xero-signature') ?? ''
  if (!validXeroWebhookSignature(rawBody, signature)) return response(401)

  try {
    const payload = await getPayload({ config })
    await persistXeroWebhook(payload, rawBody)
    return response(200)
  } catch {
    try {
      const payload = await getPayload({ config })
      logServerEvent(payload, 'warn', 'xero.webhook-rejected')
    } catch {
      // The safe HTTP response does not depend on diagnostics availability.
    }
    return response(400)
  }
}
