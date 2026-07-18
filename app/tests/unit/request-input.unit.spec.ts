// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  assertRequestBodySize,
  parseBoundedFormData,
  readBoundedText,
  RequestInputError,
} from '@/lib/security/request-input'

describe('bounded request input', () => {
  it('rejects an invalid or oversized declared content length before reading', () => {
    expect(() =>
      assertRequestBodySize(
        new Request('https://example.test', { headers: { 'content-length': '101' } }),
        100,
      ),
    ).toThrow(RequestInputError)
    expect(() =>
      assertRequestBodySize(
        new Request('https://example.test', { headers: { 'content-length': 'invalid' } }),
      ),
    ).toThrow(RequestInputError)
  })

  it('checks the actual byte size when content length is absent or untrusted', async () => {
    await expect(
      readBoundedText(new Request('https://example.test', { body: 'éé', method: 'POST' }), 3),
    ).rejects.toThrow(RequestInputError)
    await expect(
      readBoundedText(new Request('https://example.test', { body: 'ok', method: 'POST' }), 3),
    ).resolves.toBe('ok')
  })

  it('accepts only allow-listed bounded string form fields', async () => {
    const body = new FormData()
    body.set('reason', 'A bounded reason')
    const parsed = await parseBoundedFormData(
      new Request('https://example.test', { body, method: 'POST' }),
      ['reason'],
    )
    expect(parsed.get('reason')).toBe('A bounded reason')
  })

  it('rejects unknown, repeated, file, or oversized form values', async () => {
    const unknown = new FormData()
    unknown.set('unexpected', 'value')
    await expect(
      parseBoundedFormData(new Request('https://example.test', { body: unknown, method: 'POST' }), [
        'reason',
      ]),
    ).rejects.toThrow(RequestInputError)

    const repeated = new FormData()
    repeated.append('reason', 'first')
    repeated.append('reason', 'second')
    await expect(
      parseBoundedFormData(
        new Request('https://example.test', { body: repeated, method: 'POST' }),
        ['reason'],
      ),
    ).rejects.toThrow(RequestInputError)

    const file = new FormData()
    file.set('reason', new File(['value'], 'reason.txt'))
    await expect(
      parseBoundedFormData(new Request('https://example.test', { body: file, method: 'POST' }), [
        'reason',
      ]),
    ).rejects.toThrow(RequestInputError)
  })
})
