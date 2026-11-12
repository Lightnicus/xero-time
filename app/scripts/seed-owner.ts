import { config as loadEnvironment } from 'dotenv'

import { MIN_PASSWORD_LENGTH } from '../src/lib/account-lifecycle/password-policy'

loadEnvironment({ quiet: true })

const email = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase()
const password = process.env.SEED_OWNER_PASSWORD
const displayName = process.env.SEED_OWNER_NAME?.trim()
const timezone = process.env.SEED_OWNER_TIMEZONE?.trim() || 'Pacific/Auckland'

if (!email || !password || !displayName) {
  throw new Error(
    'Set SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD, and SEED_OWNER_NAME in the ignored .env before running seed:owner.',
  )
}

if (password.length < MIN_PASSWORD_LENGTH) {
  throw new Error(`SEED_OWNER_PASSWORD must contain at least ${MIN_PASSWORD_LENGTH} characters.`)
}

const [{ getPayload }, { default: configPromise }] = await Promise.all([
  import('payload'),
  import('../src/payload.config'),
])
const payload = await getPayload({ config: configPromise })

try {
  const existing = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })

  if (existing.docs[0]) {
    payload.logger.info(`User ${email} already exists; no changes made.`)
    process.exitCode = 0
  } else {
    const userCount = await payload.count({ collection: 'users', overrideAccess: true })

    if (userCount.totalDocs > 0) {
      throw new Error('A user already exists. Sign in with that account instead.')
    }

    await payload.create({
      collection: 'users',
      data: {
        displayName,
        email,
        password,
        timezone,
      },
      overrideAccess: true,
    })

    payload.logger.info(`Created user ${email}.`)
  }
} finally {
  await payload.destroy()
}
