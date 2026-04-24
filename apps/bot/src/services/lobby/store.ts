import type { GameMode } from '@civup/game'
import type { LobbyState } from './types.ts'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'
import { bumpCooldownKey, channelIndexKey, channelPrefix, hostKey, idKey, LOBBY_HOST_KEY_PREFIX, LOBBY_ID_KEY_PREFIX, LOBBY_TTL, modeIndexKey, modePrefix } from './keys.ts'
import { normalizeLobby, parseLobbyState } from './normalize.ts'

interface LobbyStoreEntry {
  key: string
  value: string
  expirationTtl: number
}

export async function getLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<LobbyState[]> {
  const listed = await kv.list({ prefix: modePrefix(mode) })
  const lobbyIds = listed.keys
    .map(entry => entry.name.slice(modePrefix(mode).length))
    .filter((lobbyId): lobbyId is string => lobbyId.length > 0)

  if (lobbyIds.length === 0) {
    return await recoverLobbiesByMode(kv, mode)
  }

  const rawLobbies = await kvMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  const lobbies = rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .filter(lobby => lobby.mode === mode)
    .sort((left, right) => left.createdAt - right.createdAt)

  if (lobbies.length === 0) {
    return await recoverLobbiesByMode(kv, mode)
  }

  return lobbies
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

  if (lobbyIds.length === 0) {
    return await recoverLobbiesByChannel(kv, channelId)
  }

  const rawLobbies = await kvMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  const lobbies = rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .filter(lobby => lobby.channelId === channelId)
    .sort((left, right) => left.createdAt - right.createdAt)

  if (lobbies.length === 0) {
    return await recoverLobbiesByChannel(kv, channelId)
  }

  return lobbies
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
  if (uniquePlayerIds.length === 0) return lobbyByPlayerId

  if (options?.fallbackToLobbyScan === false) {
    for (const playerId of uniquePlayerIds) lobbyByPlayerId.set(playerId, null)
    return lobbyByPlayerId
  }

  const fallbackLobbies = await getCurrentLobbies(kv, options?.mode)
  for (const playerId of uniquePlayerIds) {
    if (!playerId) continue
    const fallbackLobby = fallbackLobbies.find((lobby) => {
      if (excludedLobbyIds.has(lobby.id)) return false
      return lobby.memberPlayerIds.includes(playerId)
    }) ?? null
    lobbyByPlayerId.set(playerId, fallbackLobby)
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
  return fallbackLobbies.filter((lobby) => {
    if (excludedLobbyIds.has(lobby.id)) return false
    return lobby.memberPlayerIds.includes(playerId)
  })
}

export async function getCurrentLobbyHostedBy(kv: KVNamespace, hostId: string): Promise<LobbyState | null> {
  const lobbyId = await kv.get(hostKey(hostId))
  if (!lobbyId) return null

  const lobby = await getLobbyById(kv, lobbyId)
  if (lobby && lobby.hostId === hostId && isCurrentLobbyStatus(lobby.status)) {
    return lobby
  }

  await kvMdelete(kv, [hostKey(hostId)])
  return await recoverCurrentLobbyHostedBy(kv, hostId)
}

export async function getOpenLobbyForPlayer(
  kv: KVNamespace,
  playerId: string,
  mode?: GameMode,
): Promise<LobbyState | null> {
  return (await getCurrentLobbiesForPlayer(kv, playerId, { mode }))
    .find((lobby): lobby is LobbyState => lobby.status === 'open') ?? null
}

export async function getLobbyByMatch(kv: KVNamespace, matchId: string): Promise<LobbyState | null> {
  const lobby = await getLobbyById(kv, matchId)
  return lobby?.matchId === matchId ? lobby : null
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
  const keys = [idKey(lobbyId), bumpCooldownKey(lobbyId)]
  const hostKeys = lobby
    ? [hostKey(lobby.hostId)]
    : await findHostKeysForLobby(kv, lobbyId)
  keys.push(...hostKeys)
  if (lobby) {
    keys.push(modeIndexKey(lobby.mode, lobby.id))
    keys.push(channelIndexKey(lobby.channelId, lobby.id))
  }
  await kvMdelete(kv, keys)
}

export async function clearLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<void> {
  const lobbies = await getLobbiesByMode(kv, mode)
  if (lobbies.length === 0) return
  await kvMdelete(kv, lobbies.flatMap((lobby) => {
    const keys = [
      idKey(lobby.id),
      hostKey(lobby.hostId),
      bumpCooldownKey(lobby.id),
      modeIndexKey(mode, lobby.id),
      channelIndexKey(lobby.channelId, lobby.id),
    ]
    return keys
  }))
}

export async function clearLobbyByMatch(kv: KVNamespace, matchId: string): Promise<void> {
  const lobby = await getLobbyById(kv, matchId)
  if (lobby?.matchId === matchId) await clearLobbyById(kv, lobby.id, lobby)
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
  ]
  entries.push(...buildLobbyProjectionEntries(lobby))
  entries.push(...additionalEntries)
  await kvMput(kv, entries)
}

async function getAllLobbies(kv: KVNamespace): Promise<LobbyState[]> {
  const listed = await kv.list({ prefix: LOBBY_ID_KEY_PREFIX })
  const lobbyIds = listed.keys
    .map(entry => entry.name.slice(LOBBY_ID_KEY_PREFIX.length))
    .filter((lobbyId): lobbyId is string => lobbyId.length > 0)

  if (lobbyIds.length === 0) return []

  const rawLobbies = await kvMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  return rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .sort((left, right) => left.createdAt - right.createdAt)
}

async function recoverLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<LobbyState[]> {
  const recoveredLobbies = (await getAllLobbies(kv))
    .filter(lobby => lobby.mode === mode)
    .sort((left, right) => left.createdAt - right.createdAt)

  if (recoveredLobbies.length === 0) return []

  await repairLobbyProjectionEntries(kv, recoveredLobbies)
  return recoveredLobbies
}

async function recoverLobbiesByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState[]> {
  const recoveredLobbies = (await getAllLobbies(kv))
    .filter(lobby => lobby.channelId === channelId)
    .sort((left, right) => left.createdAt - right.createdAt)

  if (recoveredLobbies.length === 0) return []

  await repairLobbyProjectionEntries(kv, recoveredLobbies)

  return recoveredLobbies
}

async function findHostKeysForLobby(kv: KVNamespace, lobbyId: string): Promise<string[]> {
  const listed = await kv.list({ prefix: LOBBY_HOST_KEY_PREFIX })
  const hostKeys = listed.keys.map(entry => entry.name)
  const hostLobbyIds = await kvMget(kv, hostKeys.map(key => ({ key })))

  return hostKeys.filter((key, index) => hostLobbyIds[index] === lobbyId)
}

async function recoverCurrentLobbyHostedBy(kv: KVNamespace, hostId: string): Promise<LobbyState | null> {
  const currentLobbies = await getCurrentLobbies(kv)
  const hostedLobbies = currentLobbies
    .filter(lobby => lobby.hostId === hostId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  if (hostedLobbies.length === 0) return null

  const recoveredOpenLobby = hostedLobbies.find(lobby => lobby.status === 'open')
  const recoveredLobby = recoveredOpenLobby ?? hostedLobbies.find(lobby => lobby.status !== 'open')
  if (!recoveredLobby) return null

  await repairLobbyProjectionEntries(kv, recoveredLobby)

  return recoveredLobby
}

function buildLobbyProjectionEntries(lobby: LobbyState): LobbyStoreEntry[] {
  const entries: LobbyStoreEntry[] = [
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

  return entries
}

async function repairLobbyProjectionEntries(
  kv: KVNamespace,
  lobbies: LobbyState | readonly LobbyState[],
): Promise<void> {
  const recoveredLobbies = Array.isArray(lobbies) ? lobbies : [lobbies]
  const entryByKey = new Map<string, LobbyStoreEntry>()
  for (const lobby of recoveredLobbies) {
    for (const entry of buildLobbyProjectionEntries(lobby)) {
      entryByKey.set(entry.key, entry)
    }
  }

  if (entryByKey.size === 0) return
  await kvMput(kv, [...entryByKey.values()])
}
