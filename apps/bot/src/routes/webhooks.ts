import type { DraftWebhookPayload } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb } from '@civup/db'
import { verifySignedWebhookRequest } from '@civup/utils'
import { lobbyComponents } from '../embeds/match.ts'
import { clearActivityMappings, clearLobbyMappings, storeUserLobbyState } from '../services/activity/index.ts'
import { buildLobbyImageMessage } from '../services/discord/lobby-card.ts'
import { buildOpenLobbyRenderPayload, clearLobbyById, getLobbyByMatch, getLobbyDraftRoster, mapLobbySlotsToEntries, reopenLobbyAfterCancelledDraft, reopenLobbyAfterTimedOutDraft, setLobbyStatus, upsertLobbyMessage } from '../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../services/lobby/live-snapshot.ts'
import { activateDraftMatch, cancelDraftMatch } from '../services/match/index.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from '../services/match/message.ts'
import { getQueueState, setQueueEntries } from '../services/queue/index.ts'
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
        if (isIgnorableDraftCompleteError(result.error)) {
          console.warn(`Ignoring stale draft-complete webhook for match ${payload.matchId}: ${result.error}`)
          return c.json({ ok: true, ignored: true })
        }
        return c.json({ error: result.error }, 400)
      }

      if (result.alreadyActive && payload.finalized !== true) {
        return c.json({ ok: true, synced: true })
      }

      const lobby = await getLobbyByMatch(kv, payload.matchId)
      if (!lobby) {
        console.warn(`No lobby mapping found for draft-complete match ${payload.matchId}`)
        return c.json({ ok: true })
      }

      const shouldRefreshEmbedOnly = result.alreadyActive && payload.finalized === true
      const activeLobby = shouldRefreshEmbedOnly
        ? lobby
        : await setLobbyStatus(kv, lobby.id, 'active', lobby) ?? lobby
      if (!shouldRefreshEmbedOnly) {
        await syncLobbyDerivedState(kv, activeLobby)
      }
      try {
        const renderPayload = await buildLobbyImageMessage({
          db,
          mode: lobby.mode,
          stage: 'draft-complete',
          participants: result.participants,
          leaderDataVersion: activeLobby.draftConfig.leaderDataVersion,
          redDeath: activeLobby.draftConfig.redDeath,
        })
        const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, activeLobby, {
          ...renderPayload,
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

    await clearActivityMappings(kv, payload.matchId, lobby.memberPlayerIds, lobby.channelId)

    if (payload.reason === 'timeout' || payload.reason === 'revert') {
      const queue = await getQueueState(kv, lobby.mode)
      const draftRoster = await getLobbyDraftRoster(kv, lobby.id)
      const recovered = payload.reason === 'timeout'
        ? await reopenLobbyAfterTimedOutDraft(kv, lobby, payload.state, { draftRoster })
        : await reopenLobbyAfterCancelledDraft(kv, lobby, payload.state, { draftRoster })

      if (recovered) {
        const affectedPlayerIds = new Set(lobby.memberPlayerIds)
        const nextQueueEntries = [
          ...queue.entries.filter(entry => !affectedPlayerIds.has(entry.playerId)),
          ...recovered.queueEntries,
        ]

        await setQueueEntries(kv, lobby.mode, nextQueueEntries, { currentState: queue })
        await syncLobbyDerivedState(kv, recovered.lobby, {
          queueEntries: recovered.queueEntries,
          slots: recovered.lobby.slots,
        })
        await storeUserLobbyState(kv, recovered.lobby.channelId, recovered.lobby.memberPlayerIds, recovered.lobby.id)

        try {
          const slottedEntries = mapLobbySlotsToEntries(recovered.lobby.slots, recovered.queueEntries)
          const renderPayload = await buildOpenLobbyRenderPayload(kv, recovered.lobby, slottedEntries)
          const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, recovered.lobby, renderPayload)
          await clearMatchMessageMapping(db, updatedLobby.messageId)
        }
        catch (error) {
          console.error(`Failed to update reopened lobby embed for cancelled match ${payload.matchId}:`, error)
        }

        return c.json({ ok: true })
      }
    }

    const closedLobby = await setLobbyStatus(kv, lobby.id, payload.reason === 'cancel' ? 'cancelled' : 'scrubbed', lobby) ?? lobby
    try {
      const renderPayload = await buildLobbyImageMessage({
        db,
        mode: lobby.mode,
        stage: payload.reason === 'cancel' ? 'cancelled' : 'scrubbed',
        participants: cancelled.participants,
        leaderDataVersion: closedLobby.draftConfig.leaderDataVersion,
        redDeath: closedLobby.draftConfig.redDeath,
      })
      const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, closedLobby, {
        ...renderPayload,
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

function isIgnorableDraftCompleteError(error: string): boolean {
  return error.includes('cannot be activated (status: cancelled)')
    || error.includes('cannot be activated (status: completed)')
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
    if (payload.reason !== 'cancel' && payload.reason !== 'scrub' && payload.reason !== 'timeout' && payload.reason !== 'revert') return false
    return payload.state.status === 'cancelled'
  }

  return false
}
