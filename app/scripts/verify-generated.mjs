import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const generatedFiles = ['src/payload-types.ts', 'src/app/(payload)/admin/importMap.js']

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const before = new Map(generatedFiles.map((file) => [file, readFileSync(file, 'utf8')]))

run('pnpm', ['generate:types'])
run('pnpm', ['generate:importmap'])

const changed = generatedFiles.filter((file) => readFileSync(file, 'utf8') !== before.get(file))
if (changed.length > 0) {
  process.stderr.write(
    `Generated Payload artifacts were stale and have been refreshed:\n${changed.join('\n')}\n`,
  )
  process.exit(1)
}
