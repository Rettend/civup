import type { GameMode, QueueEntry } from '@civup/game'
import type { Embed } from 'discord-hono'
import { formatModeLabel, maxPlayerCount } from '@civup/game'
import { buildDiscordAvatarUrl } from '@civup/utils'
import { lobbyComponents, lobbyOpenEmbed } from '../../embeds/match.ts'
import type { LobbyState } from '../../services/lobby.ts'
import { filterQueueEntriesForLobby, getLobbiesByMode, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbyMemberPlayerIds, setLobbySlots } from '../../services/lobby.ts'
import { getPlayerQueueMode, getQueueState, MAX_QUEUE_ENTRIES, setQueueEntries } from '../../services/queue.ts'
import { createStateStore } from '../../services/state-store.ts'

export const GAME_MODE_CHOICES = [
  { name: '1v1', value: '1v1' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
  { name: 'FFA', value: 'ffa' },
] as const

export const FFA_PLACEMENT_KEYS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'] as const
export type FfaPlacementKey = (typeof FFA_PLACEMENT_KEYS)[number]

export const LOBBY_STATUS_LABELS = {
  open: 'Lobby Open',
  drafting: 'Draft Ready',
  active: 'Draft Complete',
  completed: 'Result Reported',
  cancelled: 'Draft Cancelled',
  scrubbed: 'Match Scrubbed',
} as const

export interface MatchVar {
  mode?: string
  teammate?: string
  teammate2?: string
  player?: string
  match_id?: string
  winner?: string
  second?: string
  third?: string
  fourth?: string
  fifth?: string
  sixth?: string
  seventh?: string
  eighth?: string
  ninth?: string
  tenth?: string
}

export interface MatchJoinEntry {
  playerId: string
  displayName: string
  avatarUrl: string
  partyIds?: string[]
}

interface ResolvedInteractionUser {
  id?: string
  username?: string
  global_name?: string | null
  avatar?: string | null
}

interface ResolvedInteractionMember {
  nick?: string | null
  avatar?: string | null
}

interface ResolvedInteractionData {
  resolved?: {
    users?: Record<string, ResolvedInteractionUser>
    members?: Record<string, ResolvedInteractionMember>
  }
}

export function getIdentity(c: {
  interaction: {
    member?: { user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null } }
    user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null }
    data?: unknown
  }
}): { userId: string, displayName: string, avatarUrl: string } | null {
  const userId = c.interaction.member?.user?.id ?? c.interaction.user?.id
  if (!userId) return null

  const displayName = c.interaction.member?.user?.global_name
    ?? c.interaction.member?.user?.username
    ?? c.interaction.user?.global_name
    ?? c.interaction.user?.username
    ?? 'Unknown'

  const avatarHash = c.interaction.member?.user?.avatar
    ?? c.interaction.user?.avatar
    ?? null
  const avatarUrl = buildDiscordAvatarUrl(userId, avatarHash)

  return { userId, displayName, avatarUrl }
}

export function getIdentityByUserId(c: {
  interaction: {
    member?: { user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null } }
    user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null }
    data?: unknown
  }
}, userId: string): { userId: string, displayName: string, avatarUrl: string } | null {
  const self = getIdentity(c)
  if (self?.userId === userId) return self

  const resolved = (c.interaction.data as ResolvedInteractionData | undefined)?.resolved
  const user = resolved?.users?.[userId]
  if (!user) return null

  const member = resolved?.members?.[userId]
  const displayName = member?.nick
    ?? user.global_name
    ?? user.username
    ?? 'Unknown'
  const avatarHash = member?.avatar
    ?? user.avatar
    ?? null

  return {
    userId,
    displayName,
    avatarUrl: buildDiscordAvatarUrl(userId, avatarHash),
  }
}

export async function joinLobbyAndMaybeStartMatch(
  c: {
    env: {
      KV: KVNamespace
      PARTY_HOST?: string
      CIVUP_SECRET?: string
    }
  },
  mode: GameMode,
  requestedEntries: MatchJoinEntry[],
  options?: {
    preferredLobbyId?: string
  },
): Promise<
  | {
    stage: 'open'
    lobby: LobbyState
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | { error: string }
> {
  if (requestedEntries.length === 0) {
    return { error: 'No players were provided for this join request.' }
  }

  const seenPlayerIds = new Set<string>()
  for (const entry of requestedEntries) {
    if (seenPlayerIds.has(entry.playerId)) {
      return { error: 'Join request contains duplicate players.' }
    }
    seenPlayerIds.add(entry.playerId)
  }

  const kv = createStateStore(c.env)
  let queue = await getQueueState(kv, mode)
  const openLobbies = (await getLobbiesByMode(kv, mode)).filter(lobby => lobby.status === 'open')
  const queueByPlayerId = new Map<string, QueueEntry>(queue.entries.map(entry => [entry.playerId, entry]))
  const lobbyByPlayerId = new Map<string, LobbyState>()

  for (const lobby of openLobbies) {
    for (const playerId of lobby.memberPlayerIds) {
      if (!lobbyByPlayerId.has(playerId)) lobbyByPlayerId.set(playerId, lobby)
    }
  }

  for (const entry of requestedEntries) {
    const existingMode = queueByPlayerId.has(entry.playerId)
      ? mode
      : await getPlayerQueueMode(kv, entry.playerId)
    if (!existingMode || existingMode === mode) continue
    return {
      error: `<@${entry.playerId}> is already in the ${formatModeLabel(existingMode)} queue. Leave it first with \`/match leave\`.`,
    }
  }

  const existingLobbyIds = [...new Set(
    requestedEntries
      .map(entry => lobbyByPlayerId.get(entry.playerId)?.id ?? null)
      .filter((lobbyId): lobbyId is string => lobbyId != null),
  )]

  if (existingLobbyIds.length > 1) {
    return { error: 'This premade is already split across different open lobbies.' }
  }

  const nextEntries = [...queue.entries]
  const now = Date.now()
  let nextJoinedAt = now
  let queueChanged = false

  for (const entry of requestedEntries) {
    const normalizedPartyIds = normalizePartyIds(entry.playerId, entry.partyIds)
    const existingIndex = nextEntries.findIndex(candidate => candidate.playerId === entry.playerId)

    if (existingIndex >= 0) {
      const existing = nextEntries[existingIndex]
      if (!existing) continue
      if (existing.partyIds && existing.partyIds.length > 0 && !samePartyIds(existing.partyIds, normalizedPartyIds)) {
        return {
          error: `<@${entry.playerId}> is already grouped with different teammates. Ask them to run \`/match leave\` first.`,
        }
      }

      const merged: QueueEntry = {
        ...existing,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl,
        partyIds: normalizedPartyIds,
      }

      if (!sameQueueEntry(existing, merged)) {
        nextEntries[existingIndex] = merged
        queueChanged = true
      }
      continue
    }

    if (nextEntries.length >= MAX_QUEUE_ENTRIES) {
      return { error: `The **${formatModeLabel(mode)}** queue is full right now.` }
    }

    nextEntries.push({
      playerId: entry.playerId,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl,
      joinedAt: nextJoinedAt,
      partyIds: normalizedPartyIds,
    })
    nextJoinedAt += 1
    queueChanged = true
  }

  if (openLobbies.length === 0) {
    return { error: `No open ${formatModeLabel(mode)} lobby. Use \`/match create\` first.` }
  }

  const preferredLobbyId = options?.preferredLobbyId ?? existingLobbyIds[0] ?? null
  const candidateLobbies = preferredLobbyId
    ? openLobbies.filter(lobby => lobby.id === preferredLobbyId)
    : openLobbies

  const scoredCandidates = candidateLobbies
    .map((lobby) => {
      for (const requestedEntry of requestedEntries) {
        const existingLobby = lobbyByPlayerId.get(requestedEntry.playerId)
        if (existingLobby && existingLobby.id !== lobby.id) return null
      }

      const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, nextEntries)
      const currentSlots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
      const placement = placeRequestedEntries(mode, currentSlots, requestedEntries)
      if ('error' in placement) return null

      return {
        lobby,
        slots: placement.slots,
        score: scoreLobbyCandidate(lobby, currentSlots, placement.slots, requestedEntries.length),
      }
    })
    .filter((candidate): candidate is { lobby: LobbyState, slots: (string | null)[], score: string } => candidate != null)
    .sort((left, right) => left.score.localeCompare(right.score))

  const chosen = scoredCandidates[0]
  if (!chosen) {
    return { error: 'No compatible open lobby could fit this join.' }
  }

  let nextLobby = chosen.lobby
  const nextSlots = chosen.slots
  const nextMemberPlayerIds = [...new Set([...nextLobby.memberPlayerIds, ...requestedEntries.map(entry => entry.playerId)])]

  if (queueChanged) {
    await setQueueEntries(kv, mode, nextEntries, {
      currentState: queue,
    })
    queue = {
      ...queue,
      entries: nextEntries,
    }
  }

  if (nextMemberPlayerIds.length !== nextLobby.memberPlayerIds.length) {
    nextLobby = await setLobbyMemberPlayerIds(kv, nextLobby.id, nextMemberPlayerIds, nextLobby) ?? nextLobby
  }

  if (!sameLobbySlots(nextSlots, nextLobby.slots)) {
    nextLobby = await setLobbySlots(kv, nextLobby.id, nextSlots, nextLobby) ?? nextLobby
  }

  const slottedEntries = mapLobbySlotsToEntries(nextSlots, filterQueueEntriesForLobby(nextLobby, queue.entries))
  return {
    stage: 'open',
    lobby: nextLobby,
    embeds: [lobbyOpenEmbed(mode, slottedEntries, maxPlayerCount(mode))],
    components: lobbyComponents(mode, nextLobby.id),
  }
}

export function collectFfaPlacementUserIds(vars: Record<string, any>): string[] {
  const ordered: string[] = []
  if (vars.winner) ordered.push(vars.winner)
  for (const key of FFA_PLACEMENT_KEYS) {
    const userId = vars[key as FfaPlacementKey]
    if (!userId) continue
    ordered.push(userId)
  }
  return ordered
}

function normalizePartyIds(playerId: string, partyIds: string[] | undefined): string[] | undefined {
  if (!partyIds || partyIds.length === 0) return undefined
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const candidate of partyIds) {
    if (!candidate || candidate === playerId || seen.has(candidate)) continue
    normalized.push(candidate)
    seen.add(candidate)
  }

  return normalized.length > 0 ? normalized : undefined
}

function samePartyIds(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false

  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  for (let i = 0; i < sortedLeft.length; i++) {
    const leftValue = sortedLeft[i]
    const rightValue = sortedRight[i]
    if (!leftValue || !rightValue || leftValue !== rightValue) return false
  }

  return true
}

function sameQueueEntry(left: QueueEntry, right: QueueEntry): boolean {
  return left.playerId === right.playerId
    && left.displayName === right.displayName
    && (left.avatarUrl ?? null) === (right.avatarUrl ?? null)
    && left.joinedAt === right.joinedAt
    && samePartyIds(left.partyIds, right.partyIds)
}

function placeRequestedEntries(
  mode: GameMode,
  slots: (string | null)[],
  requestedEntries: MatchJoinEntry[],
): { slots: (string | null)[] } | { error: string } {
  const nextSlots = [...slots]
  const requestedPlayerIds = requestedEntries.map(entry => entry.playerId)
  const unslottedPlayerIds = requestedPlayerIds.filter(playerId => !nextSlots.includes(playerId))

  if (unslottedPlayerIds.length === 0) return { slots: nextSlots }

  if (mode !== '2v2' && mode !== '3v3') {
    for (const playerId of unslottedPlayerIds) {
      const emptySlot = nextSlots.findIndex(slot => slot == null)
      if (emptySlot < 0) break
      nextSlots[emptySlot] = playerId
    }
    return { slots: nextSlots }
  }

  if (requestedPlayerIds.length === 1) {
    const emptySlot = nextSlots.findIndex(slot => slot == null)
    if (emptySlot >= 0) nextSlots[emptySlot] = requestedPlayerIds[0]!
    return { slots: nextSlots }
  }

  const teamSize = mode === '2v2' ? 2 : 3
  const slottedTeamIndexes = requestedPlayerIds
    .map((playerId) => {
      const slotIndex = nextSlots.findIndex(slot => slot === playerId)
      if (slotIndex < 0) return null
      return slotIndex < teamSize ? 0 : 1
    })
    .filter((teamIndex): teamIndex is 0 | 1 => teamIndex != null)
  const uniqueTeamIndexes = [...new Set(slottedTeamIndexes)]

  let targetTeamIndex: number | null = null
  if (uniqueTeamIndexes.length > 1) {
    return { error: 'Your premade is already split across teams in this lobby. Ask the host to fix the team layout first.' }
  }
  if (uniqueTeamIndexes.length === 1) {
    targetTeamIndex = uniqueTeamIndexes[0]!
  }
  else {
    targetTeamIndex = chooseBestTeamForPremade(nextSlots, teamSize, unslottedPlayerIds.length)
  }

  if (targetTeamIndex == null) {
    return { error: 'Your premade cannot be placed on the same team in the current lobby layout.' }
  }

  const start = targetTeamIndex * teamSize
  const end = start + teamSize
  const teamEmptySlots = nextSlots
    .map((playerId, index) => ({ playerId, index }))
    .filter(({ index, playerId }) => index >= start && index < end && playerId == null)
    .map(({ index }) => index)

  if (teamEmptySlots.length < unslottedPlayerIds.length) {
    return { error: 'Your premade cannot be placed on the same team in the current lobby layout.' }
  }

  for (let index = 0; index < unslottedPlayerIds.length; index++) {
    const slotIndex = teamEmptySlots[index]
    const playerId = unslottedPlayerIds[index]
    if (slotIndex == null || !playerId) continue
    nextSlots[slotIndex] = playerId
  }

  return { slots: nextSlots }
}

function chooseBestTeamForPremade(
  slots: (string | null)[],
  teamSize: number,
  neededSlots: number,
): number | null {
  const candidates = [0, 1]
    .map((teamIndex) => {
      const start = teamIndex * teamSize
      const end = start + teamSize
      const teamSlots = slots.slice(start, end)
      const emptyCount = teamSlots.filter(slot => slot == null).length
      const occupiedCount = teamSlots.filter(slot => slot != null).length
      return { teamIndex, emptyCount, occupiedCount }
    })
    .filter(team => team.emptyCount >= neededSlots)
    .sort((left, right) => {
      if (right.occupiedCount !== left.occupiedCount) return right.occupiedCount - left.occupiedCount
      return left.teamIndex - right.teamIndex
    })

  return candidates[0]?.teamIndex ?? null
}

function scoreLobbyCandidate(
  lobby: LobbyState,
  currentSlots: (string | null)[],
  nextSlots: (string | null)[],
  joinedCount: number,
): string {
  const filledBefore = currentSlots.filter(slot => slot != null).length
  const filledAfter = nextSlots.filter(slot => slot != null).length
  const completionAfter = maxPlayerCount(lobby.mode) - filledAfter
  const fillGain = filledAfter - filledBefore
  const gapPenalty = countOpenGapPenalty(nextSlots)

  return [
    padNumber(completionAfter, 2),
    padNumber(-fillGain, 2),
    padNumber(gapPenalty, 2),
    padNumber(-joinedCount, 2),
    padNumber(lobby.createdAt, 14),
    lobby.id,
  ].join(':')
}

function countOpenGapPenalty(slots: (string | null)[]): number {
  let penalty = 0
  for (let index = 0; index < slots.length - 1; index++) {
    if (slots[index] == null && slots[index + 1] != null) penalty += 1
  }
  return penalty
}

function padNumber(value: number, width: number): string {
  const offset = 10 ** Math.max(width - 1, 1)
  return String(value + offset).padStart(width, '0')
}
