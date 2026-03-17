import type { DraftWebhookPayload } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb } from '@civup/db'
import { verifySignedWebhookRequest } from '@civup/utils'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed } from '../embeds/match.ts'
import { clearLobbyMappings } from '../services/activity/index.ts'
import { clearLobbyById, getLobbyByMatch, setLobbyStatus, upsertLobbyMessage } from '../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../services/lobby/live-snapshot.ts'
import { activateDraftMatch, cancelDraftMatch } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { createStateStore } from '../services/state/store.ts'

export function registerWebhookRoutes(app: Hono<Env>) {
  app.post('/api/webhooks/draft-complete', async (c) => {
    const kv = createStateStore(c.env)
    const expectedSecret = c.env.CIVUP_SECRET?.trim() ?? ''
    if (expectedSecret.length === 0) {
      return c.json({ error: 'Webhook auth is not configured' }, 503)
    }

    const payloadText = await c.req.text()
    if (!(await verifySignedWebhookRequest(c.req.raw.headers, expectedSecret, payloadText))) {
      return c.json({ error: 'Unauthorized webhook' }, 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(payloadText)
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!isDraftWebhookPayload(payload)) {
      return c.json({ error: 'Invalid draft webhook payload' }, 400)
    }

    console.log(`Received draft webhook (${payload.outcome}) for match ${payload.matchId}`)

    const db = createDb(c.env.DB)

    if (payload.outcome === 'complete') {
      const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
      if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

      const result = await activateDraftMatch(db, {
        state: payload.state,
        completedAt: payload.completedAt,
        hostId,
      })

      if ('error' in result) {
        return c.json({ error: result.error }, 400)
      }

      const lobby = await getLobbyByMatch(kv, payload.matchId)
      if (!lobby) {
        console.warn(`No lobby mapping found for draft-complete match ${payload.matchId}`)
        return c.json({ ok: true })
      }

      const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', lobby) ?? lobby
      await syncLobbyDerivedState(kv, activeLobby)
      try {
        const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, activeLobby, {
          embeds: [lobbyDraftCompleteEmbed(lobby.mode, result.participants)],
          components: lobbyComponents(activeLobby.mode, activeLobby.id),
        })
        await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
      }
      catch (error) {
        console.error(`Failed to update draft-complete embed for match ${payload.matchId}:`, error)
      }

      return c.json({ ok: true })
    }

    const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
    if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

    const cancelled = await cancelDraftMatch(db, kv, {
      state: payload.state,
      cancelledAt: payload.cancelledAt,
      reason: payload.reason,
      hostId,
    })

    if ('error' in cancelled) {
      return c.json({ error: cancelled.error }, 400)
    }

    const lobby = await getLobbyByMatch(kv, payload.matchId)
    if (!lobby) {
      console.warn(`No lobby mapping found for cancelled match ${payload.matchId}`)
      return c.json({ ok: true })
    }

    await setLobbyStatus(kv, lobby.id, payload.reason === 'cancel' ? 'cancelled' : 'scrubbed', lobby)
    try {
      const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
        embeds: [lobbyCancelledEmbed(lobby.mode, cancelled.participants, payload.reason)],
        components: [],
      })
      await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
    }
    catch (error) {
      console.error(`Failed to update cancelled embed for match ${payload.matchId}:`, error)
    }

    await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
    await clearLobbyById(kv, lobby.id, lobby)
    return c.json({ ok: true })
  })
}

function isDraftWebhookPayload(value: unknown): value is DraftWebhookPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<DraftWebhookPayload> & {
    outcome?: unknown
    cancelledAt?: unknown
    reason?: unknown
  }

  if (typeof payload.matchId !== 'string') return false
  if (!payload.state || typeof payload.state !== 'object') return false

  if (payload.outcome === 'complete') {
    return typeof payload.completedAt === 'number' && payload.state.status === 'complete'
  }

  if (payload.outcome === 'cancelled') {
    if (typeof payload.cancelledAt !== 'number') return false
    if (payload.reason !== 'cancel' && payload.reason !== 'scrub' && payload.reason !== 'timeout') return false
    return payload.state.status === 'cancelled'
  }

  return false
}
