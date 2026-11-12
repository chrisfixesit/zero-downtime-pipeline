import { createServer } from 'node:http'
import { createHandler } from './app.ts'
import { featureFlags } from './adapters/flags/index.ts'

const port = Number(process.env.PORT ?? 8080)
const version = process.env.VERSION ?? 'dev'

createServer(createHandler({ version, flags: featureFlags() })).listen(port, () => {
  console.log(JSON.stringify({ event: 'server.start', port, version }))
})
