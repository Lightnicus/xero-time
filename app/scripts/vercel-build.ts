import { spawnSync } from 'node:child_process'

import {
  executeVercelBuild,
  resolveVercelTargetEnvironment,
  type VercelBuildScript,
} from '../src/lib/deployment/vercel-build'

const runScript = (script: VercelBuildScript): number => {
  process.stdout.write(`[vercel-build] pnpm ${script}\n`)
  const result = spawnSync('pnpm', [script], {
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status === null) {
    throw new Error(
      `pnpm ${script} ended without an exit status${result.signal ? ` (${result.signal})` : ''}.`,
    )
  }
  return result.status
}

try {
  const environment = resolveVercelTargetEnvironment(
    process.env.VERCEL_TARGET_ENV,
    process.env.VERCEL_ENV,
  )
  process.exitCode = executeVercelBuild(environment, runScript)
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`[vercel-build] ${message}\n`)
  process.exitCode = 1
}
