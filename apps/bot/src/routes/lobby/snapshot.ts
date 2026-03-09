import type { CompetitiveTier, GameMode } from '@civup/game'
import type { LobbyState } from '../../services/lobby/index.ts'
import type { RankedRoleVisual } from '../../services/ranked/roles.ts'
import { GAME_MODES, maxPlayerCount, minPlayerCount } from '@civup/game'
import { getServerDraftTimerDefaults, MAX_CONFIG_TIMER_SECONDS } from '../../services/config/index.ts'
import { filterQueueEntriesForLobby, getLobbiesByMode, getLobbyById, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbySlots } from '../../services/lobby/index.ts'
import { getQueueState } from '../../services/queue/index.ts'
import { buildRankedRoleVisuals, fetchGuildMemberRoleIds, getRankedRoleConfig, getRankedRoleGateError, memberMeetsRankedRoleGate, normalizeRankedRoleTierId } from '../../services/ranked/roles.ts'

const TEMP_LOBBY_START_MIN_PLAYERS_FFA = 1

export async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
) {
  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

  if (sameLobbySlots(normalizedSlots, lobby.slots)) {
    return buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, normalizedSlots)
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, normalizedSlots)
  const resolvedLobby = updatedLobby ?? {
    ...lobby,
    slots: normalizedSlots,
  }
  return buildOpenLobbySnapshotFromParts(kv, mode, resolvedLobby, lobbyQueueEntries, normalizedSlots)
}

export async function buildOpenLobbySnapshotFromParts(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  slots: (string | null)[],
) {
  const slotEntries = mapLobbySlotsToEntries(slots, queueEntries)
  const serverDefaults = await getServerDraftTimerDefaults(kv)

  return {
    id: lobby.id,
    revision: lobby.revision,
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    minRole: lobby.minRole,
    entries: slotEntries.map((entry) => {
      if (!entry) return null
      return {
        playerId: entry.playerId,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl ?? null,
        partyIds: entry.partyIds ?? [],
      }
    }),
    minPlayers: lobbyMinPlayerCount(mode),
    targetSize: maxPlayerCount(mode),
    draftConfig: lobby.draftConfig,
    serverDefaults,
  }
}

export function lobbyMinPlayerCount(mode: GameMode): number {
  if (mode === 'ffa') return TEMP_LOBBY_START_MIN_PLAYERS_FFA
  return minPlayerCount(mode)
}

export function canStartLobbyWithPlayerCount(mode: GameMode, playerCount: number): boolean {
  if (mode === 'ffa') {
    return playerCount >= lobbyMinPlayerCount(mode) && playerCount <= maxPlayerCount(mode)
  }
  return playerCount === maxPlayerCount(mode)
}

export async function getUniqueOpenLobbyForChannel(kv: KVNamespace, channelId: string): Promise<LobbyState | null> {
  const lobbiesByMode = await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  const openLobbies = lobbiesByMode
    .flat()
    .filter(lobby => lobby.channelId === channelId && lobby.status === 'open')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

export async function resolveOpenLobbyFromBody(
  kv: KVNamespace,
  mode: GameMode,
  body: { lobbyId?: unknown },
): Promise<LobbyState | null> {
  if (typeof body.lobbyId === 'string' && body.lobbyId.length > 0) {
    const lobby = await getLobbyById(kv, body.lobbyId)
    if (!lobby || lobby.mode !== mode || lobby.status !== 'open') return null
    return lobby
  }

  const lobbies = await getLobbiesByMode(kv, mode)
  const openLobbies = lobbies.filter(lobby => lobby.status === 'open')
  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

export function buildLobbyQueueEntries(
  lobby: LobbyState,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
) {
  return filterQueueEntriesForLobby(lobby, queueEntries)
}

export function parseSlotIndex(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric)) return null
  if (numeric < 0) return null
  return numeric
}

export function parseLobbyTimerSeconds(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null

  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const rounded = Math.round(numeric)
  if (rounded < 0 || rounded > MAX_CONFIG_TIMER_SECONDS) return undefined
  return rounded
}

export function parseLobbyMinRole(value: unknown): CompetitiveTier | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return normalizeRankedRoleTierId(value) ?? undefined
}

export async function validatePlayerAgainstLobbyMinRole(
  token: string,
  kv: KVNamespace,
  lobby: LobbyState,
  playerId: string,
): Promise<string | null> {
  if (!lobby.minRole) return null
  if (!lobby.guildId) return 'This lobby is missing guild context, so rank gating is unavailable.'

  const config = await getRankedRoleConfig(kv, lobby.guildId)
  const gateError = getRankedRoleGateError(config, lobby.minRole)
  if (gateError) return gateError
  const visuals = buildRankedRoleVisuals(config)
  const minRoleVisual = getRankedRoleVisualForTier(visuals, lobby.minRole)

  const roleIds = await fetchGuildMemberRoleIds(token, lobby.guildId, playerId)
  if (memberMeetsRankedRoleGate(roleIds, lobby.minRole, config)) return null
  return `This lobby requires at least ${minRoleVisual?.label ?? 'that ranked role'}.`
}

export async function validateLobbyMembersAgainstMinRole(
  token: string,
  lobby: LobbyState,
  lobbyQueueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  minRole: CompetitiveTier,
): Promise<{
  error: string
  errorCode: string
  context?: {
    playerId: string
    playerName: string
    minRole: RankedRoleVisual
  }
} | null> {
  if (!lobby.guildId) {
    return {
      error: 'This lobby is missing guild context, so rank gating is unavailable.',
      errorCode: 'MIN_ROLE_CONTEXT_MISSING',
    }
  }

  const visuals = buildRankedRoleVisuals(config)
  const minRoleVisual = getRankedRoleVisualForTier(visuals, minRole)
  if (!minRoleVisual) {
    return {
      error: 'This minimum ranked role is not configured yet. Ask an admin to run /admin ranked roles.',
      errorCode: 'MIN_ROLE_NOT_CONFIGURED',
    }
  }
  const queueEntryByPlayerId = new Map(lobbyQueueEntries.map(entry => [entry.playerId, entry]))

  for (const playerId of lobby.memberPlayerIds) {
    const roleIds = await fetchGuildMemberRoleIds(token, lobby.guildId, playerId)
    if (memberMeetsRankedRoleGate(roleIds, minRole, config)) continue

    const playerName = queueEntryByPlayerId.get(playerId)?.displayName ?? 'Unknown player'
    return {
      error: `${playerName} does not meet the new minimum rank ${minRoleVisual.label}.`,
      errorCode: 'MIN_ROLE_MEMBER_MISMATCH',
      context: {
        playerId,
        playerName,
        minRole: minRoleVisual,
      },
    }
  }

  return null
}

export function emptyRankedRoleConfig(): Awaited<ReturnType<typeof getRankedRoleConfig>> {
  return {
    tiers: Array.from({ length: 5 }, () => ({ roleId: null, label: null, color: null })),
  }
}

function getRankedRoleVisualForTier(visuals: RankedRoleVisual[], tier: CompetitiveTier): RankedRoleVisual | null {
  return visuals.find(visual => visual.tier === tier) ?? null
}
