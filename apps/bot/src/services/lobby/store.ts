import type { GameMode } from '@civup/game'
import type { LobbyState } from './types.ts'
import { GAME_MODES } from '@civup/game'
import { syncActivityOverviewSnapshot } from '../activity/live-state.ts'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from '../state/store.ts'
import { bumpCooldownKey, channelIndexKey, channelPrefix, hostKey, idKey, LOBBY_HOST_KEY_PREFIX, LOBBY_TTL, matchKey, modeIndexKey, modePrefix } from './keys.ts'
import { lobbySnapshotKey } from './live-snapshot.ts'
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
  },
): Promise<LobbyState[]> {
  const excludedLobbyIds = new Set(options?.excludeLobbyIds ?? [])
  return (await getCurrentLobbies(kv, options?.mode))
    .filter(lobby => !excludedLobbyIds.has(lobby.id) && lobby.memberPlayerIds.includes(playerId))
}

export async function getCurrentLobbyHostedBy(kv: KVNamespace, hostId: string): Promise<LobbyState | null> {
  const lobbyId = await kv.get(hostKey(hostId))
  if (!lobbyId) return null

  const lobby = await getLobbyById(kv, lobbyId)
  if (lobby && lobby.hostId === hostId && isCurrentLobbyStatus(lobby.status)) {
    return lobby
  }

  await stateStoreMdelete(kv, [hostKey(hostId)])
  return null
}

export async function getOpenLobbyForPlayer(
  kv: KVNamespace,
  playerId: string,
  mode?: GameMode,
): Promise<LobbyState | null> {
  const lobbies = mode ? await getLobbiesByMode(kv, mode) : await getAllLobbies(kv)
  return lobbies.find(lobby => lobby.status === 'open' && lobby.memberPlayerIds.includes(playerId)) ?? null
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
  if (lobby) await syncActivityOverviewSnapshot(kv, lobby.channelId)
}

export async function clearLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<void> {
  const lobbies = await getLobbiesByMode(kv, mode)
  if (lobbies.length === 0) return
  const channelIds = [...new Set(lobbies.map(lobby => lobby.channelId))]
  await stateStoreMdelete(kv, lobbies.flatMap((lobby) => {
    const keys = [idKey(lobby.id), lobbySnapshotKey(lobby.id), hostKey(lobby.hostId), bumpCooldownKey(lobby.id), modeIndexKey(mode, lobby.id), channelIndexKey(lobby.channelId, lobby.id)]
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
  const all = await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  return all.flat().sort((left, right) => left.createdAt - right.createdAt)
}

async function findHostKeysForLobby(kv: KVNamespace, lobbyId: string): Promise<string[]> {
  const listed = await kv.list({ prefix: LOBBY_HOST_KEY_PREFIX })
  const hostKeys = listed.keys.map(entry => entry.name)
  const hostLobbyIds = await stateStoreMget(kv, hostKeys.map(key => ({ key })))

  return hostKeys.filter((key, index) => hostLobbyIds[index] === lobbyId)
}
