import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

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
const scan = spawnSync('rg', ['-n', '--pcre2', '-e', patterns.join('|'), '--', ...files], {
  encoding: 'utf8',
})
if (scan.status === 0) {
  process.stderr.write(`Potential credential material found:\n${scan.stdout}`)
  process.exit(1)
}
if (scan.status !== 1) {
  if (scan.stderr) process.stderr.write(scan.stderr)
  process.exit(scan.status ?? 1)
}
