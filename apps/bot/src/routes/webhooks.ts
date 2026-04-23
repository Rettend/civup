import type { Context, Hono } from 'hono'
import type { ParsedDraftWebhookPayload } from '../services/match/draft-webhook-events.ts'
import type { Env } from '../env.ts'
import type { QueueEntry } from '@civup/game'
import type { LobbyState } from '../services/lobby/types.ts'
import { createDb } from '@civup/db'
import { verifySignedWebhookRequest } from '@civup/utils'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed } from '../embeds/match.ts'
import { clearActivityMappings, clearLobbyMappings, storeUserLobbyState } from '../services/activity/index.ts'
import { buildOpenLobbyRenderPayload, clearLobbyById, commitLobbyState, getLobbyByMatch, getLobbyDraftRoster, mapLobbySlotsToEntries, reopenLobbyAfterCancelledDraft, reopenLobbyAfterTimedOutDraft, setLobbyStatus, upsertLobbyMessage } from '../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../services/lobby/live-snapshot.ts'
import { claimDraftWebhookEvent, markDraftWebhookEventProcessed, parseDraftWebhookPayload, releaseDraftWebhookEventClaim } from '../services/match/draft-webhook-events.ts'
import { activateDraftMatch, cancelDraftMatch } from '../services/match/index.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from '../services/match/message.ts'
import { getQueueState, setQueueEntries } from '../services/queue/index.ts'
import { isSessionAdmissionError } from '../services/session/index.ts'
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

    let rawPayload: unknown
    try {
      rawPayload = JSON.parse(payloadText)
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    const payload = parseDraftWebhookPayload(rawPayload)
    if (!payload) {
      return c.json({ error: 'Invalid draft webhook payload' }, 400)
    }

    const webhookContext = buildDraftWebhookRouteContext(payload)
    console.log('[draft-webhook] received', webhookContext)

    const claimResult = await claimDraftWebhookEvent(c.env.DB, payload)
    if (claimResult === 'in-flight') {
      console.warn('[draft-webhook] ignoring in-flight replay', webhookContext)
      return c.json({ ok: true, pending: true })
    }
    if (claimResult === 'processed') {
      console.warn('[draft-webhook] replaying processed event for repair', webhookContext)
    }

    const db = createDb(c.env.DB)
    let response: Response

    try {
      response = payload.outcome === 'complete'
        ? await handleDraftCompleteWebhook(c, db, kv, payload, webhookContext)
        : await handleDraftCancelledWebhook(c, db, kv, payload, webhookContext)
    }
    catch (error) {
      if (claimResult === 'claimed') {
        await releaseDraftWebhookEventClaim(c.env.DB, payload.eventId)
      }
      throw error
    }

    if (response.status >= 400 && claimResult === 'claimed') {
      await releaseDraftWebhookEventClaim(c.env.DB, payload.eventId)
      return response
    }

    if (claimResult === 'claimed') {
      await markDraftWebhookEventProcessed(c.env.DB, payload.eventId)
    }
    return response
  })
}

function isIgnorableDraftCompleteError(error: string): boolean {
  return error.includes('cannot be activated (status: cancelled)')
    || error.includes('cannot be activated (status: completed)')
}

function isIgnorableDraftCancelError(error: string): boolean {
  return error.includes('cannot be cancelled (status: active)')
    || error.includes('cannot be cancelled (status: completed)')
}

function buildDraftWebhookRouteContext(payload: ParsedDraftWebhookPayload): Record<string, unknown> {
  return {
    eventId: payload.eventId,
    eventKind: payload.eventKind,
    eventSequence: payload.eventSequence,
    matchId: payload.matchId,
    outcome: payload.outcome,
    finalized: payload.outcome === 'complete' ? payload.finalized === true : false,
    stateStatus: payload.state.status,
    currentStepIndex: payload.state.currentStepIndex,
  }
}

async function handleDraftCompleteWebhook(
  c: Context<Env>,
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  payload: ParsedDraftWebhookPayload,
  webhookContext: Record<string, unknown>,
): Promise<Response> {
  if (payload.outcome !== 'complete') {
    return c.json({ error: 'Expected completion webhook payload' }, 400)
  }

  const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
  if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

  const result = await activateDraftMatch(db, {
    state: payload.state,
    completedAt: payload.completedAt,
    hostId,
    mapVoteResult: payload.mapVoteResult ?? null,
  })

  if ('error' in result) {
    if (isIgnorableDraftCompleteError(result.error)) {
      console.warn('[draft-webhook] ignoring stale completion', {
        ...webhookContext,
        error: result.error,
      })
      return c.json({ ok: true, ignored: true })
    }
    return c.json({ error: result.error }, 400)
  }

  if (result.alreadyActive && payload.finalized !== true) {
    return c.json({ ok: true, synced: true })
  }

  const lobby = await getLobbyByMatch(kv, payload.matchId)
  if (!lobby) {
    console.warn('[draft-webhook] no lobby mapping for completion', webhookContext)
    return c.json({ ok: true })
  }

  const shouldRefreshEmbedOnly = result.alreadyActive && payload.finalized === true
  const activeLobby = shouldRefreshEmbedOnly
    ? lobby
    : await setLobbyStatus(kv, lobby.id, 'active', lobby, { db, sessionNamespace: c.env.SessionDO }) ?? lobby
  if (!shouldRefreshEmbedOnly) {
    await syncLobbyDerivedState(kv, activeLobby)
  }
  try {
    const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, activeLobby, {
      embeds: [lobbyDraftCompleteEmbed(lobby.mode, result.participants, payload.mapVoteResult ?? null, activeLobby.draftConfig.leaderDataVersion, activeLobby.draftConfig.redDeath)],
      components: lobbyComponents(activeLobby.mode, activeLobby.id),
    })
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }
  catch (error) {
    console.error('[draft-webhook] failed to update completion embed', webhookContext, error)
  }

  return c.json({ ok: true })
}

async function handleDraftCancelledWebhook(
  c: Context<Env>,
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  payload: ParsedDraftWebhookPayload,
  webhookContext: Record<string, unknown>,
): Promise<Response> {
  if (payload.outcome !== 'cancelled') {
    return c.json({ error: 'Expected cancellation webhook payload' }, 400)
  }

  const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
  if (!hostId) return c.json({ error: 'Draft webhook missing host identity' }, 400)

  const fallbackLobby = await getLobbyByMatch(kv, payload.matchId)

  const cancelled = await cancelDraftMatch(db, kv, {
    state: payload.state,
    cancelledAt: payload.cancelledAt,
    reason: payload.reason,
    hostId,
    mapVoteResult: payload.mapVoteResult ?? null,
  })

  if ('error' in cancelled) {
    if (isIgnorableDraftCancelError(cancelled.error)) {
      console.warn('[draft-webhook] ignoring stale cancellation', {
        ...webhookContext,
        error: cancelled.error,
      })
      return c.json({ ok: true, ignored: true })
    }
    return c.json({ error: cancelled.error }, 400)
  }

  const lobby = await getLobbyByMatch(kv, payload.matchId) ?? fallbackLobby
  if (!lobby) {
    console.warn('[draft-webhook] no lobby mapping for cancellation', webhookContext)
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
      await commitRecoveredLobbySession(kv, db, c.env.SessionDO, recovered.lobby, recovered.queueEntries, webhookContext)

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
        console.error('[draft-webhook] failed to update reopened lobby embed', webhookContext, error)
      }

      return c.json({ ok: true })
    }
  }

  const closedLobby = await setLobbyStatus(kv, lobby.id, payload.reason === 'cancel' ? 'cancelled' : 'scrubbed', lobby, { db, sessionNamespace: c.env.SessionDO }) ?? lobby
  try {
    const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, closedLobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, cancelled.participants, payload.reason, undefined, closedLobby.draftConfig.leaderDataVersion, closedLobby.draftConfig.redDeath)],
      components: [],
    })
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }
  catch (error) {
    console.error('[draft-webhook] failed to update cancelled embed', webhookContext, error)
  }

  await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId, lobby.id)
  await clearLobbyById(kv, lobby.id, lobby)
  return c.json({ ok: true })
}

async function commitRecoveredLobbySession(
  kv: KVNamespace,
  db: ReturnType<typeof createDb>,
  sessionNamespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[],
  webhookContext: Record<string, unknown>,
): Promise<void> {
  try {
    await commitLobbyState(kv, lobby, { db, sessionNamespace, queueEntries })
  }
  catch (error) {
    if (!isSessionAdmissionError(error)) throw error
    console.warn('[draft-webhook] skipped reopened lobby session projection after live membership conflict', {
      ...webhookContext,
      lobbyId: lobby.id,
      playerIds: error.playerIds,
    })
  }
}
