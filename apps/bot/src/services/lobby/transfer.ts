import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbySessionProjectionOptions } from './mutations.ts'
import type { LobbyState } from './types.ts'
import { slotToTeamIndex } from '@civup/game'
import { lobbyCancelledEmbed } from '../../embeds/match.ts'
import { restoreSessionDirectoryMembers } from '../session/directory.ts'
import { getSessionLobbyProjectionByMatch } from '../session/lobby-projection.ts'
import { getTournamentMatchBySessionId } from '../tournament/index.ts'
import { syncLobbyDerivedState } from './live-snapshot.ts'
import { upsertLobbyMessage } from './message.ts'
import { setLobbyRoster, setLobbyStatus } from './mutations.ts'
import { buildOpenLobbyRenderPayload } from './render.ts'
import { filterQueueEntriesForLobby, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots } from './slots.ts'

export interface DeferredOpenLobbyTransferSource {
  lobby: LobbyState
  queueEntries: QueueEntry[]
  releasedPlayerIds: string[]
}

type LeaveOpenLobbyForJoinResult
  = | {
    ok: true
    transferredFrom: { lobbyId: string, mode: GameMode }
    deferredSource?: DeferredOpenLobbyTransferSource
  }
  | { ok: false, error: string }

export async function leaveOpenLobbyForLobbyJoin(
  kv: KVNamespace,
  token: string | undefined,
  lobby: LobbyState,
  movingPlayerIds: string[],
  targetMode: GameMode,
  options?: LobbySessionProjectionOptions,
): Promise<LeaveOpenLobbyForJoinResult> {
  const currentLobby = lobby
  if (currentLobby.status !== 'open') return { ok: false, error: 'You are already in a live match.' }
  if (options?.db && await getTournamentMatchBySessionId(options.db, currentLobby.id)) {
    return { ok: false, error: 'Tournament rosters are locked. Cancel the tournament lobby before joining another lobby.' }
  }

  const uniqueMovingPlayerIds = [...new Set(movingPlayerIds.filter(playerId => currentLobby.memberPlayerIds.includes(playerId)))]
  if (uniqueMovingPlayerIds.length === 0) {
    return { ok: true, transferredFrom: { lobbyId: currentLobby.id, mode: currentLobby.mode } }
  }

  const movingPlayerIdSet = new Set(uniqueMovingPlayerIds)
  const remainingMemberIds = currentLobby.memberPlayerIds.filter(playerId => !movingPlayerIdSet.has(playerId))
  if (movingPlayerIdSet.has(currentLobby.hostId) && remainingMemberIds.length > 0) {
    return {
      ok: false,
      error: uniqueMovingPlayerIds.length === 1 && uniqueMovingPlayerIds[0] === currentLobby.hostId
        ? 'You are hosting another open lobby with other players. Cancel it first.'
        : `<@${currentLobby.hostId}> is hosting another open lobby with other players. Cancel it first.`,
    }
  }

  void targetMode
  const sourceLobbyQueueEntries = filterQueueEntriesForLobby(currentLobby, options?.queueEntries ? [...options.queueEntries] : [])

  if (remainingMemberIds.length === 0) {
    const cancelledLobby = await setLobbyStatus(kv, currentLobby.id, 'cancelled', currentLobby, {
      ...options,
      queueEntries: sourceLobbyQueueEntries,
    }) ?? { ...currentLobby, status: 'cancelled' as const }
    if (token) {
      try {
        await upsertLobbyMessage(kv, token, cancelledLobby, {
          embeds: [lobbyCancelledEmbed(
            currentLobby.mode,
            buildCancelledLobbyParticipants(currentLobby, sourceLobbyQueueEntries),
            'cancel',
            undefined,
            currentLobby.draftConfig.leaderDataVersion,
            currentLobby.draftConfig.redDeath,
            undefined,
            currentLobby.draftConfig.civBlitz,
          )],
          components: [],
        }, options)
      }
      catch (error) {
        console.error(`Failed to update cancelled transfer source lobby ${currentLobby.id}:`, error)
      }
    }

    return {
      ok: true,
      transferredFrom: {
        lobbyId: currentLobby.id,
        mode: currentLobby.mode,
      },
    }
  }

  const changedAt = Date.now()
  const previewLobby = { ...currentLobby, memberPlayerIds: remainingMemberIds }
  let nextSlots = normalizeLobbySlots(
    currentLobby.mode,
    currentLobby.slots.map(playerId => playerId != null && movingPlayerIdSet.has(playerId) ? null : playerId),
    filterQueueEntriesForLobby(previewLobby, sourceLobbyQueueEntries),
  )
  if (sameLobbySlots(nextSlots, currentLobby.slots) && remainingMemberIds.length === currentLobby.memberPlayerIds.length) nextSlots = currentLobby.slots

  const nextPreviewLobby = {
    ...currentLobby,
    memberPlayerIds: remainingMemberIds,
    slots: nextSlots,
  }
  const nextLobbyQueueEntries = filterQueueEntriesForLobby(nextPreviewLobby, sourceLobbyQueueEntries)
  const updatedLobby = await setLobbyRoster(kv, currentLobby.id, {
    memberPlayerIds: remainingMemberIds,
    slots: nextSlots,
    lastActivityAt: changedAt,
    now: changedAt,
  }, currentLobby, {
    ...options,
    queueEntries: nextLobbyQueueEntries,
  }) ?? currentLobby
  await syncLobbyDerivedState(kv, updatedLobby, {
    queueEntries: nextLobbyQueueEntries,
    slots: nextSlots,
  })
  if (token) {
    try {
      const renderPayload = await buildOpenLobbyRenderPayload(kv, updatedLobby, mapLobbySlotsToEntries(nextSlots, nextLobbyQueueEntries))
      await upsertLobbyMessage(kv, token, updatedLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      }, options)
    }
    catch (error) {
      console.error(`Failed to update transfer source lobby ${currentLobby.id}:`, error)
    }
  }

  return {
    ok: true,
    transferredFrom: {
      lobbyId: currentLobby.id,
      mode: currentLobby.mode,
    },
  }
}

export async function finalizeDeferredOpenLobbyTransferSource(
  kv: KVNamespace,
  token: string | undefined,
  source: DeferredOpenLobbyTransferSource,
  options?: LobbySessionProjectionOptions,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const cancelledLobby = await setLobbyStatus(kv, source.lobby.id, 'cancelled', source.lobby, {
      ...options,
      queueEntries: source.queueEntries,
    }) ?? { ...source.lobby, status: 'cancelled' as const }
    if (token) {
      try {
        await upsertLobbyMessage(kv, token, cancelledLobby, {
          embeds: [lobbyCancelledEmbed(
            source.lobby.mode,
            buildCancelledLobbyParticipants(source.lobby, source.queueEntries),
            'cancel',
            undefined,
            source.lobby.draftConfig.leaderDataVersion,
            source.lobby.draftConfig.redDeath,
            undefined,
            source.lobby.draftConfig.civBlitz,
          )],
          components: [],
        }, options)
      }
      catch (error) {
        console.error(`Failed to update cancelled transfer source lobby ${source.lobby.id}:`, error)
      }
    }

    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function restoreDeferredOpenLobbyTransferSourceAdmission(
  source: DeferredOpenLobbyTransferSource,
  options?: LobbySessionProjectionOptions,
): Promise<{ ok: true } | { ok: false, error: string }> {
  if (!options?.db) return { ok: true }
  try {
    await restoreSessionDirectoryMembers(options.db, source.lobby.id, source.releasedPlayerIds, Date.now())
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function rollbackDeferredOpenLobbyTransferTarget(
  kv: KVNamespace,
  source: DeferredOpenLobbyTransferSource,
  target: { lobby: LobbyState, queueEntries: QueueEntry[], at: number },
  options?: LobbySessionProjectionOptions,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const errors: string[] = []
  let targetRolledBack = false
  try {
    const currentTarget = options?.db ? await getSessionLobbyProjectionByMatch(options.db, target.lobby.id) ?? target.lobby : target.lobby
    if (currentTarget.status !== 'open') {
      errors.push('target lobby is no longer open')
    }
    else {
      const restored = await setLobbyRoster(kv, target.lobby.id, {
        memberPlayerIds: target.lobby.memberPlayerIds,
        slots: target.lobby.slots,
        lastActivityAt: Math.max(target.lobby.lastActivityAt, target.at),
        now: Date.now(),
      }, currentTarget, {
        ...options,
        queueEntries: target.queueEntries,
      }) ?? currentTarget
      await syncLobbyDerivedState(kv, restored, {
        queueEntries: target.queueEntries,
        slots: target.lobby.slots,
      })
      targetRolledBack = true
    }
  }
  catch (error) {
    errors.push(`target rollback failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!targetRolledBack) return { ok: false, error: errors.join('; ') || 'target rollback failed' }

  const restoredAdmission = await restoreDeferredOpenLobbyTransferSourceAdmission(source, {
    ...options,
    queueEntries: source.queueEntries,
  })
  if (!restoredAdmission.ok) errors.push(`source admission restore failed: ${restoredAdmission.error}`)

  if (errors.length > 0) return { ok: false, error: errors.join('; ') }
  return { ok: true }
}

function buildCancelledLobbyParticipants(lobby: { mode: GameMode, slots: (string | null)[] }, entries: QueueEntry[]) {
  const entryByPlayerId = new Map(entries.map(entry => [entry.playerId, entry]))
  return lobby.slots
    .map((playerId, slot) => {
      if (!playerId) return null
      const entry = entryByPlayerId.get(playerId)
      return {
        playerId,
        team: slotToTeamIndex(lobby.mode, slot, lobby.slots.length),
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
        displayName: entry?.displayName,
      }
    })
    .filter((participant): participant is NonNullable<typeof participant> => participant != null)
}
