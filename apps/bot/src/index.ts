import type { Env } from './env.ts'
import { Hono } from 'hono'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { registerApiRoutes } from './routes/index.ts'
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

app.onError((error, c) => {
  console.error('[bot:unhandled]', c.req.method, new URL(c.req.url).pathname, error)
  return c.json({ error: 'Internal Server Error' }, 500)
})

registerApiRoutes(app)

app.mount('/', discordApp.fetch)

const worker: ExportedHandler<Env['Bindings']> = {
  async fetch(request, env, ctx) {
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

function normalizeAllowedGuildId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}
