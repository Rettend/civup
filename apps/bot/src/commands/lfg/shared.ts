import type { GameMode } from '@civup/game'
import type { Embed } from 'discord-hono'
import { formatModeLabel, maxPlayerCount } from '@civup/game'
import { lobbyComponents, lobbyOpenEmbed } from '../../embeds/lfg.ts'
import {
  getLobby,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  sameLobbySlots,
  setLobbySlots,
} from '../../services/lobby.ts'
import { buildDiscordAvatarUrl } from '../../services/player-profile.ts'
import { addToQueue, getPlayerQueueMode, getQueueState } from '../../services/queue.ts'

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

export interface LfgVar {
  mode?: string
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

export function getIdentity(c: {
  interaction: {
    member?: { user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null } }
    user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null }
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

export async function joinLobbyAndMaybeStartMatch(
  c: {
    env: {
      KV: KVNamespace
    }
  },
  mode: GameMode,
  userId: string,
  displayName: string,
  avatarUrl: string,
  _channelId: string,
): Promise<
  | {
    stage: 'open'
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | { error: string }
> {
  const kv = c.env.KV
  const existingMode = await getPlayerQueueMode(kv, userId)
  if (existingMode && existingMode !== mode) {
    return { error: `You're already in the ${formatModeLabel(existingMode)} queue. Leave it first with \`/lfg leave\`.` }
  }

  let shouldJoinQueue = !existingMode
  if (existingMode === mode) {
    const queue = await getQueueState(kv, mode)
    shouldJoinQueue = !queue.entries.some(entry => entry.playerId === userId)
  }

  if (shouldJoinQueue) {
    const joined = await addToQueue(kv, mode, {
      playerId: userId,
      displayName,
      avatarUrl,
      joinedAt: Date.now(),
    })
    if (joined.error) return { error: joined.error }
  }

  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.status !== 'open') {
    return { error: `No open ${formatModeLabel(mode)} lobby. Use \`/lfg create\` first.` }
  }

  const queue = await getQueueState(kv, mode)
  const slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
  const nextSlots = [...slots]

  if (!nextSlots.includes(userId)) {
    const emptySlot = nextSlots.findIndex(slot => slot == null)
    if (emptySlot >= 0) nextSlots[emptySlot] = userId
  }

  if (!sameLobbySlots(nextSlots, lobby.slots)) {
    await setLobbySlots(kv, mode, nextSlots)
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
