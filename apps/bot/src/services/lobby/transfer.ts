import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbySessionProjectionOptions } from './mutations.ts'
import type { LobbyState } from './types.ts'
import { slotToTeamIndex } from '@civup/game'
import { lobbyCancelledEmbed } from '../../embeds/match.ts'
import { clearQueue, getQueueState } from '../queue/index.ts'
import { syncLobbyDerivedState } from './live-snapshot.ts'
import { upsertLobbyMessage } from './message.ts'
import { setLobbyRoster, setLobbyStatus } from './mutations.ts'
import { buildOpenLobbyRenderPayload } from './render.ts'
import { filterQueueEntriesForLobby, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots } from './slots.ts'
import { clearLobbyById } from './store.ts'

export async function leaveOpenLobbyForLobbyJoin(
  kv: KVNamespace,
  token: string | undefined,
  lobby: LobbyState,
  movingPlayerIds: string[],
  targetMode: GameMode,
  options?: LobbySessionProjectionOptions,
): Promise<{ ok: true, transferredFrom: { lobbyId: string, mode: GameMode } } | { ok: false, error: string }> {
  const currentLobby = lobby
  if (currentLobby.status !== 'open') return { ok: false, error: 'You are already in a live match.' }

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

  const sourceQueue = await getQueueState(kv, currentLobby.mode)
  const sourceLobbyQueueEntries = filterQueueEntriesForLobby(currentLobby, sourceQueue.entries)
  const nextQueue = currentLobby.mode !== targetMode
    ? await clearQueue(kv, currentLobby.mode, uniqueMovingPlayerIds, { currentState: sourceQueue })
    : sourceQueue

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
          )],
          components: [],
        })
      }
      catch (error) {
        console.error(`Failed to update cancelled transfer source lobby ${currentLobby.id}:`, error)
      }
    }

    await clearLobbyById(kv, currentLobby.id, cancelledLobby)
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
    filterQueueEntriesForLobby(previewLobby, nextQueue.entries),
  )
  if (sameLobbySlots(nextSlots, currentLobby.slots) && remainingMemberIds.length === currentLobby.memberPlayerIds.length) nextSlots = currentLobby.slots

  const nextPreviewLobby = {
    ...currentLobby,
    memberPlayerIds: remainingMemberIds,
    slots: nextSlots,
  }
  const nextLobbyQueueEntries = filterQueueEntriesForLobby(nextPreviewLobby, nextQueue.entries)
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
      })
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
