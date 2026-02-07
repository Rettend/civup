import type { Env } from './env.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { getMatchForChannel, getMatchForUser } from './services/activity.ts'
import { factory } from './setup.ts'

// Discord interaction handler
const discordApp = factory.discord().loader([
  ...Object.values(commands),
  ...Object.values(cron),
])

// Main Hono app with API routes
const app = new Hono<Env>()

// CORS for activity to call API
app.use('/api/*', cors())

// Match lookup endpoint for activity
app.get('/api/match/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const matchId = await getMatchForChannel(c.env.KV, channelId)
  console.log(`[activity] match lookup channel=${channelId} match=${matchId ?? 'null'}`)

  if (!matchId) {
    return c.json({ error: 'No active match for this channel' }, 404)
  }

  return c.json({ matchId })
})

// Match lookup fallback by user (voice-channel launches use user context)
app.get('/api/match/user/:userId', async (c) => {
  const userId = c.req.param('userId')
  const matchId = await getMatchForUser(c.env.KV, userId)
  console.log(`[activity] match lookup user=${userId} match=${matchId ?? 'null'}`)

  if (!matchId) {
    return c.json({ error: 'No active match for this user' }, 404)
  }

  return c.json({ matchId })
})

// Mount Discord interactions at root (default path for discord-hono)
app.mount('/', discordApp.fetch)

export default app
