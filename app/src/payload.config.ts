import path from 'path'
import { fileURLToPath } from 'url'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { AuditEvents } from './collections/AuditEvents'
import { AuthIdentities } from './collections/AuthIdentities'
import { Customers } from './collections/Customers'
import { ExportBatches } from './collections/ExportBatches'
import { ExternalAuthSessions } from './collections/ExternalAuthSessions'
import { Invitations } from './collections/Invitations'
import { InvoiceExportEntries } from './collections/InvoiceExportEntries'
import { InvoiceExports } from './collections/InvoiceExports'
import { Projects } from './collections/Projects'
import { ReleaseActions } from './collections/ReleaseActions'
import { TimeEntries } from './collections/TimeEntries'
import { Users } from './collections/Users'
import { XeroAttempts } from './collections/XeroAttempts'
import { XeroConnections } from './collections/XeroConnections'
import { XeroContactOperations } from './collections/XeroContactOperations'
import { XeroOAuthStates } from './collections/XeroOAuthStates'
import { XeroReferenceData } from './collections/XeroReferenceData'
import { XeroWebhookReceipts } from './collections/XeroWebhookReceipts'
import { AuthenticationSettings } from './globals/AuthenticationSettings'
import { BillingSettings } from './globals/BillingSettings'
import { BusinessSettings } from './globals/BusinessSettings'
import { accountEmailAdapter } from './lib/account-email'
import { environment } from './lib/env'
import { jobsConfig } from './lib/jobs/config'
import { requireMongoModel } from './lib/payload/mongo'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    components: {
      graphics: {
        Icon: '/components/admin/ProjectTimeIcon',
        Logo: '/components/admin/ProjectTimeLogo',
      },
    },
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    meta: {
      titleSuffix: '— Project Time',
    },
  },
  collections: [
    Users,
    Invitations,
    AuthIdentities,
    ExternalAuthSessions,
    Customers,
    Projects,
    TimeEntries,
    XeroConnections,
    XeroOAuthStates,
    XeroReferenceData,
    ExportBatches,
    InvoiceExports,
    InvoiceExportEntries,
    XeroAttempts,
    XeroContactOperations,
    XeroWebhookReceipts,
    ReleaseActions,
    AuditEvents,
  ],
  cors: [environment.serverURL],
  csrf: [environment.serverURL],
  defaultDepth: 1,
  editor: lexicalEditor(),
  email: accountEmailAdapter,
  globals: [BusinessSettings, AuthenticationSettings, BillingSettings],
  graphQL: {
    disable: true,
  },
  maxDepth: 4,
  jobs: jobsConfig,
  onInit: async (payload) => {
    const oauthStateCollection = requireMongoModel(payload, 'xero-oauth-states').collection
    const externalSessionCollection = requireMongoModel(
      payload,
      'external-auth-sessions',
    ).collection
    const database = payload.db.connection.db
    if (!database) throw new Error('MongoDB is unavailable while configuring application indexes.')
    await Promise.all([
      requireMongoModel(payload, 'invitations').collection.createIndex(
        { email: 1 },
        { name: 'email_1', unique: true },
      ),
      requireMongoModel(payload, 'invitations').collection.createIndex(
        { tokenHash: 1 },
        { name: 'tokenHash_1', unique: true },
      ),
      requireMongoModel(payload, 'invitations').collection.createIndex(
        { cleanupAt: 1 },
        { expireAfterSeconds: 0, name: 'cleanupAt_1' },
      ),
      requireMongoModel(payload, 'xero-connections').collection.createIndex(
        { singletonKey: 1 },
        { name: 'singletonKey_1', unique: true },
      ),
      requireMongoModel(payload, 'xero-oauth-states').collection.createIndex(
        { stateHash: 1 },
        { name: 'stateHash_1', unique: true },
      ),
      externalSessionCollection.createIndex(
        { tokenHash: 1 },
        { name: 'tokenHash_1', unique: true },
      ),
      requireMongoModel(payload, 'invoice-exports').collection.createIndex(
        { xeroInvoiceId: 1 },
        {
          name: 'xeroInvoiceId_unique_when_present',
          partialFilterExpression: { xeroInvoiceId: { $type: 'string' } },
          unique: true,
        },
      ),
      database
        .collection('application_rate_limits')
        .createIndex({ cleanupAt: 1 }, { expireAfterSeconds: 0, name: 'cleanupAt_1' }),
      database
        .collection('application_owner_transition_locks')
        .updateOne(
          { _id: 'business-owner' as never },
          { $setOnInsert: { version: 0 }, $set: { updatedAt: new Date() } },
          { upsert: true },
        ),
      requireMongoModel(payload, 'users').updateMany(
        { _verified: { $exists: false } },
        { $set: { _verified: true } },
      ),
    ])

    const expiryIndex = (await oauthStateCollection.indexes()).find(
      (index) => Object.keys(index.key ?? {}).length === 1 && index.key?.expiresAt === 1,
    )
    if (!expiryIndex) {
      await oauthStateCollection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'expiresAt_1' },
      )
    } else if (expiryIndex.expireAfterSeconds !== 0) {
      const database = payload.db.connection.db
      if (!database) throw new Error('MongoDB is unavailable while configuring OAuth state expiry.')
      await database.command({
        collMod: oauthStateCollection.collectionName,
        index: { expireAfterSeconds: 0, name: expiryIndex.name },
      })
    }

    const externalSessionExpiryIndex = (await externalSessionCollection.indexes()).find(
      (index) => Object.keys(index.key ?? {}).length === 1 && index.key?.cleanupAt === 1,
    )
    if (!externalSessionExpiryIndex) {
      await externalSessionCollection.createIndex(
        { cleanupAt: 1 },
        { expireAfterSeconds: 0, name: 'cleanupAt_1' },
      )
    } else if (externalSessionExpiryIndex.expireAfterSeconds !== 0) {
      const database = payload.db.connection.db
      if (!database) {
        throw new Error('MongoDB is unavailable while configuring external-session expiry.')
      }
      await database.command({
        collMod: externalSessionCollection.collectionName,
        index: { expireAfterSeconds: 0, name: externalSessionExpiryIndex.name },
      })
    }
  },
  secret: environment.payloadSecret,
  serverURL: environment.serverURL,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: mongooseAdapter({
    connectOptions: {
      maxPoolSize: environment.mongoMaxPoolSize,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10_000,
    },
    ensureIndexes: process.env.NODE_ENV !== 'production',
    transactionOptions: {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    },
    url: environment.mongoURI,
  }),
  sharp,
  plugins: [],
})
