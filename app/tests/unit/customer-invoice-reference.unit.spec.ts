import { describe, expect, it, vi } from 'vitest'

import {
  normalizeInvoiceReferenceCode,
  protectInvoiceReferenceIdentity,
  validateInvoiceReferenceCode,
} from '@/collections/Customers'

import type { PayloadRequest } from 'payload'

type HookInput = Parameters<typeof protectInvoiceReferenceIdentity>[0]

const hookInput = (find: ReturnType<typeof vi.fn>, overrides: Partial<HookInput> = {}): HookInput =>
  ({
    collection: null,
    context: {},
    data: { invoiceReferenceCode: 'NEW-CODE' },
    operation: 'update',
    originalDoc: {
      id: 'customer-1',
      invoiceReferenceCode: 'OLD-CODE',
      invoiceReferenceStartNumber: 1,
    },
    req: { payload: { find } } as unknown as PayloadRequest,
    ...overrides,
  }) as HookInput

describe('customer invoice-reference configuration', () => {
  it('normalizes a human-entered customer code', () => {
    expect(normalizeInvoiceReferenceCode('  acme   consulting  ')).toBe('ACME-CONSULTING')
    expect(normalizeInvoiceReferenceCode('   ')).toBeNull()
  })

  it('accepts only the optional 1–30 character reference-code contract', () => {
    expect(validateInvoiceReferenceCode(null)).toBe(true)
    expect(validateInvoiceReferenceCode('A')).toBe(true)
    expect(validateInvoiceReferenceCode('ACME-NEW-ZEALAND')).toBe(true)
    expect(validateInvoiceReferenceCode('-ACME')).not.toBe(true)
    expect(validateInvoiceReferenceCode('ACME-')).not.toBe(true)
    expect(validateInvoiceReferenceCode('ACME--NZ')).not.toBe(true)
    expect(validateInvoiceReferenceCode('ACME_UNDERSCORE')).not.toBe(true)
    expect(validateInvoiceReferenceCode('A'.repeat(31))).not.toBe(true)
  })

  it('rejects identity changes after a customer sequence has been allocated', async () => {
    const find = vi.fn()

    await expect(
      protectInvoiceReferenceIdentity(
        hookInput(find, {
          originalDoc: {
            id: 'customer-1',
            invoiceReferenceCode: 'OLD-CODE',
            invoiceReferenceStartNumber: 1,
            lastInvoiceReferenceSequence: 7,
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(find).not.toHaveBeenCalled()
  })

  it('also protects sequences claimed by an existing export', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [{ id: 'export-1' }] })

    await expect(protectInvoiceReferenceIdentity(hookInput(find))).rejects.toMatchObject({
      status: 400,
    })
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'invoice-exports',
        where: {
          and: [
            { customer: { equals: 'customer-1' } },
            { customerReferenceSequence: { exists: true } },
          ],
        },
      }),
    )
  })

  it('allows configuration before the first sequence is claimed', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [] })
    const input = hookInput(find)

    await expect(protectInvoiceReferenceIdentity(input)).resolves.toBe(input.data)
  })
})
