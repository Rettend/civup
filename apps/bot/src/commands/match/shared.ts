import type { createDb } from '@civup/db'
import type { GameMode, QueueEntry } from '@civup/game'
import type { Embed } from 'discord-hono'
import type { lobbyComponents } from '../../embeds/match.ts'
import type { LobbyState } from '../../services/lobby/index.ts'
import { matches, matchParticipants } from '@civup/db'
import { competitiveTierMeetsMaximum, competitiveTierMeetsMinimum, formatModeLabel, isTeamMode } from '@civup/game'
import { buildDiscordAvatarUrl } from '@civup/utils'
import { Option } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { deriveQueueBackedLobbyMemberPlayerIds, filterQueueEntriesForLobby, getCurrentLobbiesForPlayers, getLobbiesByMode, getOpenLobbyForPlayer, isQueueBackedOpenLobbyState, leaveOpenLobbyForLobbyJoin, mapLobbySlotsToEntries, normalizeLobbySlots, reconcileOpenLobbyState, sameLobbySlots, upsertLobby } from '../../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { buildOpenLobbyRenderPayload } from '../../services/lobby/render.ts'
import { getQueueState, getQueueStateWithPlayerQueueModes, MAX_QUEUE_ENTRIES, removeFromQueueAndUnlinkParty, setQueueEntries } from '../../services/queue/index.ts'
import { buildRankedRoleVisuals, fetchGuildMemberRoleIds, getRankedRoleConfig, resolveCurrentCompetitiveTierFromRoleIds } from '../../services/ranked/roles.ts'
import { createStateStore } from '../../services/state/store.ts'

const ALL_FFA_PLACEMENT_KEYS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'] as const
const FFA_PLACEMENT_LABELS: Record<(typeof ALL_FFA_PLACEMENT_KEYS)[number], string> = {
  second: '2nd place',
  third: '3rd place',
  fourth: '4th place',
  fifth: '5th place',
  sixth: '6th place',
  seventh: '7th place',
  eighth: '8th place',
  ninth: '9th place',
  tenth: '10th place',
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
  const [{ queueModeByPlayerId, queue: initialQueue }, modeLobbies] = await Promise.all([
    getQueueStateWithPlayerQueueModes(kv, mode, requestedEntries.map(entry => entry.playerId), { fallbackToQueueScan: false }),
    getLobbiesByMode(kv, mode),
  ])
  let queue = initialQueue
  const openLobbies = modeLobbies.filter(lobby => lobby.status === 'open' && isQueueBackedOpenLobbyState(lobby, queue.entries))
  const queueByPlayerId = new Map<string, QueueEntry>(queue.entries.map(entry => [entry.playerId, entry]))
  const lobbyByPlayerId = new Map<string, LobbyState>()

  for (const lobby of openLobbies) {
    for (const playerId of deriveQueueBackedLobbyMemberPlayerIds(lobby, queue.entries)) {
      if (!lobbyByPlayerId.has(playerId)) lobbyByPlayerId.set(playerId, lobby)
    }
  }

  const sameModeLobbyIds = [...new Set(requestedEntries
    .map(entry => lobbyByPlayerId.get(entry.playerId)?.id ?? null)
    .filter((lobbyId): lobbyId is string => lobbyId != null))]
  if (sameModeLobbyIds.length > 1) return { error: 'Requested players are already split across different open lobbies.' }

  let currentOpenLobby = sameModeLobbyIds.length === 1
    ? openLobbies.find(lobby => lobby.id === sameModeLobbyIds[0]) ?? null
    : null

  const conflictingQueuePlayerIds = requestedEntries
    .map(entry => {
      const existingMode = queueByPlayerId.has(entry.playerId) ? mode : (queueModeByPlayerId.get(entry.playerId) ?? null)
      return existingMode && existingMode !== mode ? entry.playerId : null
    })
    .filter((playerId): playerId is string => playerId != null)

  if (conflictingQueuePlayerIds.length > 0) {
    const currentLobbiesByPlayerId = await getCurrentLobbiesForPlayers(kv, conflictingQueuePlayerIds)
    const liveLobbyPlayerId = conflictingQueuePlayerIds.find(playerId => {
      const lobby = currentLobbiesByPlayerId.get(playerId)
      return lobby != null && lobby.status !== 'open'
    })
    if (liveLobbyPlayerId) {
      return { error: `<@${liveLobbyPlayerId}> is already in a live match.` }
    }

    const conflictingOpenLobbies = [...new Set(
      conflictingQueuePlayerIds
        .map(playerId => currentLobbiesByPlayerId.get(playerId)?.id ?? null)
        .filter((lobbyId): lobbyId is string => lobbyId != null),
    )]
    if (conflictingOpenLobbies.length > 1) return { error: 'Requested players are already split across different open lobbies.' }

    if (conflictingOpenLobbies.length === 1) {
      const conflictingLobby = currentLobbiesByPlayerId.get(conflictingQueuePlayerIds[0]!) ?? null
      if (conflictingLobby && currentOpenLobby && conflictingLobby.id !== currentOpenLobby.id) {
        return { error: 'Requested players are already split across different open lobbies.' }
      }
      currentOpenLobby = conflictingLobby
    }
  }

  for (const entry of requestedEntries) {
    if (options?.liveMatchPlayerIds?.has(entry.playerId)) {
      return { error: `<@${entry.playerId}> is already in a live match.` }
    }

    const existingMode = queueByPlayerId.has(entry.playerId) ? mode : (queueModeByPlayerId.get(entry.playerId) ?? null)
    if (!existingMode || existingMode === mode) continue
    if (currentOpenLobby?.memberPlayerIds.includes(entry.playerId)) continue
    return {
      error: `<@${entry.playerId}> is already in a ${formatModeLabel(existingMode)} lobby.`,
    }
  }

  const preferredLobbyId = options?.preferredLobbyId ?? (currentOpenLobby?.mode === mode ? currentOpenLobby.id : null)

  const nextEntries = [...queue.entries]
  const now = Date.now()
  let nextJoinedAt = now
  let queueChanged = false

  for (const entry of requestedEntries) {
    const existingIndex = nextEntries.findIndex(candidate => candidate.playerId === entry.playerId)

    if (existingIndex >= 0) {
      const existing = nextEntries[existingIndex]
      if (!existing) continue

      const merged: QueueEntry = {
        ...existing,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl,
        partyIds: undefined,
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
      const candidateLobbyMemberPlayerIds = deriveQueueBackedLobbyMemberPlayerIds(lobby, nextEntries)
      const candidateLobbyQueueEntries = filterQueueEntriesForLobby({
        ...lobby,
        memberPlayerIds: candidateLobbyMemberPlayerIds,
      }, nextEntries)
      const candidateCurrentSlots = normalizeLobbySlots(mode, lobby.slots, candidateLobbyQueueEntries)
      const candidateLobby = {
        ...lobby,
        memberPlayerIds: candidateLobbyMemberPlayerIds,
        slots: candidateCurrentSlots,
      }

      const gateError = await getRoleGateErrorForLobby(
        c.env.DISCORD_TOKEN,
        kv,
        candidateLobby,
        requestedEntries,
        rankedRoleConfigByGuildId,
        memberRoleIdsByKey,
        options?.skipMatchmakingRankGate === true,
      )
      if (gateError) {
        return { gateError }
      }

      const placement = placeRequestedEntries(mode, candidateCurrentSlots, requestedEntries)
      if ('error' in placement) return null

      return {
        lobby: candidateLobby,
        slots: placement.slots,
        score: scoreLobbyCandidate(candidateLobby, candidateCurrentSlots, placement.slots, requestedEntries.length),
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

  if (currentOpenLobby && currentOpenLobby.id !== chosen.lobby.id) {
    const transferResult = await leaveOpenLobbyForLobbyJoin(
      kv,
      c.env.DISCORD_TOKEN,
      currentOpenLobby,
      requestedEntries.map(entry => entry.playerId),
      mode,
    )
    if (!transferResult.ok) {
      return { error: transferResult.error }
    }
  }

  const reconciledChosen = await reconcileOpenLobbyState(kv, chosen.lobby, { currentQueue: queue })
  let nextLobby = reconciledChosen?.lobby ?? chosen.lobby
  nextLobby = {
    ...nextLobby,
    memberPlayerIds: deriveQueueBackedLobbyMemberPlayerIds(nextLobby, nextEntries),
  }
  const nextLobbyQueueEntriesBeforePlacement = filterQueueEntriesForLobby(nextLobby, nextEntries)
  nextLobby = {
    ...nextLobby,
    slots: normalizeLobbySlots(mode, nextLobby.slots, nextLobbyQueueEntriesBeforePlacement),
  }
  const chosenPlacement = placeRequestedEntries(mode, nextLobby.slots, requestedEntries)
  if ('error' in chosenPlacement) return { error: chosenPlacement.error }
  const nextSlots = chosenPlacement.slots
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

  if (nextMemberPlayerIds.length !== nextLobby.memberPlayerIds.length || !sameLobbySlots(nextSlots, nextLobby.slots) || addedNewPlayers) {
    nextLobby = {
      ...nextLobby,
      memberPlayerIds: nextMemberPlayerIds,
      slots: nextSlots,
      lastActivityAt: addedNewPlayers ? now : nextLobby.lastActivityAt,
      updatedAt: now,
      revision: nextLobby.revision + 1,
    }
    await upsertLobby(kv, nextLobby)
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

export async function findActiveMatchIdsForPlayers(
  db: ReturnType<typeof createDb>,
  playerIds: string[],
): Promise<Map<string, string[]>> {
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
      eq(matches.status, 'active'),
    ))
    .orderBy(desc(matches.createdAt))

  const activeMatchIdsByPlayerId = new Map<string, string[]>()
  for (const row of rows) {
    const existing = activeMatchIdsByPlayerId.get(row.playerId)
    if (existing) {
      existing.push(row.matchId)
      continue
    }

    activeMatchIdsByPlayerId.set(row.playerId, [row.matchId])
  }

  return activeMatchIdsByPlayerId
}

/**
 * Resolve whether `/match create` is blocked by a real current lobby, or only by stale queue residue.
 */
export async function preflightMatchCreateQueueState(
  kv: KVNamespace,
  mode: GameMode,
  playerId: string,
): Promise<
  | { kind: 'continue', queue: Awaited<ReturnType<typeof getQueueState>> }
  | { kind: 'reuse-hosted-open-lobby', queue: Awaited<ReturnType<typeof getQueueState>>, lobby: LobbyState }
  | { kind: 'block-open-lobby', queue: Awaited<ReturnType<typeof getQueueState>>, lobby: LobbyState }
> {
  const { queue: initialQueue, queueModeByPlayerId } = await getQueueStateWithPlayerQueueModes(
    kv,
    mode,
    [playerId],
    { fallbackToQueueScan: false },
  )
  const existingQueueMode = queueModeByPlayerId.get(playerId) ?? null
  if (!existingQueueMode) return { kind: 'continue', queue: initialQueue }

  const currentOpenLobby = await getOpenLobbyForPlayer(kv, playerId, existingQueueMode)
  if (currentOpenLobby) {
    return {
      kind: currentOpenLobby.hostId === playerId ? 'reuse-hosted-open-lobby' : 'block-open-lobby',
      queue: initialQueue,
      lobby: currentOpenLobby,
    }
  }

  const removed = await removeFromQueueAndUnlinkParty(kv, playerId)
  return {
    kind: 'continue',
    queue: removed.mode === mode ? await getQueueState(kv, mode) : initialQueue,
  }
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

function sameQueueEntry(left: QueueEntry, right: QueueEntry): boolean {
  return left.playerId === right.playerId
    && left.displayName === right.displayName
    && (left.avatarUrl ?? null) === (right.avatarUrl ?? null)
    && left.joinedAt === right.joinedAt
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

  for (const playerId of unslottedPlayerIds) {
    const emptySlot = nextSlots.findIndex(slot => slot == null)
    if (emptySlot < 0) break
    nextSlots[emptySlot] = playerId
  }

  return { slots: nextSlots }
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
