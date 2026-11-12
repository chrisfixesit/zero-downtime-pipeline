import { createServer } from 'node:http'
import { createHandler } from './app.ts'
import { featureFlags } from './adapters/flags/index.ts'

const port = Number(process.env.PORT ?? 8080)
const version = process.env.VERSION ?? 'dev'

const server = createServer(createHandler({ version, flags: featureFlags() }))

server.listen(port, () => {
  console.log(JSON.stringify({ event: 'server.start', port, version }))
})

// Blue/green termination: let in-flight requests finish, then exit.
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ event: 'shutdown' }))
  server.close(() => process.exit(0))
})
