import type { createDb } from '@civup/db'
import type { GameMode, QueueEntry } from '@civup/game'
import type { Embed } from 'discord-hono'
import type { lobbyComponents } from '../../embeds/match.ts'
import type { LobbyState } from '../../services/lobby/index.ts'
import { matches, matchParticipants } from '@civup/db'
import { competitiveTierMeetsMaximum, competitiveTierMeetsMinimum, formatModeLabel, isTeamMode, teamCount as modeTeamCount, teamSize as modeTeamSize, slotToTeamIndex } from '@civup/game'
import { buildDiscordAvatarUrl } from '@civup/utils'
import { Option } from 'discord-hono'
import { and, eq, inArray } from 'drizzle-orm'
import { filterQueueEntriesForLobby, getLobbiesByMode, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbyLastActivityAt, setLobbyMemberPlayerIds, setLobbySlots } from '../../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { buildOpenLobbyRenderPayload } from '../../services/lobby/render.ts'
import { getQueueStates, MAX_QUEUE_ENTRIES, setQueueEntries } from '../../services/queue/index.ts'
import { buildRankedRoleVisuals, fetchGuildMemberRoleIds, getRankedRoleConfig, resolveCurrentCompetitiveTierFromRoleIds } from '../../services/ranked/roles.ts'
import { createStateStore } from '../../services/state/store.ts'

const ALL_FFA_PLACEMENT_KEYS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'] as const
const FFA_PLACEMENT_LABELS: Record<(typeof ALL_FFA_PLACEMENT_KEYS)[number], string> = {
  second: 'FFA 2nd place',
  third: 'FFA 3rd place',
  fourth: 'FFA 4th place',
  fifth: 'FFA 5th place',
  sixth: 'FFA 6th place',
  seventh: 'FFA 7th place',
  eighth: 'FFA 8th place',
  ninth: 'FFA 9th place',
  tenth: 'FFA 10th place',
}

export const FFA_PLACEMENT_KEYS = ALL_FFA_PLACEMENT_KEYS
export type FfaPlacementKey = (typeof FFA_PLACEMENT_KEYS)[number]

export const LOBBY_STATUS_LABELS = {
  open: 'Lobby Open',
  drafting: 'Drafting',
  active: 'Draft Complete',
  completed: 'Result Reported',
  cancelled: 'Draft Cancelled',
  scrubbed: 'Match Scrubbed',
} as const

export interface MatchVar {
  mode?: string
  steam_link?: string
  teammate?: string
  teammate2?: string
  teammate3?: string
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

export function buildFfaPlacementOptions() {
  return FFA_PLACEMENT_KEYS.map(key => new Option(key, FFA_PLACEMENT_LABELS[key], 'User'))
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
      DISCORD_TOKEN?: string
      PARTY_HOST?: string
      CIVUP_SECRET?: string
    }
  },
  mode: GameMode,
  requestedEntries: MatchJoinEntry[],
  options?: {
    preferredLobbyId?: string
    skipMatchmakingRankGate?: boolean
    liveMatchPlayerIds?: ReadonlySet<string>
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
  const queueStates = await getQueueStates(kv)
  let queue = queueStates.get(mode)
  if (!queue) throw new Error(`Queue state missing for mode ${mode}`)
  const openLobbies = (await getLobbiesByMode(kv, mode)).filter(lobby => lobby.status === 'open')
  const queueByPlayerId = new Map<string, QueueEntry>(queue.entries.map(entry => [entry.playerId, entry]))
  const queueModeByPlayerId = new Map<string, GameMode>()
  const lobbyByPlayerId = new Map<string, LobbyState>()

  for (const queueState of queueStates.values()) {
    for (const entry of queueState.entries) {
      if (!queueModeByPlayerId.has(entry.playerId)) queueModeByPlayerId.set(entry.playerId, queueState.mode)
    }
  }

  for (const lobby of openLobbies) {
    for (const playerId of lobby.memberPlayerIds) {
      if (!lobbyByPlayerId.has(playerId)) lobbyByPlayerId.set(playerId, lobby)
    }
  }

  for (const entry of requestedEntries) {
    if (options?.liveMatchPlayerIds?.has(entry.playerId)) {
      return { error: `<@${entry.playerId}> is already in a live match.` }
    }

    const existingMode = queueByPlayerId.has(entry.playerId) ? mode : (queueModeByPlayerId.get(entry.playerId) ?? null)
    if (!existingMode || existingMode === mode) continue
    return {
      error: `<@${entry.playerId}> is already in a ${formatModeLabel(existingMode)} lobby.`,
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

  const preferredLobbyId = options?.preferredLobbyId ?? existingLobbyIds[0] ?? null
  if (preferredLobbyId && existingLobbyIds.length === 1 && existingLobbyIds[0] !== preferredLobbyId) {
    return { error: 'You are already in another open lobby.' }
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

  const candidateLobbies = preferredLobbyId
    ? openLobbies.filter(lobby => lobby.id === preferredLobbyId)
    : openLobbies
  const rankedRoleConfigByGuildId = new Map<string, Awaited<ReturnType<typeof getRankedRoleConfig>>>()
  const memberRoleIdsByKey = new Map<string, string[]>()

  const candidateResults = await Promise.all(candidateLobbies
    .map(async (lobby) => {
      for (const requestedEntry of requestedEntries) {
        const existingLobby = lobbyByPlayerId.get(requestedEntry.playerId)
        if (existingLobby && existingLobby.id !== lobby.id) return null
      }

      const gateError = await getRoleGateErrorForLobby(
        c.env.DISCORD_TOKEN,
        kv,
        lobby,
        requestedEntries,
        rankedRoleConfigByGuildId,
        memberRoleIdsByKey,
        options?.skipMatchmakingRankGate === true,
      )
      if (gateError) {
        return { gateError }
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
    }))

  const scoredCandidates = candidateResults
    .filter((candidate): candidate is { lobby: LobbyState, slots: (string | null)[], score: string } => candidate != null && 'lobby' in candidate)
    .sort((left, right) => left.score.localeCompare(right.score))

  const chosen = scoredCandidates[0]
  if (!chosen) {
    const gateError = candidateResults.find((result): result is { gateError: string } => result != null && 'gateError' in result)?.gateError
    if (gateError) return { error: gateError }
    return { error: 'No compatible open lobby could fit this join.' }
  }

  let nextLobby = chosen.lobby
  const nextSlots = chosen.slots
  const nextMemberPlayerIds = [...new Set([...nextLobby.memberPlayerIds, ...requestedEntries.map(entry => entry.playerId)])]
  const addedNewPlayers = nextMemberPlayerIds.length !== nextLobby.memberPlayerIds.length

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

  if (addedNewPlayers) {
    nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, now, nextLobby) ?? nextLobby
  }

  const finalQueueEntries = filterQueueEntriesForLobby(nextLobby, queue.entries)
  await syncLobbyDerivedState(kv, nextLobby, {
    queueEntries: finalQueueEntries,
    slots: nextSlots,
  })

  const slottedEntries = mapLobbySlotsToEntries(nextSlots, finalQueueEntries)
  const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
  return {
    stage: 'open',
    lobby: nextLobby,
    embeds: renderPayload.embeds,
    components: renderPayload.components,
  }
}

export async function findLiveMatchIdsForPlayers(
  db: ReturnType<typeof createDb>,
  playerIds: string[],
): Promise<Map<string, string>> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return new Map()

  const rows = await db
    .select({
      playerId: matchParticipants.playerId,
      matchId: matchParticipants.matchId,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(
      inArray(matchParticipants.playerId, uniquePlayerIds),
      inArray(matches.status, ['drafting', 'active']),
    ))

  const liveMatchIdByPlayerId = new Map<string, string>()
  for (const row of rows) {
    if (!liveMatchIdByPlayerId.has(row.playerId)) {
      liveMatchIdByPlayerId.set(row.playerId, row.matchId)
    }
  }
  return liveMatchIdByPlayerId
}

async function getRoleGateErrorForLobby(
  token: string | undefined,
  kv: KVNamespace,
  lobby: LobbyState,
  requestedEntries: MatchJoinEntry[],
  rankedRoleConfigByGuildId: Map<string, Awaited<ReturnType<typeof getRankedRoleConfig>>>,
  memberRoleIdsByKey: Map<string, string[]>,
  skipMatchmakingRankGate: boolean,
): Promise<string | null> {
  if (skipMatchmakingRankGate) return null
  if (!lobby.minRole && !lobby.maxRole) return null
  if (!lobby.guildId) return 'This lobby is missing guild context, so rank gating is unavailable.'
  if (!token) return 'Rank-gated lobbies are unavailable because the bot token is missing.'

  let config = rankedRoleConfigByGuildId.get(lobby.guildId)
  if (!config) {
    config = await getRankedRoleConfig(kv, lobby.guildId)
    rankedRoleConfigByGuildId.set(lobby.guildId, config)
  }

  const visuals = buildRankedRoleVisuals(config)
  const minGateLabel = lobby.minRole
    ? (visuals.find(option => option.tier === lobby.minRole)?.label ?? 'that ranked role')
    : null
  const maxGateLabel = lobby.maxRole
    ? (visuals.find(option => option.tier === lobby.maxRole)?.label ?? 'that ranked role')
    : null

  for (const entry of requestedEntries) {
    if (lobby.memberPlayerIds.includes(entry.playerId)) continue

    const memberKey = `${lobby.guildId}:${entry.playerId}`
    let roleIds = memberRoleIdsByKey.get(memberKey)
    if (!roleIds) {
      roleIds = await fetchGuildMemberRoleIds(token, lobby.guildId, entry.playerId)
      memberRoleIdsByKey.set(memberKey, roleIds)
    }

    const currentTier = resolveCurrentCompetitiveTierFromRoleIds(roleIds, config)
    if (!competitiveTierMeetsMinimum(currentTier, lobby.minRole)) return `This lobby requires at least ${minGateLabel}.`
    if (!competitiveTierMeetsMaximum(currentTier, lobby.maxRole)) return `This lobby allows up to ${maxGateLabel}.`
  }

  return null
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

  if (!isTeamMode(mode)) {
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

  const teamSize = modeTeamSize(mode) ?? 0
  const totalTeams = modeTeamCount(mode, nextSlots.filter(slot => slot != null).length + unslottedPlayerIds.length)
  const slottedTeamIndexes = requestedPlayerIds
    .map((playerId) => {
      const slotIndex = nextSlots.findIndex(slot => slot === playerId)
      if (slotIndex < 0) return null
      return slotToTeamIndex(mode, slotIndex, nextSlots.length)
    })
    .filter((teamIndex): teamIndex is Exclude<typeof teamIndex, null> => teamIndex != null)
  const uniqueTeamIndexes = [...new Set(slottedTeamIndexes)]

  let targetTeamIndex: number | null = null
  if (uniqueTeamIndexes.length > 1) {
    return { error: 'Your premade is already split across teams in this lobby. Ask the host to fix the team layout first.' }
  }
  if (uniqueTeamIndexes.length === 1) {
    targetTeamIndex = uniqueTeamIndexes[0]!
  }
  else {
    targetTeamIndex = chooseBestTeamForPremade(nextSlots, teamSize, totalTeams, unslottedPlayerIds.length)
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
  totalTeams: number,
  neededSlots: number,
): number | null {
  const candidates = Array.from({ length: totalTeams }, (_, teamIndex) => teamIndex)
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
  const completionAfter = lobby.slots.length - filledAfter
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
