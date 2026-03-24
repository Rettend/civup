import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
import { maxPlayerCount } from '@civup/game'
import { channelPrefix, idKey, LOBBY_TTL } from '../lobby/keys.ts'
import { parseLobbyState } from '../lobby/normalize.ts'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from '../state/store.ts'

export interface ActivityOverviewOptionSnapshot {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  mode: GameMode
  status: 'open' | 'drafting' | 'active'
  participantCount: number
  targetSize: number
  hostId: string
  memberPlayerIds: string[]
  updatedAt: number
}

export interface ActivityOverviewSnapshot {
  channelId: string
  options: ActivityOverviewOptionSnapshot[]
}

const ACTIVITY_OVERVIEW_KEY_PREFIX = 'activity:overview:'

export function activityOverviewKey(channelId: string): string {
  return `${ACTIVITY_OVERVIEW_KEY_PREFIX}${channelId}`
}

export async function syncActivityOverviewSnapshot(kv: KVNamespace, channelId: string): Promise<ActivityOverviewSnapshot | null> {
  const snapshot = await buildActivityOverviewSnapshot(kv, channelId)
  const key = activityOverviewKey(channelId)

  if (!snapshot) {
    await stateStoreMdelete(kv, [key])
    return null
  }

  await stateStoreMput(kv, [{
    key,
    value: JSON.stringify(snapshot),
    expirationTtl: LOBBY_TTL,
  }])

  return snapshot
}

async function buildActivityOverviewSnapshot(kv: KVNamespace, channelId: string): Promise<ActivityOverviewSnapshot | null> {
  const lobbies = await getChannelLobbiesForOverview(kv, channelId)
  const options = lobbies
    .flatMap(lobby => buildOverviewOptions(channelId, lobby))
    .sort(compareOverviewOptions)

  if (options.length === 0) return null
  return { channelId, options }
}

async function getChannelLobbiesForOverview(kv: KVNamespace, channelId: string): Promise<LobbyState[]> {
  const listed = await kv.list({ prefix: channelPrefix(channelId) })
  const lobbyIds = listed.keys
    .map(entry => entry.name.slice(channelPrefix(channelId).length))
    .filter((lobbyId): lobbyId is string => lobbyId.length > 0)

  if (lobbyIds.length === 0) return []

  const rawLobbies = await stateStoreMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  return rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .filter(lobby => lobby.channelId === channelId)
}

function buildOverviewOptions(channelId: string, lobby: LobbyState): ActivityOverviewOptionSnapshot[] {
  if (lobby.status === 'open') {
    return [{
      kind: 'lobby',
      id: lobby.id,
      lobbyId: lobby.id,
      matchId: null,
      channelId,
      mode: lobby.mode,
      status: 'open',
      participantCount: countFilledSlots(lobby.slots),
      targetSize: maxPlayerCount(lobby.mode),
      hostId: lobby.hostId,
      memberPlayerIds: [...lobby.memberPlayerIds],
      updatedAt: lobby.updatedAt,
    }]
  }

  if ((lobby.status === 'drafting' || lobby.status === 'active') && lobby.matchId) {
    return [{
      kind: 'match',
      id: lobby.matchId,
      lobbyId: lobby.id,
      matchId: lobby.matchId,
      channelId,
      mode: lobby.mode,
      status: lobby.status,
      participantCount: countFilledSlots(lobby.slots),
      targetSize: maxPlayerCount(lobby.mode),
      hostId: lobby.hostId,
      memberPlayerIds: [...lobby.memberPlayerIds],
      updatedAt: lobby.updatedAt,
    }]
  }

  return []
}

function countFilledSlots(slots: (string | null)[]): number {
  let count = 0
  for (const slot of slots) {
    if (slot != null) count += 1
  }
  return count
}

function compareOverviewOptions(left: ActivityOverviewOptionSnapshot, right: ActivityOverviewOptionSnapshot): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.mode !== right.mode) return left.mode.localeCompare(right.mode)
  return left.id.localeCompare(right.id)
}
