import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FeatureFlags } from './core/ports/FeatureFlags.ts'

export interface HandlerOptions {
  version: string
  flags: FeatureFlags
  startedAt?: number
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Stand-in service. A project that copies this template replaces this file
// with its own app; the delivery pipeline only needs GET /healthz to return 200
// and GET / to report the deployed version.
export function createHandler(opts: HandlerOptions) {
  const startedAt = opts.startedAt ?? Date.now()

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (req.method === 'GET' && path === '/healthz') {
      return send(res, 200, { status: 'ok', version: opts.version })
    }
    if (req.method === 'GET' && path === '/') {
      return send(res, 200, {
        service: 'zero-downtime-pipeline',
        version: opts.version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      })
    }
    // Alarm drill: while the flag is on, this endpoint fails on purpose so the
    // rollback alarm can be exercised end to end.
    if (req.method === 'GET' && path === '/drill/alarm' && (await opts.flags.isEnabled('alarmDrill'))) {
      return send(res, 500, { error: 'alarm drill' })
    }
    send(res, 404, { error: 'not found' })
  }
}
