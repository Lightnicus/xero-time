import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

import { environment } from '@/lib/env'

import type { BillingSelection } from './contracts'

type SelectionEnvelope = {
  expiresAt: number
  invoiceDate: string
  selection: BillingSelection
}

const signature = (payload: string): string =>
  createHmac('sha256', environment.payloadSecret).update(payload, 'utf8').digest('base64url')

export function createSelectionToken(input: {
  invoiceDate: string
  selection: BillingSelection
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...input,
      expiresAt: Date.now() + 30 * 60 * 1_000,
    } satisfies SelectionEnvelope),
    'utf8',
  ).toString('base64url')
  if (payload.length > 16_000)
    throw new Error('The explicit selection is too large. Use all matching with exclusions.')
  return `${payload}.${signature(payload)}`
}

export function readSelectionToken(token: string): SelectionEnvelope {
  if (token.length > 17_000) throw new Error('The billing selection is invalid.')
  const [payload, provided] = token.split('.')
  if (!payload || !provided) throw new Error('The billing selection is invalid.')
  const expected = Buffer.from(signature(payload), 'utf8')
  const received = Buffer.from(provided, 'utf8')
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new Error('The billing selection is invalid.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('The billing selection is invalid.')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as SelectionEnvelope).expiresAt !== 'number' ||
    (parsed as SelectionEnvelope).expiresAt < Date.now() ||
    typeof (parsed as SelectionEnvelope).invoiceDate !== 'string' ||
    !(parsed as SelectionEnvelope).selection
  ) {
    throw new Error('The billing selection expired or is invalid.')
  }
  return parsed as SelectionEnvelope
}
