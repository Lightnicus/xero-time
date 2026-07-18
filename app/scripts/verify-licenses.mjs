import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const application = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
if (application.license !== 'UNLICENSED')
  throw new Error('Application license policy changed unexpectedly.')

const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8' })
if (result.status !== 0) process.exit(result.status ?? 1)
const licenses = JSON.parse(result.stdout)
const forbidden = Object.keys(licenses).filter((license) =>
  /(^|\W)(AGPL|GPL|SSPL|BUSL)(\W|$)/i.test(license),
)
if (forbidden.length > 0) {
  throw new Error(`Production dependencies require license review: ${forbidden.join(', ')}`)
}
