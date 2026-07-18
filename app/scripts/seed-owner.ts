import { config as loadEnvironment } from 'dotenv'

import { MIN_PASSWORD_LENGTH } from '../src/lib/account-lifecycle/password-policy'

loadEnvironment()

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

const [{ getPayload }, { default: configPromise }, { INITIAL_OWNER_SEED_CONTEXT }] =
  await Promise.all([
    import('payload'),
    import('../src/payload.config'),
    import('../src/access/users'),
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
    if (existing.docs[0].role !== 'owner' || existing.docs[0].active !== true) {
      throw new Error(
        `User ${email} already exists but is not an active owner; refusing to change roles from a seed command.`,
      )
    }

    payload.logger.info(`Owner ${email} already exists; no changes made.`)
    process.exitCode = 0
  } else {
    const userCount = await payload.count({ collection: 'users', overrideAccess: true })

    if (userCount.totalDocs > 0) {
      throw new Error(
        'Users already exist. Create or promote an owner through the protected application workflow instead of the bootstrap seed.',
      )
    }

    await payload.create({
      collection: 'users',
      context: {
        [INITIAL_OWNER_SEED_CONTEXT]: true,
      },
      data: {
        active: true,
        displayName,
        email,
        password,
        role: 'owner',
        timezone,
      },
      overrideAccess: true,
    })

    payload.logger.info(`Created initial owner ${email}.`)
  }
} finally {
  await payload.destroy()
}
