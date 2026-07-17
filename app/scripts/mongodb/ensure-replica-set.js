const expectedSetName = 'xero_time_rs0'
const expectedHost = 'localhost:27018'

let config

try {
  config = rs.conf()
} catch (error) {
  if (error.code !== 94 && error.codeName !== 'NotYetInitialized') throw error

  const result = rs.initiate({
    _id: expectedSetName,
    members: [{ _id: 0, host: expectedHost }],
  })

  if (!result.ok) throw new Error(`rs.initiate failed: ${JSON.stringify(result)}`)
  config = rs.conf()
}

if (config._id !== expectedSetName) {
  throw new Error(`Expected replica set ${expectedSetName}, found ${config._id}`)
}

if (
  config.members.length !== 1 ||
  config.members[0]._id !== 0 ||
  config.members[0].host !== expectedHost
) {
  throw new Error(`Unexpected replica-set members: ${JSON.stringify(config.members)}`)
}

const deadline = Date.now() + 30_000

while (Date.now() < deadline) {
  if (db.hello().isWritablePrimary) {
    print(`Replica set ${expectedSetName} is writable.`)
    quit(0)
  }

  sleep(250)
}

throw new Error(`Replica set ${expectedSetName} did not become writable within 30 seconds.`)
