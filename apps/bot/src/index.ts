import type { DraftCompleteWebhookPayload } from '@civup/game'
import type { Env } from './env.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import {
  getChannelForMatch,
  getMatchForChannel,
  getMatchForUser,
} from './services/activity.ts'
import { activateDraftMatch, reportMatch } from './services/match.ts'
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

  if (!matchId) {
    return c.json({ error: 'No active match for this channel' }, 404)
  }

  return c.json({ matchId })
})

// Match lookup fallback by user (voice-channel launches use user context)
app.get('/api/match/user/:userId', async (c) => {
  const userId = c.req.param('userId')
  const matchId = await getMatchForUser(c.env.KV, userId)

  if (!matchId) {
    return c.json({ error: 'No active match for this user' }, 404)
  }

  return c.json({ matchId })
})

// Full match state (used by activity post-draft screen)
app.get('/api/match/state/:matchId', async (c) => {
  const matchId = c.req.param('matchId')
  const db = createDb(c.env.DB)

  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match) {
    return c.json({ error: 'Match not found' }, 404)
  }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return c.json({ match, participants })
})

// Report result from activity
app.post('/api/match/:matchId/report', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  }
  catch {
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const { reporterId, placements } = body as { reporterId?: string, placements?: string }
  if (typeof reporterId !== 'string' || typeof placements !== 'string') {
    return c.json({ error: 'reporterId and placements are required strings' }, 400)
  }

  const db = createDb(c.env.DB)
  const result = await reportMatch(db, c.env.KV, {
    matchId: c.req.param('matchId'),
    reporterId,
    placements,
  })

  if ('error' in result) {
    return c.json({ error: result.error }, 400)
  }

  return c.json({ ok: true, match: result.match, participants: result.participants })
})

// Webhook from PartyKit when draft reaches COMPLETE
app.post('/api/webhooks/draft-complete', async (c) => {
  const expectedSecret = c.env.DRAFT_WEBHOOK_SECRET
  if (expectedSecret) {
    const providedSecret = c.req.header('X-CivUp-Webhook-Secret')
    if (providedSecret !== expectedSecret) {
      return c.json({ error: 'Unauthorized webhook' }, 401)
    }
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  }
  catch {
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  if (!isDraftCompletePayload(payload)) {
    return c.json({ error: 'Invalid draft completion payload' }, 400)
  }

  console.log(`Received draft-complete webhook for match ${payload.matchId}`)

  const db = createDb(c.env.DB)
  const result = await activateDraftMatch(db, {
    state: payload.state,
    completedAt: payload.completedAt,
  })

  if ('error' in result) {
    return c.json({ error: result.error }, 400)
  }

  const channelId = await getChannelForMatch(c.env.KV, payload.matchId)
  if (channelId) {
    await postDraftCompleteEmbed(c.env.DISCORD_TOKEN, channelId, payload.matchId, result.participants)
  }

  return c.json({ ok: true })
})

// Mount Discord interactions at root (default path for discord-hono)
app.mount('/', discordApp.fetch)

export default app

function isDraftCompletePayload(value: unknown): value is DraftCompleteWebhookPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<DraftCompleteWebhookPayload>
  if (typeof payload.matchId !== 'string' || typeof payload.completedAt !== 'number') return false
  if (!payload.state || typeof payload.state !== 'object') return false
  return payload.state.status === 'complete'
}

async function postDraftCompleteEmbed(
  token: string,
  channelId: string,
  matchId: string,
  participants: {
    playerId: string
    team: number | null
    civId: string | null
  }[],
): Promise<void> {
  const hasTeams = participants.some(p => p.team !== null)

  const fields = hasTeams
    ? [0, 1]
        .map((team) => {
          const teamParticipants = participants.filter(p => p.team === team)
          if (teamParticipants.length === 0) return null
          return {
            name: team === 0 ? 'Team A' : 'Team B',
            value: teamParticipants.map(p => `<@${p.playerId}> — ${p.civId ?? 'TBD'}`).join('\n'),
            inline: true,
          }
        })
        .filter(field => field !== null)
    : [{
        name: 'Players',
        value: participants.map(p => `<@${p.playerId}> — ${p.civId ?? 'TBD'}`).join('\n'),
        inline: false,
      }]

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: `🎯 Draft complete for match **${matchId}**. Keep the activity open and report the winner there when the game ends.`,
      embeds: [{
        title: `Draft Complete — Match ${matchId}`,
        description: 'Match status changed to **active**. Civ assignments are locked in.',
        color: 0x22C55E,
        fields,
        timestamp: new Date().toISOString(),
      }],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    console.error(`Failed to post draft-complete embed for match ${matchId}: ${response.status} ${detail}`)
  }
}
