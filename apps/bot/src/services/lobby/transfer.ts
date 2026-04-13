import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import { slotToTeamIndex } from '@civup/game'
import { lobbyCancelledEmbed } from '../../embeds/match.ts'
import { clearLobbyMappingsIfMatchingLobby } from '../activity/index.ts'
import { clearQueue, getQueueState } from '../queue/index.ts'
import { buildOpenLobbyRenderPayload } from './render.ts'
import { setLobbyLastActivityAt, setLobbyMemberPlayerIds, setLobbySlots, setLobbyStatus } from './mutations.ts'
import { upsertLobbyMessage } from './message.ts'
import { syncLobbyDerivedState } from './live-snapshot.ts'
import { clearLobbyById } from './store.ts'
import { filterQueueEntriesForLobby, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots } from './slots.ts'

export async function leaveOpenLobbyForLobbyJoin(
  kv: KVNamespace,
  token: string | undefined,
  lobby: LobbyState,
  movingPlayerIds: string[],
  targetMode: GameMode,
): Promise<{ ok: true, transferredFrom: { lobbyId: string, mode: GameMode } } | { ok: false, error: string }> {
  if (lobby.status !== 'open') {
    return { ok: false, error: 'You are already in a live match.' }
  }

  const uniqueMovingPlayerIds = [...new Set(movingPlayerIds.filter(playerId => lobby.memberPlayerIds.includes(playerId)))]
  if (uniqueMovingPlayerIds.length === 0) {
    return { ok: true, transferredFrom: { lobbyId: lobby.id, mode: lobby.mode } }
  }

  const movingPlayerIdSet = new Set(uniqueMovingPlayerIds)
  const remainingMemberIds = lobby.memberPlayerIds.filter(playerId => !movingPlayerIdSet.has(playerId))
  if (movingPlayerIdSet.has(lobby.hostId) && remainingMemberIds.length > 0) {
    return {
      ok: false,
      error: uniqueMovingPlayerIds.length === 1 && uniqueMovingPlayerIds[0] === lobby.hostId
        ? 'You are hosting another open lobby with other players. Cancel it first.'
        : `<@${lobby.hostId}> is hosting another open lobby with other players. Cancel it first.`,
    }
  }

  const sourceQueue = await getQueueState(kv, lobby.mode)
  const sourceLobbyQueueEntries = filterQueueEntriesForLobby(lobby, sourceQueue.entries)
  if (hasCrossLobbyPartyLinks(sourceQueue.entries, movingPlayerIdSet)) {
    return { ok: false, error: 'This premade is already grouped with different teammates. Ask those players to leave first.' }
  }

  const nextQueue = lobby.mode !== targetMode
    ? await clearQueue(kv, lobby.mode, uniqueMovingPlayerIds, { currentState: sourceQueue })
    : sourceQueue

  if (remainingMemberIds.length === 0) {
    const cancelledLobby = await setLobbyStatus(kv, lobby.id, 'cancelled', lobby) ?? { ...lobby, status: 'cancelled' as const }
    await clearLobbyMappingsIfMatchingLobby(kv, uniqueMovingPlayerIds, lobby.id, lobby.channelId)

    if (token) {
      try {
        await upsertLobbyMessage(kv, token, cancelledLobby, {
          embeds: [lobbyCancelledEmbed(
            lobby.mode,
            buildCancelledLobbyParticipants(lobby, sourceLobbyQueueEntries),
            'cancel',
            undefined,
            lobby.draftConfig.leaderDataVersion,
            lobby.draftConfig.redDeath,
          )],
          components: [],
        })
      }
      catch (error) {
        console.error(`Failed to update cancelled transfer source lobby ${lobby.id}:`, error)
      }
    }

    await clearLobbyById(kv, lobby.id, cancelledLobby)
    return {
      ok: true,
      transferredFrom: {
        lobbyId: lobby.id,
        mode: lobby.mode,
      },
    }
  }

  const clearedSlots = lobby.slots.map(playerId => playerId != null && movingPlayerIdSet.has(playerId) ? null : playerId)
  let nextLobby = await setLobbyMemberPlayerIds(kv, lobby.id, remainingMemberIds, lobby) ?? lobby
  let nextSlots = normalizeLobbySlots(lobby.mode, clearedSlots, filterQueueEntriesForLobby(nextLobby, nextQueue.entries))
  if (!sameLobbySlots(nextSlots, nextLobby.slots)) {
    nextLobby = await setLobbySlots(kv, nextLobby.id, nextSlots, nextLobby) ?? nextLobby
    nextSlots = nextLobby.slots
  }

  nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, Date.now(), nextLobby) ?? nextLobby
  const nextLobbyQueueEntries = filterQueueEntriesForLobby(nextLobby, nextQueue.entries)
  await syncLobbyDerivedState(kv, nextLobby, {
    queueEntries: nextLobbyQueueEntries,
    slots: nextSlots,
  })
  await clearLobbyMappingsIfMatchingLobby(kv, uniqueMovingPlayerIds, lobby.id, lobby.channelId)

  if (token) {
    try {
      const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, mapLobbySlotsToEntries(nextSlots, nextLobbyQueueEntries))
      await upsertLobbyMessage(kv, token, nextLobby, {
        embeds: renderPayload.embeds,
        components: renderPayload.components,
      })
    }
    catch (error) {
      console.error(`Failed to update transfer source lobby ${lobby.id}:`, error)
    }
  }

  return {
    ok: true,
    transferredFrom: {
      lobbyId: lobby.id,
      mode: lobby.mode,
    },
  }
}

function hasCrossLobbyPartyLinks(entries: QueueEntry[], movingPlayerIds: ReadonlySet<string>): boolean {
  for (const entry of entries) {
    const linkedPartyIds = entry.partyIds ?? []
    const hasMovingPlayer = movingPlayerIds.has(entry.playerId)
    if (hasMovingPlayer && linkedPartyIds.some(playerId => !movingPlayerIds.has(playerId))) return true
    if (!hasMovingPlayer && linkedPartyIds.some(playerId => movingPlayerIds.has(playerId))) return true
  }
  return false
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
