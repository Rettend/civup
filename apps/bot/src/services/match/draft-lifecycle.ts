import type { Database } from '@civup/db'
import { createDb } from '@civup/db'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed } from '../../embeds/match.ts'
import type { DraftLifecyclePayload as DraftWebhookPayload } from '../../session-runtime/draft-lifecycle-events.ts'
import { buildLobbyStateFromSessionRecord, buildSessionRosterQueueEntries } from '../../session-runtime/session-record.ts'
import { runSessionDraftLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { buildOpenLobbyRenderPayload, clearLobbyById, getLobbyByMatch, mapLobbySlotsToEntries, upsertLobbyMessage } from '../lobby/index.ts'
import { syncLobbyDerivedState } from '../lobby/live-snapshot.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from './message.ts'
import { getQueueState, setQueueEntries } from '../queue/index.ts'
import { activateDraftMatch, cancelDraftMatch } from './draft.ts'

export interface DraftLifecycleEnv {
  DB: D1Database
  KV: KVNamespace
  DISCORD_TOKEN: string
  SessionDO?: DurableObjectNamespace | null
}

export type DraftLifecycleResult =
  | { ok: true, ignored?: boolean, synced?: boolean }
  | { ok: false, status: number, error: string }

export async function handleDraftLifecyclePayload(
  env: DraftLifecycleEnv,
  payload: DraftWebhookPayload,
): Promise<DraftLifecycleResult> {
  const db = createDb(env.DB)
  const context = buildDraftLifecycleContext(payload)
  console.log('[draft-lifecycle] received', context)

  if (payload.outcome === 'complete') return await handleDraftCompleted(env, db, payload, context)
  return await handleDraftCancelled(env, db, payload, context)
}

function buildDraftLifecycleContext(payload: DraftWebhookPayload): Record<string, unknown> {
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

async function handleDraftCompleted(
  env: DraftLifecycleEnv,
  db: Database,
  payload: Extract<DraftWebhookPayload, { outcome: 'complete' }>,
  context: Record<string, unknown>,
): Promise<DraftLifecycleResult> {
  const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
  if (!hostId) return { ok: false, status: 400, error: 'Draft lifecycle payload missing host identity' }

  const result = await activateDraftMatch(db, {
    state: payload.state,
    completedAt: payload.completedAt,
    hostId,
    mapVoteResult: payload.mapVoteResult ?? null,
  })

  if ('error' in result) {
    if (isIgnorableDraftCompleteError(result.error)) {
      console.warn('[draft-lifecycle] ignoring stale completion', { ...context, error: result.error })
      return { ok: true, ignored: true }
    }
    return { ok: false, status: 400, error: result.error }
  }

  const lifecycleType = payload.eventKind === 'SwapAccepted'
    ? 'swap-accepted'
    : payload.finalized === true
      ? 'draft-finalized'
      : 'draft-completed'
  const record = await runSessionDraftLifecycleCommand(env.SessionDO, payload.matchId, {
    type: lifecycleType,
    at: payload.completedAt,
  })

  if (result.alreadyActive && payload.finalized !== true) return { ok: true, synced: true }

  const lobby = await getLobbyByMatch(env.KV, payload.matchId)
  if (!lobby) {
    console.warn('[draft-lifecycle] no lobby mapping for completion', context)
    return { ok: true }
  }

  const activeLobby = buildLobbyStateFromSessionRecord(record, lobby)
  if (!result.alreadyActive) await syncLobbyDerivedState(env.KV, activeLobby)

  try {
    const updatedLobby = await upsertLobbyMessage(env.KV, env.DISCORD_TOKEN, activeLobby, {
      embeds: [lobbyDraftCompleteEmbed(lobby.mode, result.participants, payload.mapVoteResult ?? null, activeLobby.draftConfig.leaderDataVersion, activeLobby.draftConfig.redDeath)],
      components: lobbyComponents(activeLobby.mode, activeLobby.id),
    })
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }
  catch (error) {
    console.error('[draft-lifecycle] failed to update completion embed', context, error)
  }

  return { ok: true }
}

async function handleDraftCancelled(
  env: DraftLifecycleEnv,
  db: Database,
  payload: Extract<DraftWebhookPayload, { outcome: 'cancelled' }>,
  context: Record<string, unknown>,
): Promise<DraftLifecycleResult> {
  const hostId = payload.hostId ?? payload.state.seats[0]?.playerId
  if (!hostId) return { ok: false, status: 400, error: 'Draft lifecycle payload missing host identity' }

  const fallbackLobby = await getLobbyByMatch(env.KV, payload.matchId)
  const cancelled = await cancelDraftMatch(db, env.KV, {
    state: payload.state,
    cancelledAt: payload.cancelledAt,
    reason: payload.reason,
    hostId,
    mapVoteResult: payload.mapVoteResult ?? null,
  })

  if ('error' in cancelled) {
    if (isIgnorableDraftCancelError(cancelled.error)) {
      console.warn('[draft-lifecycle] ignoring stale cancellation', { ...context, error: cancelled.error })
      return { ok: true, ignored: true }
    }
    return { ok: false, status: 400, error: cancelled.error }
  }

  const record = await runSessionDraftLifecycleCommand(env.SessionDO, payload.matchId, {
    type: 'draft-cancelled',
    reason: payload.reason,
    at: payload.cancelledAt,
  })
  const lobby = await getLobbyByMatch(env.KV, payload.matchId) ?? fallbackLobby
  if (!lobby) {
    console.warn('[draft-lifecycle] no lobby mapping for cancellation', context)
    return { ok: true }
  }

  const lifecycleLobby = buildLobbyStateFromSessionRecord(record, lobby)
  if (payload.reason === 'timeout' || payload.reason === 'revert') {
    const queue = await getQueueState(env.KV, lifecycleLobby.mode)
    const queueEntries = buildSessionRosterQueueEntries(record)
    const affectedPlayerIds = new Set(lobby.memberPlayerIds)
    await setQueueEntries(env.KV, lifecycleLobby.mode, [
      ...queue.entries.filter(entry => !affectedPlayerIds.has(entry.playerId)),
      ...queueEntries,
    ], { currentState: queue })
    await syncLobbyDerivedState(env.KV, lifecycleLobby, {
      queueEntries,
      slots: lifecycleLobby.slots,
    })
    try {
      const slottedEntries = mapLobbySlotsToEntries(lifecycleLobby.slots, queueEntries)
      const renderPayload = await buildOpenLobbyRenderPayload(env.KV, lifecycleLobby, slottedEntries)
      const updatedLobby = await upsertLobbyMessage(env.KV, env.DISCORD_TOKEN, lifecycleLobby, renderPayload)
      await clearMatchMessageMapping(db, updatedLobby.messageId)
    }
    catch (error) {
      console.error('[draft-lifecycle] failed to update reopened lobby embed', context, error)
    }
    return { ok: true }
  }

  try {
    const updatedLobby = await upsertLobbyMessage(env.KV, env.DISCORD_TOKEN, lifecycleLobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, cancelled.participants, payload.reason, undefined, lifecycleLobby.draftConfig.leaderDataVersion, lifecycleLobby.draftConfig.redDeath)],
      components: [],
    })
    await storeMatchMessageMapping(db, updatedLobby.messageId, payload.matchId)
  }
  catch (error) {
    console.error('[draft-lifecycle] failed to update cancelled embed', context, error)
  }

  await clearLobbyById(env.KV, lobby.id, lobby)
  return { ok: true }
}

function isIgnorableDraftCompleteError(error: string): boolean {
  return error.includes('cannot be activated (status: cancelled)')
    || error.includes('cannot be activated (status: completed)')
}

function isIgnorableDraftCancelError(error: string): boolean {
  return error.includes('cannot be cancelled (status: active)')
    || error.includes('cannot be cancelled (status: completed)')
}
