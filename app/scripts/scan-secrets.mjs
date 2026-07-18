import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const candidates = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
if (candidates.status !== 0) process.exit(candidates.status ?? 1)
const files = candidates.stdout.split('\0').filter((file) => file && existsSync(file))
const forbiddenFiles = files.filter((file) => {
  if (/(^|\/)\.env(?:\.[^/]+)*\.example$/.test(file) || /(^|\/)\.env\.example$/.test(file)) {
    return false
  }
  return /(^|\/)(\.env($|\.)|\.vercel\/|\.local\/)/.test(file)
})
if (forbiddenFiles.length > 0) {
  process.stderr.write(`Tracked secret/runtime files:\n${forbiddenFiles.join('\n')}\n`)
  process.exit(1)
}

const patterns = [
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  'xero_[A-Za-z0-9_-]{24,}',
  're_[A-Za-z0-9_-]{24,}',
]
const scannerPattern = new RegExp(patterns.join('|'))
const canary = ['re', 'deliberate_canary_0123456789abcdef'].join('_')
if (!scannerPattern.test(canary)) {
  throw new Error('Secret-scanner canary was not detected.')
}

const findings = []
for (const file of files) {
  const contents = readFileSync(file, 'utf8')
  const match = scannerPattern.exec(contents)
  if (!match) continue
  const line = contents.slice(0, match.index).split(/\r?\n/).length
  findings.push(`${file}:${line}`)
}
if (findings.length > 0) {
  process.stderr.write(`Potential credential material found:\n${findings.join('\n')}\n`)
  process.exit(1)
}
