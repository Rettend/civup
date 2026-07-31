import type { Env } from './env.ts'
import { Hono } from 'hono'
import { routePartykitRequest } from 'partyserver'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { createDiscordApp } from './discord-app.ts'
import { registerApiRoutes } from './routes/index.ts'
import { MaintenanceDO } from './maintenance/maintenance-do.ts'
import { Activity } from './session-runtime/activity-feed.ts'
import { SessionDO } from './session-runtime/session-do.ts'

const discordApp = createDiscordApp([
  ...Object.values(commands),
  ...Object.values(cron),
])

const app = new Hono<Env>()

export { Activity, MaintenanceDO, SessionDO }

app.onError((error, c) => {
  console.error('[bot:unhandled]', c.req.method, new URL(c.req.url).pathname, error)
  return c.json({ error: 'Internal Server Error' }, 500)
})

registerApiRoutes(app)

app.mount('/', discordApp.fetch)

const worker: ExportedHandler<Env['Bindings']> = {
  async fetch(request, env, ctx) {
    const partyResponse = await handleBotPartyRequest(request, env)
    if (partyResponse) return partyResponse

    return app.fetch(request, { ...env, CIVUP_INTERACTION_ENDPOINT_URL: request.url }, ctx)
  },
  scheduled(controller, env, ctx) {
    const cronEvent = {
      ...controller,
      type: 'scheduled',
    } as Parameters<typeof discordApp.scheduled>[0]
    return discordApp.scheduled(cronEvent, env, ctx)
  },
}

export default worker

async function handleBotPartyRequest(request: Request, env: Env['Bindings']): Promise<Response | null> {
  const partyNamespace = getBotPartyNamespace(request)
  if (!partyNamespace) return null
  if (partyNamespace === 'session') return routeSessionPartyRequest(request, env)
  if (partyNamespace === 'activity' && !env.Activity) return new Response('Activity feed is not configured', { status: 503 })

  return routePartykitRequest(request, env, { prefix: 'parties' })
}

async function routeSessionPartyRequest(request: Request, env: Env['Bindings']): Promise<Response> {
  if (!env.SessionDO) return new Response('Session runtime is not configured', { status: 503 })
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  const sessionId = parts[2]
  if (!sessionId) return new Response('Missing session id', { status: 400 })

  const stub = env.SessionDO.get(env.SessionDO.idFromName(sessionId))
  return stub.fetch(request)
}

function getBotPartyNamespace(request: Request): 'session' | 'activity' | null {
  const pathname = new URL(request.url).pathname
  if (pathname === '/parties/session' || pathname.startsWith('/parties/session/')) return 'session'
  if (pathname === '/parties/activity' || pathname.startsWith('/parties/activity/')) return 'activity'
  return null
}
