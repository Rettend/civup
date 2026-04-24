import type { GameMode } from '@civup/game'
import type { LobbyState } from '../../../src/services/lobby/index.ts'
import type { SystemWorld } from './world.ts'
import { matches } from '@civup/db'
import { expect } from 'bun:test'
import { getQueueState } from '../../../src/services/queue/index.ts'
import { channelIndexKey, hostKey, modeIndexKey } from '../../../src/services/lobby/keys.ts'
import { getLobbiesByMode } from '../../../src/services/lobby/store.ts'

const SUPPORTED_GAME_MODES = ['1v1', '2v2', '3v3', '4v4', 'ffa'] as const satisfies readonly GameMode[]

export async function expectQueuePlayers(
  world: SystemWorld,
  mode: GameMode,
  playerIds: string[],
): Promise<void> {
  expect((await getQueueState(world.kv, mode)).entries.map(entry => entry.playerId)).toEqual(playerIds)
}

export async function expectLobbyState(
  world: SystemWorld,
  input: {
    lobbyId: string
    status?: LobbyState['status']
    hostId?: string | null
    matchId?: string | null
    memberPlayerIds?: string[]
    slots?: (string | null)[]
  },
): Promise<LobbyState> {
  const lobby = await world.lobby.getById(input.lobbyId)
  expect(lobby).not.toBeNull()
  if (!lobby) throw new Error(`Expected lobby ${input.lobbyId} to exist`)

  if (input.status !== undefined) expect(lobby.status).toBe(input.status)
  if (input.hostId !== undefined) expect(lobby.hostId).toBe(input.hostId)
  if (input.matchId !== undefined) expect(lobby.matchId).toBe(input.matchId)
  if (input.memberPlayerIds !== undefined) expect(lobby.memberPlayerIds).toEqual(input.memberPlayerIds)
  if (input.slots !== undefined) expect(lobby.slots).toEqual(input.slots)

  return lobby
}

export async function expectMatchState(
  world: SystemWorld,
  input: {
    matchId: string
    status?: 'drafting' | 'active' | 'completed' | 'cancelled'
    participantPlayerIds?: string[]
    civsAssigned?: boolean
    placementsAssigned?: boolean
  },
): Promise<Awaited<ReturnType<SystemWorld['match']['get']>>> {
  const match = await world.match.get(input.matchId)
  expect(match).not.toBeNull()
  if (!match) throw new Error(`Expected match ${input.matchId} to exist`)

  if (input.status !== undefined) expect(match.status).toBe(input.status)

  const participants = await world.match.getParticipants(input.matchId)
  if (input.participantPlayerIds !== undefined) {
    expect(participants.map(participant => participant.playerId)).toEqual(input.participantPlayerIds)
  }
  if (input.civsAssigned === true) {
    expect(participants.every(participant => participant.civId != null)).toBe(true)
  }
  if (input.civsAssigned === false) {
    expect(participants.every(participant => participant.civId == null)).toBe(true)
  }
  if (input.placementsAssigned === true) {
    expect(participants.every(participant => participant.placement != null)).toBe(true)
  }
  if (input.placementsAssigned === false) {
    expect(participants.every(participant => participant.placement == null)).toBe(true)
  }

  return match
}

export function countDiscordChannelRequests(
  world: SystemWorld,
  method: 'PATCH' | 'POST' | 'DELETE',
): number {
  return world.discord.requests().filter(request => request.method === method && request.url.includes('/channels/')).length
}

export async function expectDraftAndLobbyState(
  world: SystemWorld,
  input: {
    mode: GameMode
    lobbyId: string
    matchId: string
    lobbyStatus: LobbyState['status']
    matchStatus: 'drafting' | 'active' | 'cancelled'
    queuePlayerIds: string[]
  },
): Promise<void> {
  await expectLobbyState(world, {
    lobbyId: input.lobbyId,
    status: input.lobbyStatus,
    matchId: input.matchStatus === 'drafting' || input.matchStatus === 'active' ? input.matchId : undefined,
  })
  await expectMatchState(world, {
    matchId: input.matchId,
    status: input.matchStatus,
  })
  await expectQueuePlayers(world, input.mode, input.queuePlayerIds)
}

export async function assertSystemWorldInvariants(
  world: SystemWorld,
  options: {
    modes?: readonly GameMode[]
    checkProjectionIndexes?: boolean
    checkCurrentMappings?: boolean
  } = {},
): Promise<void> {
  const openLobbyByPlayerId = new Map<string, string>()
  const liveMatchByPlayerId = new Map<string, string>()
  const modes = options.modes ?? SUPPORTED_GAME_MODES

  for (const mode of modes) {
    const queueState = await getQueueState(world.kv, mode)
    const lobbies = await getLobbiesByMode(world.kv, mode)

    for (const lobby of lobbies) {
      const projection = options.checkProjectionIndexes === true
        ? {
            modeIndexed: await world.kv.get(modeIndexKey(lobby.mode, lobby.id)) != null,
            channelIndexed: await world.kv.get(channelIndexKey(lobby.channelId, lobby.id)) != null,
            hostLobbyId: await world.kv.get(hostKey(lobby.hostId)),
          }
        : undefined

      expect(new Set(lobby.memberPlayerIds).size).toBe(lobby.memberPlayerIds.length)
      expect(lobby.slots.filter((slot): slot is string => slot != null).every(playerId => lobby.memberPlayerIds.includes(playerId))).toBe(true)

      if (projection) {
        expect(projection.modeIndexed).toBe(true)
        expect(projection.channelIndexed).toBe(true)
        expect(projection.hostLobbyId).toBe(lobby.id)
      }

      if (lobby.status !== 'open') continue
      expect(lobby.memberPlayerIds).toEqual(queueState.entries.map(entry => entry.playerId))

      for (const playerId of lobby.memberPlayerIds) {
        expect(openLobbyByPlayerId.has(playerId)).toBe(false)
        openLobbyByPlayerId.set(playerId, lobby.id)

        if (options.checkCurrentMappings === true) {
          expect(await world.inspect.lobbyMapping(playerId)).toBe(lobby.id)
        }
      }
    }
  }

  const persistedMatches = await world.db.select().from(matches)
  for (const match of persistedMatches) {
    if (match.status !== 'drafting' && match.status !== 'active') continue

    const participants = await world.match.getParticipants(match.id)
    for (const participant of participants) {
      expect(liveMatchByPlayerId.has(participant.playerId)).toBe(false)
      liveMatchByPlayerId.set(participant.playerId, match.id)

      if (options.checkCurrentMappings === true) {
        expect(await world.inspect.matchMapping(participant.playerId)).toBe(match.id)
      }
    }
  }
}
