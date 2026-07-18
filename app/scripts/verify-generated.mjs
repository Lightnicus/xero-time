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
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const file of changed) {
      const committedLines = before.get(file).split(/\r?\n/)
      const generatedLines = readFileSync(file, 'utf8').split(/\r?\n/)
      const lineIndex = committedLines.findIndex((line, index) => line !== generatedLines[index])
      const line =
        lineIndex === -1 ? Math.min(committedLines.length, generatedLines.length) : lineIndex
      const detail = [
        `committed: ${committedLines[line] ?? '<end of file>'}`,
        `generated: ${generatedLines[line] ?? '<end of file>'}`,
      ]
        .join(' | ')
        .replaceAll('%', '%25')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A')

      process.stdout.write(
        `::error file=${file},line=${line + 1},title=Generated artifact is stale::${detail}\n`,
      )
    }
  }

  process.stderr.write(
    `Generated Payload artifacts were stale and have been refreshed:\n${changed.join('\n')}\n`,
  )
  process.exit(1)
}
