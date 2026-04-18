import type { GameMode } from '@civup/game'
import type { LobbyState } from './types.ts'
import { syncActivityOverviewSnapshot } from '../activity/live-state.ts'
import { getQueueState, getQueueStates } from '../queue/index.ts'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from '../state/store.ts'
import { bumpCooldownKey, channelIndexKey, channelPrefix, hostKey, idKey, LOBBY_HOST_KEY_PREFIX, LOBBY_MODE_KEY_PREFIX, LOBBY_TTL, matchKey, modeIndexKey, modePrefix } from './keys.ts'
import { lobbySnapshotKey } from './live-snapshot.ts'
import { normalizeLobby, parseLobbyState } from './normalize.ts'
import { deriveQueueBackedLobbyMemberPlayerIds, isQueueBackedOpenLobbyState } from './reconcile.ts'

interface LobbyStoreEntry {
  key: string
  value: string
  expirationTtl: number
}

function activityLobbyUserKey(userId: string): string {
  return `activity-lobby-user:${userId}`
}

export async function getLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<LobbyState[]> {
  const listed = await kv.list({ prefix: modePrefix(mode) })
  const lobbyIds = listed.keys
    .map(entry => entry.name.slice(modePrefix(mode).length))
    .filter((lobbyId): lobbyId is string => lobbyId.length > 0)

  if (lobbyIds.length === 0) return []

  const rawLobbies = await stateStoreMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  return rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .filter(lobby => lobby.mode === mode)
    .sort((left, right) => left.createdAt - right.createdAt)
}

/** Temporary convenience lookup for the most recently updated lobby in a mode. */
export async function getLobby(kv: KVNamespace, mode: GameMode): Promise<LobbyState | null> {
  const lobbies = await getLobbiesByMode(kv, mode)
  return [...lobbies].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
}

export async function getLobbyById(kv: KVNamespace, lobbyId: string): Promise<LobbyState | null> {
  const raw = await kv.get(idKey(lobbyId), 'json')
  return parseLobbyState(raw)
}

export async function getLobbyByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState | null> {
  const lobbies = await getLobbiesByChannel(kv, channelId)
  const openLobbies = lobbies
    .filter(lobby => lobby.status === 'open')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return openLobbies[0] ?? null
}

export async function getLobbiesByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState[]> {
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
    .sort((left, right) => left.createdAt - right.createdAt)
}

export function isCurrentLobbyStatus(status: LobbyState['status']): boolean {
  return status === 'open' || status === 'drafting' || status === 'active'
}

export async function getCurrentLobbiesForPlayers(
  kv: KVNamespace,
  playerIds: string[],
  options?: {
    mode?: GameMode
    excludeLobbyIds?: readonly string[]
    fallbackToLobbyScan?: boolean
  },
): Promise<Map<string, LobbyState | null>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const excludedLobbyIds = new Set(options?.excludeLobbyIds ?? [])
  const lobbyByPlayerId = new Map<string, LobbyState | null>()
  const staleMappingKeys = new Set<string>()
  if (uniquePlayerIds.length === 0) return lobbyByPlayerId

  const rawMappedLobbyIds = await stateStoreMget(
    kv,
    uniquePlayerIds.map(playerId => ({ key: activityLobbyUserKey(playerId) })),
  )

  const lobbyIdsToLoad: string[] = []
  const lobbyIdSet = new Set<string>()
  for (const rawLobbyId of rawMappedLobbyIds) {
    if (typeof rawLobbyId !== 'string' || rawLobbyId.length === 0 || lobbyIdSet.has(rawLobbyId)) continue
    lobbyIdSet.add(rawLobbyId)
    lobbyIdsToLoad.push(rawLobbyId)
  }

  const rawLobbies = await stateStoreMget(
    kv,
    lobbyIdsToLoad.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )
  const mappedLobbyById = new Map<string, LobbyState>()
  const queueStateByMode = new Map<GameMode, Awaited<ReturnType<typeof getQueueState>>>()
  const getModeQueue = async (mode: GameMode) => {
    const cached = queueStateByMode.get(mode)
    if (cached) return cached
    const queue = await getQueueState(kv, mode)
    queueStateByMode.set(mode, queue)
    return queue
  }
  for (let index = 0; index < lobbyIdsToLoad.length; index++) {
    const lobbyId = lobbyIdsToLoad[index]
    const lobby = parseLobbyState(rawLobbies[index])
    if (!lobbyId || !lobby) continue
    if (lobby.status === 'open') {
      const queue = await getModeQueue(lobby.mode)
      if (!isQueueBackedOpenLobbyState(lobby, queue.entries)) continue
    }
    mappedLobbyById.set(lobbyId, lobby)
  }

  const unresolvedPlayerIds: string[] = []
  for (let index = 0; index < uniquePlayerIds.length; index++) {
    const playerId = uniquePlayerIds[index]
    const rawLobbyId = rawMappedLobbyIds[index]
    if (!playerId || typeof rawLobbyId !== 'string' || rawLobbyId.length === 0) {
      unresolvedPlayerIds.push(playerId ?? '')
      continue
    }

    const lobby = mappedLobbyById.get(rawLobbyId)
    const queue = lobby?.status === 'open' ? await getModeQueue(lobby.mode) : null
    const memberPlayerIds = lobby && queue ? deriveQueueBackedLobbyMemberPlayerIds(lobby, queue.entries) : lobby?.memberPlayerIds ?? []
    const mappingLooksStale = !lobby
      || !isCurrentLobbyStatus(lobby.status)
      || !memberPlayerIds.includes(playerId)
    const excludedMappedLobby = lobby ? excludedLobbyIds.has(lobby.id) : false
    const mismatchedMappedMode = lobby ? options?.mode != null && lobby.mode !== options.mode : false
    if (mappingLooksStale) {
      staleMappingKeys.add(activityLobbyUserKey(playerId))
    }
    if (mappingLooksStale
      || excludedMappedLobby
      || mismatchedMappedMode) {
      unresolvedPlayerIds.push(playerId)
      continue
    }

    lobbyByPlayerId.set(playerId, lobby)
  }

  if (staleMappingKeys.size > 0) {
    await stateStoreMdelete(kv, [...staleMappingKeys])
  }

  if (options?.fallbackToLobbyScan === false || unresolvedPlayerIds.length === 0) {
    for (const playerId of unresolvedPlayerIds) {
      if (!playerId) continue
      lobbyByPlayerId.set(playerId, null)
    }
    return lobbyByPlayerId
  }

  const fallbackLobbies = await getCurrentLobbies(kv, options?.mode)
  const fallbackQueues = await getQueueStates(kv, [...new Set(fallbackLobbies.filter(lobby => lobby.status === 'open').map(lobby => lobby.mode))])
  for (const playerId of unresolvedPlayerIds) {
    if (!playerId) continue
    lobbyByPlayerId.set(playerId, fallbackLobbies.find((lobby) => {
      if (excludedLobbyIds.has(lobby.id)) return false
      if (lobby.status !== 'open') return lobby.memberPlayerIds.includes(playerId)
      return deriveQueueBackedLobbyMemberPlayerIds(lobby, fallbackQueues.get(lobby.mode)?.entries ?? []).includes(playerId)
    }) ?? null)
  }

  return lobbyByPlayerId
}

export async function getCurrentLobbies(kv: KVNamespace, mode?: GameMode): Promise<LobbyState[]> {
  const lobbies = mode ? await getLobbiesByMode(kv, mode) : await getAllLobbies(kv)
  return lobbies.filter(lobby => isCurrentLobbyStatus(lobby.status))
}

export async function getCurrentLobbiesForPlayer(
  kv: KVNamespace,
  playerId: string,
  options?: {
    mode?: GameMode
    excludeLobbyIds?: readonly string[]
    fallbackToLobbyScan?: boolean
  },
): Promise<LobbyState[]> {
  const mappedLobby = (await getCurrentLobbiesForPlayers(kv, [playerId], {
    ...options,
    fallbackToLobbyScan: false,
  })).get(playerId) ?? null
  if (mappedLobby) return [mappedLobby]

  if (options?.fallbackToLobbyScan === false) return []

  const excludedLobbyIds = new Set(options?.excludeLobbyIds ?? [])
  const fallbackLobbies = await getCurrentLobbies(kv, options?.mode)
  const fallbackQueues = await getQueueStates(kv, [...new Set(fallbackLobbies.filter(lobby => lobby.status === 'open').map(lobby => lobby.mode))])
  return fallbackLobbies.filter((lobby) => {
    if (excludedLobbyIds.has(lobby.id)) return false
    if (lobby.status !== 'open') return lobby.memberPlayerIds.includes(playerId)
    return deriveQueueBackedLobbyMemberPlayerIds(lobby, fallbackQueues.get(lobby.mode)?.entries ?? []).includes(playerId)
  })
}

export async function getCurrentLobbyHostedBy(kv: KVNamespace, hostId: string): Promise<LobbyState | null> {
  const lobbyId = await kv.get(hostKey(hostId))
  if (!lobbyId) return null

  const lobby = await getLobbyById(kv, lobbyId)
  if (lobby && lobby.hostId === hostId && isCurrentLobbyStatus(lobby.status)) {
    if (lobby.status !== 'open') return lobby

    const queue = await getQueueState(kv, lobby.mode)
    if (isQueueBackedOpenLobbyState(lobby, queue.entries)) return lobby
  }

  await stateStoreMdelete(kv, [hostKey(hostId)])
  return await recoverCurrentLobbyHostedBy(kv, hostId)
}

export async function getOpenLobbyForPlayer(
  kv: KVNamespace,
  playerId: string,
  mode?: GameMode,
): Promise<LobbyState | null> {
  const mappedLobby = (await getCurrentLobbiesForPlayers(kv, [playerId], {
    mode,
    fallbackToLobbyScan: false,
  })).get(playerId) ?? null
  if (mappedLobby?.status === 'open') return mappedLobby

  const lobbies = mode ? await getLobbiesByMode(kv, mode) : await getAllLobbies(kv)
  const queueStates = await getQueueStates(kv, [...new Set(lobbies.filter(lobby => lobby.status === 'open').map(lobby => lobby.mode))])
  return lobbies.find(lobby => lobby.status === 'open'
    && deriveQueueBackedLobbyMemberPlayerIds(lobby, queueStates.get(lobby.mode)?.entries ?? []).includes(playerId)) ?? null
}

export async function getLobbyByMatch(kv: KVNamespace, matchId: string): Promise<LobbyState | null> {
  const lobbyId = await kv.get(matchKey(matchId))
  if (!lobbyId) return null
  const lobby = await getLobbyById(kv, lobbyId)
  if (!lobby || lobby.matchId !== matchId) {
    await stateStoreMdelete(kv, [matchKey(matchId)])
    return null
  }
  return lobby
}

export async function upsertLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  const normalizedLobby = normalizeLobby(lobby)
  await putLobby(kv, normalizedLobby)
}

export async function clearLobbyById(
  kv: KVNamespace,
  lobbyId: string,
  currentLobby?: LobbyState | null,
  options?: {
    syncActivityOverview?: boolean
  },
): Promise<void> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  const keys = [idKey(lobbyId), lobbySnapshotKey(lobbyId), bumpCooldownKey(lobbyId)]
  const hostKeys = lobby
    ? [hostKey(lobby.hostId)]
    : await findHostKeysForLobby(kv, lobbyId)
  keys.push(...hostKeys)
  if (lobby) {
    keys.push(modeIndexKey(lobby.mode, lobby.id))
    keys.push(channelIndexKey(lobby.channelId, lobby.id))
    if (lobby.matchId) keys.push(matchKey(lobby.matchId))
  }
  await stateStoreMdelete(kv, keys)
  if (lobby && options?.syncActivityOverview !== false) await syncActivityOverviewSnapshot(kv, lobby.channelId)
}

export async function clearLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<void> {
  const lobbies = await getLobbiesByMode(kv, mode)
  if (lobbies.length === 0) return
  const channelIds = [...new Set(lobbies.map(lobby => lobby.channelId))]
  await stateStoreMdelete(kv, lobbies.flatMap((lobby) => {
    const keys = [
      idKey(lobby.id),
      lobbySnapshotKey(lobby.id),
      hostKey(lobby.hostId),
      bumpCooldownKey(lobby.id),
      modeIndexKey(mode, lobby.id),
      channelIndexKey(lobby.channelId, lobby.id),
    ]
    if (lobby.matchId) keys.push(matchKey(lobby.matchId))
    return keys
  }))
  await Promise.all(channelIds.map(channelId => syncActivityOverviewSnapshot(kv, channelId)))
}

export async function clearLobbyByMatch(kv: KVNamespace, matchId: string): Promise<void> {
  const lobbyId = await kv.get(matchKey(matchId))
  if (!lobbyId) {
    await stateStoreMdelete(kv, [matchKey(matchId)])
    return
  }
  await clearLobbyById(kv, lobbyId)
}

export async function putLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  await putLobbyEntries(kv, lobby)
}

export async function putLobbyEntries(
  kv: KVNamespace,
  lobby: LobbyState,
  additionalEntries: LobbyStoreEntry[] = [],
): Promise<void> {
  const entries: LobbyStoreEntry[] = [
    {
      key: idKey(lobby.id),
      value: JSON.stringify(lobby),
      expirationTtl: LOBBY_TTL,
    },
    {
      key: modeIndexKey(lobby.mode, lobby.id),
      value: String(lobby.revision),
      expirationTtl: LOBBY_TTL,
    },
    {
      key: channelIndexKey(lobby.channelId, lobby.id),
      value: String(lobby.revision),
      expirationTtl: LOBBY_TTL,
    },
  ]
  if (isCurrentLobbyStatus(lobby.status)) {
    entries.push({
      key: hostKey(lobby.hostId),
      value: lobby.id,
      expirationTtl: LOBBY_TTL,
    })
  }
  if (lobby.matchId) {
    entries.push({
      key: matchKey(lobby.matchId),
      value: lobby.id,
      expirationTtl: LOBBY_TTL,
    })
  }
  entries.push(...additionalEntries)
  await stateStoreMput(kv, entries)
}

async function getAllLobbies(kv: KVNamespace): Promise<LobbyState[]> {
  const listed = await kv.list({ prefix: LOBBY_MODE_KEY_PREFIX })
  const lobbyIds = [...new Set(listed.keys
    .map(entry => entry.name.slice(entry.name.lastIndexOf(':') + 1))
    .filter((lobbyId): lobbyId is string => lobbyId.length > 0))]

  if (lobbyIds.length === 0) return []

  const rawLobbies = await stateStoreMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  return rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .sort((left, right) => left.createdAt - right.createdAt)
}

async function findHostKeysForLobby(kv: KVNamespace, lobbyId: string): Promise<string[]> {
  const listed = await kv.list({ prefix: LOBBY_HOST_KEY_PREFIX })
  const hostKeys = listed.keys.map(entry => entry.name)
  const hostLobbyIds = await stateStoreMget(kv, hostKeys.map(key => ({ key })))

  return hostKeys.filter((key, index) => hostLobbyIds[index] === lobbyId)
}

async function recoverCurrentLobbyHostedBy(kv: KVNamespace, hostId: string): Promise<LobbyState | null> {
  const currentLobbies = await getCurrentLobbies(kv)
  const hostedLobbies = currentLobbies
    .filter(lobby => lobby.hostId === hostId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  if (hostedLobbies.length === 0) return null

  const queueStates = await getQueueStates(
    kv,
    [...new Set(hostedLobbies.filter(lobby => lobby.status === 'open').map(lobby => lobby.mode))],
  )
  const recoveredOpenLobby = hostedLobbies.find(lobby => lobby.status === 'open'
    && isQueueBackedOpenLobbyState(lobby, queueStates.get(lobby.mode)?.entries ?? []))
  const recoveredLobby = recoveredOpenLobby ?? hostedLobbies.find(lobby => lobby.status !== 'open')
  if (!recoveredLobby) return null

  await stateStoreMput(kv, [{
    key: hostKey(hostId),
    value: recoveredLobby.id,
    expirationTtl: LOBBY_TTL,
  }])

  return recoveredLobby
}
