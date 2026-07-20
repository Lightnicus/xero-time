export type VercelBuildScript = 'build' | 'migrate:deploy'

export const resolveVercelTargetEnvironment = (
  targetEnvironment: string | undefined,
  environment: string | undefined,
): string => {
  const resolved = targetEnvironment?.trim() || environment?.trim()
  if (!resolved) {
    throw new Error(
      'Vercel did not identify the target environment. Refusing to guess whether production migrations should run.',
    )
  }
  return resolved
}

export const vercelBuildScripts = (
  environment: string | undefined,
): readonly VercelBuildScript[] => {
  if (!environment) throw new Error('The resolved Vercel target environment is unavailable.')
  return environment === 'production' ? ['migrate:deploy', 'build'] : ['build']
}

export const executeVercelBuild = (
  environment: string | undefined,
  runScript: (script: VercelBuildScript) => number,
): number => {
  for (const script of vercelBuildScripts(environment)) {
    const exitCode = runScript(script)
    if (exitCode !== 0) return exitCode
  }
  return 0
}
