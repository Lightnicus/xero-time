import { readFile } from 'node:fs/promises'

import { config as loadEnvironment } from 'dotenv'

loadEnvironment({ quiet: true })

const packageDocument = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies: Record<string, string>
}

const payloadPackages = [
  'payload',
  '@payloadcms/db-mongodb',
  '@payloadcms/email-resend',
  '@payloadcms/next',
  '@payloadcms/richtext-lexical',
  '@payloadcms/ui',
]
const payloadVersions = new Set(payloadPackages.map((name) => packageDocument.dependencies[name]))
if (payloadVersions.size !== 1 || payloadVersions.has(undefined)) {
  throw new Error('All Payload packages must be pinned to the same exact version.')
}
for (const dependency of ['next', 'react', 'react-dom', 'sharp', ...payloadPackages]) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageDocument.dependencies[dependency] ?? '')) {
    throw new Error(`${dependency} must use an exact compatibility-tested version.`)
  }
}

const { default: sharp } = await import('sharp')
const sharpProbe = await sharp({
  create: {
    background: { alpha: 1, b: 0, g: 0, r: 0 },
    channels: 4,
    height: 1,
    width: 1,
  },
})
  .png()
  .toBuffer()
if (sharpProbe.length === 0) throw new Error('Sharp could not process an image.')

const { default: configPromise } = await import('../src/payload.config')
const config = await configPromise
const collectionSlugs = new Set<string>(config.collections.map((collection) => collection.slug))
const globalSlugs = new Set<string>(config.globals?.map((global) => global.slug) ?? [])
for (const slug of ['users', 'time-entries', 'invoice-exports', 'xero-connections']) {
  if (!collectionSlugs.has(slug)) throw new Error(`Payload collection ${slug} is unavailable.`)
}
for (const slug of ['authentication-settings', 'billing-settings', 'business-settings']) {
  if (!globalSlugs.has(slug)) throw new Error(`Payload global ${slug} is unavailable.`)
}
if (config.graphQL?.disable !== true) throw new Error('GraphQL must remain disabled.')

process.stdout.write(
  `Compatibility smoke passed for Payload ${[...payloadVersions][0]}, Next ${packageDocument.dependencies.next}, React ${packageDocument.dependencies.react}, and Sharp ${packageDocument.dependencies.sharp}.\n`,
)
