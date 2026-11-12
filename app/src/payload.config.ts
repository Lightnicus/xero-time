import path from 'path'
import { fileURLToPath } from 'url'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'

import { AuditEvents } from './collections/AuditEvents'
import { Customers } from './collections/Customers'
import { ExportBatches } from './collections/ExportBatches'
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
  globals: [BusinessSettings, BillingSettings],
  graphQL: {
    disable: true,
  },
  maxDepth: 4,
  jobs: jobsConfig,
  onInit: async (payload) => {
    const oauthStateCollection = requireMongoModel(payload, 'xero-oauth-states').collection
    const database = payload.db.connection.db
    if (!database) throw new Error('MongoDB is unavailable while configuring application indexes.')
    await Promise.all([
      requireMongoModel(payload, 'xero-connections').collection.createIndex(
        { singletonKey: 1 },
        { name: 'singletonKey_1', unique: true },
      ),
      requireMongoModel(payload, 'xero-oauth-states').collection.createIndex(
        { stateHash: 1 },
        { name: 'stateHash_1', unique: true },
      ),
      requireMongoModel(payload, 'xero-contact-operations').collection.createIndex(
        { activeCustomerKey: 1 },
        {
          name: 'activeCustomerKey_unique_when_present',
          partialFilterExpression: { activeCustomerKey: { $type: 'string' } },
          unique: true,
        },
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
  plugins: [],
})
