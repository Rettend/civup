import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
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
  redDeath: boolean
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

export async function syncActivityOverviewSnapshotForLobby(kv: KVNamespace, lobby: LobbyState): Promise<ActivityOverviewSnapshot | null> {
  const existing = parseActivityOverviewSnapshot(await kv.get(activityOverviewKey(lobby.channelId), 'json'))
  if (!existing) {
    return syncActivityOverviewSnapshot(kv, lobby.channelId)
  }

  const options = [
    ...existing.options.filter(option => option.lobbyId !== lobby.id),
    ...buildOverviewOptions(lobby.channelId, lobby),
  ].sort(compareOverviewOptions)

  const key = activityOverviewKey(lobby.channelId)
  if (options.length === 0) {
    await stateStoreMdelete(kv, [key])
    return null
  }

  const snapshot: ActivityOverviewSnapshot = {
    channelId: lobby.channelId,
    options,
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
      targetSize: lobby.slots.length,
      redDeath: lobby.draftConfig.redDeath,
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
      targetSize: lobby.slots.length,
      redDeath: lobby.draftConfig.redDeath,
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

function parseActivityOverviewSnapshot(raw: unknown): ActivityOverviewSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const snapshot = raw as Partial<ActivityOverviewSnapshot>
  if (typeof snapshot.channelId !== 'string' || !Array.isArray(snapshot.options)) return null

  const options = snapshot.options.flatMap((option) => {
    if (!option || typeof option !== 'object') return []
    const parsed = option as Partial<ActivityOverviewOptionSnapshot>
    if ((parsed.kind !== 'lobby' && parsed.kind !== 'match') || typeof parsed.id !== 'string' || typeof parsed.lobbyId !== 'string' || typeof parsed.channelId !== 'string' || typeof parsed.mode !== 'string' || (parsed.status !== 'open' && parsed.status !== 'drafting' && parsed.status !== 'active') || typeof parsed.participantCount !== 'number' || typeof parsed.targetSize !== 'number' || typeof parsed.redDeath !== 'boolean' || typeof parsed.hostId !== 'string' || !Array.isArray(parsed.memberPlayerIds) || typeof parsed.updatedAt !== 'number') {
      return []
    }

    return [{
      kind: parsed.kind,
      id: parsed.id,
      lobbyId: parsed.lobbyId,
      matchId: typeof parsed.matchId === 'string' ? parsed.matchId : null,
      channelId: parsed.channelId,
      mode: parsed.mode as GameMode,
      status: parsed.status,
      participantCount: parsed.participantCount,
      targetSize: parsed.targetSize,
      redDeath: parsed.redDeath,
      hostId: parsed.hostId,
      memberPlayerIds: parsed.memberPlayerIds.filter((playerId): playerId is string => typeof playerId === 'string'),
      updatedAt: parsed.updatedAt,
    } satisfies ActivityOverviewOptionSnapshot]
  })

  return {
    channelId: snapshot.channelId,
    options,
  }
}
