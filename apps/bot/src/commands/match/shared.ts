import type { GameMode, QueueEntry } from '@civup/game'
import type { Embed } from 'discord-hono'
import { formatModeLabel, maxPlayerCount } from '@civup/game'
import { buildDiscordAvatarUrl } from '@civup/utils'
import { lobbyComponents, lobbyOpenEmbed } from '../../embeds/match.ts'
import { getLobbyAndQueueState } from '../../services/lobby-queue.ts'
import { getLobby, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbySlots } from '../../services/lobby.ts'
import { getPlayerQueueMode, MAX_QUEUE_ENTRIES, setQueueEntries } from '../../services/queue.ts'
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
  _channelId: string,
): Promise<
  | {
    stage: 'open'
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
  const lobbyAndQueue = await getLobbyAndQueueState(kv, mode)
  let queue = lobbyAndQueue.queue
  const queueByPlayerId = new Map<string, QueueEntry>(queue.entries.map(entry => [entry.playerId, entry]))

  for (const entry of requestedEntries) {
    const existingMode = queueByPlayerId.has(entry.playerId)
      ? mode
      : await getPlayerQueueMode(kv, entry.playerId)
    if (!existingMode || existingMode === mode) continue
    return {
      error: `<@${entry.playerId}> is already in the ${formatModeLabel(existingMode)} queue. Leave it first with \`/match leave\`.`,
    }
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

  if (queueChanged) {
    await setQueueEntries(kv, mode, nextEntries, {
      currentState: queue,
    })
    queue = {
      ...queue,
      entries: nextEntries,
    }
  }

  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.status !== 'open') {
    return { error: `No open ${formatModeLabel(mode)} lobby. Use \`/match create\` first.` }
  }

  const slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
  const nextSlots = [...slots]

  for (const entry of requestedEntries) {
    if (nextSlots.includes(entry.playerId)) continue
    const emptySlot = nextSlots.findIndex(slot => slot == null)
    if (emptySlot >= 0) nextSlots[emptySlot] = entry.playerId
  }

  if (!sameLobbySlots(nextSlots, lobby.slots)) {
    await setLobbySlots(kv, mode, nextSlots, lobby)
  }

  const slottedEntries = mapLobbySlotsToEntries(nextSlots, queue.entries)
  return {
    stage: 'open',
    embeds: [lobbyOpenEmbed(mode, slottedEntries, maxPlayerCount(mode))],
    components: lobbyComponents(mode),
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
