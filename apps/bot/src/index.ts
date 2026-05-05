import type { Env } from './env.ts'
import { Hono } from 'hono'
import { routePartykitRequest } from 'partyserver'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { registerApiRoutes } from './routes/index.ts'
import { Activity } from './session-runtime/activity-feed.ts'
import { SessionDO } from './session-runtime/session-do.ts'
import { factory } from './setup.ts'

interface DiscordInteractionEnvelope {
  type?: number
  guild_id?: string | null
}

const DISCORD_PING_INTERACTION_TYPE = 1
const DISCORD_CHANNEL_MESSAGE_WITH_SOURCE = 4
const DISCORD_EPHEMERAL_MESSAGE_FLAG = 1 << 6

const discordApp = factory.discord().loader([
  ...Object.values(commands),
  ...Object.values(cron),
])

const app = new Hono<Env>()

export { Activity, SessionDO }

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

    const disallowedGuildResponse = await rejectDisallowedDiscordGuildInteraction(request, env)
    if (disallowedGuildResponse) return disallowedGuildResponse
    return app.fetch(request, env, ctx)
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

async function rejectDisallowedDiscordGuildInteraction(request: Request, env: Env['Bindings']): Promise<Response | null> {
  const allowedGuildId = normalizeAllowedGuildId(env.ALLOWED_DISCORD_GUILD_ID)
  if (!allowedGuildId || !isDiscordInteractionRequest(request)) return null

  let interaction: DiscordInteractionEnvelope
  try {
    interaction = await request.clone().json<DiscordInteractionEnvelope>()
  }
  catch {
    return null
  }

  if (interaction.type === DISCORD_PING_INTERACTION_TYPE) return null
  if (typeof interaction.guild_id === 'string' && interaction.guild_id === allowedGuildId) return null

  return new Response(JSON.stringify({
    type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: DISCORD_EPHEMERAL_MESSAGE_FLAG,
      content: 'This bot is only available in the configured Discord server.',
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function isDiscordInteractionRequest(request: Request): boolean {
  const url = new URL(request.url)
  return request.method.toUpperCase() === 'POST'
    && !url.pathname.startsWith('/api/')
    && request.headers.has('X-Signature-Ed25519')
    && request.headers.has('X-Signature-Timestamp')
}

function getBotPartyNamespace(request: Request): 'session' | 'activity' | null {
  const pathname = new URL(request.url).pathname
  if (pathname === '/parties/session' || pathname.startsWith('/parties/session/')) return 'session'
  if (pathname === '/parties/activity' || pathname.startsWith('/parties/activity/')) return 'activity'
  return null
}

function normalizeAllowedGuildId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}
