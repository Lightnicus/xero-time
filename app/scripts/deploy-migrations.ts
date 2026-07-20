import { randomUUID } from 'node:crypto'

import { config as loadEnvironment } from 'dotenv'

import {
  mongoDeploymentMigrationLeaseStore,
  withDeploymentMigrationLease,
} from '../src/lib/deployment/migration-lock'
import { verifyApplicationIndexes } from '../src/lib/deployment/verify-indexes'

import type { Migration } from 'payload'

loadEnvironment({ quiet: true })
process.env.PAYLOAD_MIGRATING = 'true'

const [{ getPayload }, { default: config }, { migrations }] = await Promise.all([
  import('payload'),
  import('../src/payload.config'),
  import('../src/migrations'),
])

const payload = await getPayload({ config, disableOnInit: true })
try {
  const database = payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable for production migrations.')

  const deployment =
    process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'
  const owner = `${deployment}:${randomUUID()}`
  await withDeploymentMigrationLease(
    mongoDeploymentMigrationLeaseStore(database),
    { owner },
    async () => {
      payload.logger.info({ event: 'database.production-migration-started' })
      await payload.db.migrate({ migrations: migrations as unknown as Migration[] })
      await verifyApplicationIndexes(payload)
      payload.logger.info({ event: 'database.production-migration-completed' })
    },
  )
} finally {
  await payload.destroy()
}
