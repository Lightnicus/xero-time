import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { AccountingIntegrationError } from './contracts'

export type EncryptionKey = {
  keyHex: string
  version: number
}

const envelopePattern = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
const derivationSalt = Buffer.from('project-time:xero-accounting:key-derivation:v1', 'utf8')

export function deriveEncryptionKey(
  rootSecret: string,
  purpose: string,
  version = 1,
): EncryptionKey {
  if (
    rootSecret.length < 16 ||
    rootSecret.length > 10_000 ||
    purpose.length === 0 ||
    purpose.length > 200 ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    throw new AccountingIntegrationError(
      'invalid-key-derivation-input',
      'The accounting encryption key could not be derived.',
    )
  }

  const bytes = hkdfSync(
    'sha256',
    Buffer.from(rootSecret, 'utf8'),
    derivationSalt,
    Buffer.from(purpose, 'utf8'),
    32,
  )

  return { keyHex: Buffer.from(bytes).toString('hex'), version }
}

const keyBytes = ({ keyHex }: EncryptionKey): Buffer => {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new AccountingIntegrationError(
      'invalid-encryption-key',
      'The accounting token encryption key is invalid.',
    )
  }

  return Buffer.from(keyHex, 'hex')
}

export function encryptSecret(value: string, purpose: string, key: EncryptionKey): string {
  if (value.length === 0 || value.length > 100_000 || purpose.length === 0) {
    throw new AccountingIntegrationError(
      'invalid-encryption-input',
      'Sensitive accounting data could not be encrypted.',
    )
  }

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv)
  cipher.setAAD(Buffer.from(`${purpose}:v${key.version}`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `v${key.version}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`
}

export function decryptSecret(envelope: string, purpose: string, key: EncryptionKey): string {
  const match = envelopePattern.exec(envelope)
  if (!match || Number(match[1]) !== key.version || purpose.length === 0) {
    throw new AccountingIntegrationError(
      'unsupported-encryption-key',
      'Stored accounting credentials require a different encryption key.',
    )
  }

  const [, , initializationVector, encryptedValue, authenticationTag] = match
  if (!initializationVector || !encryptedValue || !authenticationTag) {
    throw new AccountingIntegrationError(
      'credential-decryption-failed',
      'Stored accounting credentials could not be decrypted.',
    )
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyBytes(key),
      Buffer.from(initializationVector, 'base64url'),
    )
    decipher.setAAD(Buffer.from(`${purpose}:v${key.version}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    throw new AccountingIntegrationError(
      'credential-decryption-failed',
      'Stored accounting credentials could not be decrypted.',
      { cause: error },
    )
  }
}

export const randomOpaqueValue = (): string => randomBytes(32).toString('base64url')

export const hashOpaqueValue = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url')

export function opaqueHashMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueValue(value), 'utf8')
  const expected = Buffer.from(expectedHash, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
