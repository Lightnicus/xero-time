import { config as loadEnvironment } from 'dotenv'

import { verifyApplicationIndexes } from '@/lib/deployment/verify-indexes'

loadEnvironment({ quiet: true })

const [{ getPayload }, { default: config }] = await Promise.all([
  import('payload'),
  import('../src/payload.config'),
])
const payload = await getPayload({ config })
let verificationError: unknown
try {
  await verifyApplicationIndexes(payload)
} catch (error) {
  verificationError = error
}

// The verifier is a short-lived, read-only command. Payload/Mongoose can keep
// monitoring handles alive after destroy on some Node versions, so initiate a
// graceful close and then return a deterministic command status.
void payload.destroy()
if (verificationError) {
  const message =
    verificationError instanceof Error ? verificationError.message : 'Index verification failed.'
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
process.exit(0)
