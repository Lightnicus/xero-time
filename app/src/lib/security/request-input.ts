import 'server-only'

export class RequestInputError extends Error {
  code = 'invalid-request'

  constructor(message = 'The request body is invalid.') {
    super(message)
    this.name = 'RequestInputError'
  }
}

export const assertRequestBodySize = (request: Request, maxBytes = 16_384): void => {
  const rawLength = request.headers.get('content-length')
  if (!rawLength) return
  if (!/^\d+$/.test(rawLength) || Number(rawLength) > maxBytes) {
    throw new RequestInputError('The request body is too large.')
  }
}

export async function parseBoundedFormData(
  request: Request,
  allowedFields: readonly string[],
  options: { maxBytes?: number; maxFieldLength?: number } = {},
): Promise<FormData> {
  assertRequestBodySize(request, options.maxBytes)
  const formData = await request.formData()
  const allowed = new Set(allowedFields)
  let fieldCount = 0
  for (const [name, value] of formData.entries()) {
    fieldCount += 1
    if (
      fieldCount > allowedFields.length ||
      !allowed.has(name) ||
      typeof value !== 'string' ||
      value.length > (options.maxFieldLength ?? 5_000)
    ) {
      throw new RequestInputError()
    }
  }
  return formData
}

export async function readBoundedText(request: Request, maxBytes = 1_048_576): Promise<string> {
  assertRequestBodySize(request, maxBytes)
  const value = await request.text()
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RequestInputError('The request body is too large.')
  }
  return value
}
