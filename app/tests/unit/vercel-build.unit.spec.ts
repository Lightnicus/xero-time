import { describe, expect, it, vi } from 'vitest'

import {
  executeVercelBuild,
  resolveVercelTargetEnvironment,
  vercelBuildScripts,
  type VercelBuildScript,
} from '@/lib/deployment/vercel-build'

describe('Vercel build orchestration', () => {
  it('migrates and verifies indexes before a production build', () => {
    expect(vercelBuildScripts('production')).toEqual(['migrate:deploy', 'build'])
  })

  it.each(['preview', 'development', 'staging'])(
    'only builds in the %s environment',
    (environment) => {
      expect(vercelBuildScripts(environment)).toEqual(['build'])
    },
  )

  it('prefers the target environment and falls back to the legacy environment value', () => {
    expect(resolveVercelTargetEnvironment('staging', 'preview')).toBe('staging')
    expect(resolveVercelTargetEnvironment(undefined, 'production')).toBe('production')
  })

  it('fails closed when Vercel does not identify the environment', () => {
    expect(() => resolveVercelTargetEnvironment(undefined, undefined)).toThrow(
      /did not identify the target environment/,
    )
    expect(() => vercelBuildScripts(undefined)).toThrow(/target environment is unavailable/)
  })

  it('stops before the build when deployment migration fails', () => {
    const runScript = vi.fn<(script: VercelBuildScript) => number>().mockReturnValueOnce(7)

    expect(executeVercelBuild('production', runScript)).toBe(7)
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(runScript).toHaveBeenCalledWith('migrate:deploy')
  })
})
