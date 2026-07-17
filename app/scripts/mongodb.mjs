#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const host = 'localhost'
const port = 27018
const replicaSet = 'xero_time_rs0'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(scriptDirectory, '..')
const runtimeDirectory = path.join(projectDirectory, '.local', 'mongodb')
const dataDirectory = path.join(runtimeDirectory, 'data')
const logDirectory = path.join(runtimeDirectory, 'log')
const runDirectory = path.join(runtimeDirectory, 'run')
const logFile = path.join(logDirectory, 'mongod.log')
const pidFile = path.join(runDirectory, 'mongod.pid')
const lockFile = path.join(runDirectory, 'operation.lock')
const ensureReplicaSetScript = path.join(scriptDirectory, 'mongodb', 'ensure-replica-set.js')
const adminUri = `mongodb://${host}:${port}/admin?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000`

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function fail(message) {
  throw new Error(message)
}

function run(command, args, timeout = 15_000) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout,
  })
}

function requireBinary(command) {
  const result = run(command, ['--version'])

  if (result.error?.code === 'ENOENT') {
    fail(`${command} is required but was not found on PATH.`)
  }

  if (result.error || result.status !== 0) {
    fail(`${command} is installed but could not be executed.`)
  }
}

async function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })

    const finish = (openState) => {
      socket.destroy()
      resolve(openState)
    }

    socket.setTimeout(750)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

async function waitForPort(expectedOpenState, timeout = 15_000) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if ((await isPortOpen()) === expectedOpenState) return true
    await delay(250)
  }

  return false
}

async function readPid() {
  try {
    const value = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function isProcessRunning(pid) {
  if (!pid) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function processCommand(pid) {
  const result = run('ps', ['-p', String(pid), '-ww', '-o', 'command='])
  return result.status === 0 ? result.stdout.trim() : ''
}

function isExpectedProcess(pid) {
  const command = processCommand(pid)

  return (
    command.includes('mongod') &&
    command.includes(dataDirectory) &&
    command.includes(`--port ${port}`) &&
    command.includes(`--replSet ${replicaSet}`)
  )
}

function parseInspectionOutput(output) {
  const candidate = output
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'))

  if (!candidate) fail('MongoDB returned no readable inspection result.')

  try {
    return JSON.parse(candidate)
  } catch {
    fail('MongoDB returned an invalid inspection result.')
  }
}

function inspectMongo() {
  const expression = [
    'const hello = db.adminCommand({ hello: 1 })',
    'const options = db.adminCommand({ getCmdLineOpts: 1 })',
    'print(JSON.stringify({ hello, options }))',
  ].join('; ')
  const result = run('mongosh', [adminUri, '--quiet', '--eval', expression])

  if (result.error || result.status !== 0) {
    fail('Port 27018 is open, but it is not a readable MongoDB instance. Refusing to modify it.')
  }

  return parseInspectionOutput(result.stdout)
}

function assertExpectedInstance(inspection) {
  const configuredPath = inspection.options?.parsed?.storage?.dbPath
  const configuredPort = inspection.options?.parsed?.net?.port
  const configuredSet =
    inspection.hello?.setName ??
    inspection.options?.parsed?.replication?.replSetName ??
    inspection.options?.parsed?.replication?.replSet

  if (!configuredPath || path.resolve(configuredPath) !== dataDirectory) {
    fail(
      'Port 27018 belongs to a MongoDB instance with a different data directory. Refusing to use it.',
    )
  }

  if (Number(configuredPort) !== port) {
    fail('The MongoDB process does not report the expected port. Refusing to use it.')
  }

  if (configuredSet !== replicaSet) {
    fail(`The MongoDB process does not use replica set ${replicaSet}. Refusing to use it.`)
  }
}

async function ensureDirectories() {
  await mkdir(dataDirectory, { mode: 0o700, recursive: true })
  await mkdir(logDirectory, { mode: 0o700, recursive: true })
  await mkdir(runDirectory, { mode: 0o700, recursive: true })
}

async function acquireLock() {
  await ensureDirectories()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(
        lockFile,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      )
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()

      return async () => rm(lockFile, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      let owner = null
      try {
        owner = Number.parseInt((await readFile(lockFile, 'utf8')).trim(), 10)
      } catch {
        fail(
          `Database operation lock exists at ${lockFile}; remove it only after confirming no setup command is running.`,
        )
      }

      if (Number.isSafeInteger(owner) && isProcessRunning(owner)) {
        fail(`Another database setup command is already running with PID ${owner}.`)
      }

      await rm(lockFile, { force: true })
    }
  }

  fail('Could not acquire the database operation lock.')
}

async function initializeReplicaSet() {
  const result = run('mongosh', [adminUri, '--quiet', '--file', ensureReplicaSetScript], 45_000)

  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`Could not initialize the local replica set.${details ? `\n${details}` : ''}`)
  }
}

async function logTail() {
  try {
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n')
    return lines.slice(-20).join('\n')
  } catch {
    return '(MongoDB log is not available.)'
  }
}

async function start() {
  requireBinary('mongod')
  requireBinary('mongosh')

  const releaseLock = await acquireLock()

  try {
    if (await isPortOpen()) {
      const inspection = inspectMongo()
      assertExpectedInstance(inspection)
      await initializeReplicaSet()
      console.log(`MongoDB is already running as ${replicaSet} on ${host}:${port}.`)
      return
    }

    const existingPid = await readPid()
    if (existingPid && isProcessRunning(existingPid)) {
      fail(
        `PID ${existingPid} is running but MongoDB is not reachable on port ${port}. Refusing to start another process.`,
      )
    }
    if (existingPid) await rm(pidFile, { force: true })

    const result = run(
      'mongod',
      [
        '--port',
        String(port),
        '--bind_ip',
        host,
        '--dbpath',
        dataDirectory,
        '--replSet',
        replicaSet,
        '--logpath',
        logFile,
        '--logappend',
        '--pidfilepath',
        pidFile,
        '--fork',
      ],
      20_000,
    )

    if (result.error || result.status !== 0 || !(await waitForPort(true))) {
      fail(`MongoDB did not start successfully.\n${await logTail()}`)
    }

    const inspection = inspectMongo()
    assertExpectedInstance(inspection)
    await initializeReplicaSet()

    const ready = inspectMongo()
    assertExpectedInstance(ready)
    if (!ready.hello?.isWritablePrimary)
      fail('MongoDB started but did not become the writable primary.')

    console.log(`MongoDB is ready as ${replicaSet} on ${host}:${port}.`)
    console.log(`Data: ${dataDirectory}`)
    console.log(`Log:  ${logFile}`)
  } finally {
    await releaseLock()
  }
}

async function status() {
  requireBinary('mongosh')

  if (!(await isPortOpen())) {
    console.log(`MongoDB is stopped on ${host}:${port}.`)
    process.exitCode = 1
    return
  }

  const inspection = inspectMongo()
  assertExpectedInstance(inspection)

  console.log(`MongoDB is running on ${host}:${port}.`)
  console.log(`Replica set: ${inspection.hello.setName}`)
  console.log(`Writable primary: ${Boolean(inspection.hello.isWritablePrimary)}`)
  console.log(`Data: ${dataDirectory}`)
  console.log(`Log:  ${logFile}`)

  if (!inspection.hello.isWritablePrimary) process.exitCode = 2
}

async function stop() {
  requireBinary('mongosh')

  const releaseLock = await acquireLock()

  try {
    if (!(await isPortOpen())) {
      const stalePid = await readPid()
      if (stalePid && !isProcessRunning(stalePid)) await rm(pidFile, { force: true })
      console.log(`MongoDB is already stopped on ${host}:${port}.`)
      return
    }

    const inspection = inspectMongo()
    assertExpectedInstance(inspection)

    const pid = await readPid()
    if (!pid || !isProcessRunning(pid) || !isExpectedProcess(pid)) {
      fail(
        'The process on port 27018 could not be verified from the project PID file. Refusing to stop it.',
      )
    }

    run(
      'mongosh',
      [adminUri, '--quiet', '--eval', 'db.adminCommand({ shutdown: 1, timeoutSecs: 5 })'],
      10_000,
    )

    if (!(await waitForPort(false, 15_000))) {
      if (!isExpectedProcess(pid))
        fail('MongoDB did not stop and its process identity changed. Refusing to signal it.')
      process.kill(pid, 'SIGTERM')
    }

    if (!(await waitForPort(false, 10_000))) {
      fail(`MongoDB PID ${pid} is still running. Check ${logFile}; no force kill was attempted.`)
    }

    await rm(pidFile, { force: true })
    console.log(`MongoDB stopped cleanly on ${host}:${port}.`)
  } finally {
    await releaseLock()
  }
}

async function main() {
  const command = process.argv[2]

  if (command === 'start') return start()
  if (command === 'status') return status()
  if (command === 'stop') return stop()

  fail('Usage: node scripts/mongodb.mjs <start|status|stop>')
}

main().catch((error) => {
  console.error(`Database setup failed: ${error.message}`)
  process.exitCode = 1
})
