import type { GameMode } from '@civup/game'
import type { Embed } from 'discord-hono'
import { createDb } from '@civup/db'
import { lobbyComponents, lobbyDraftingEmbed, lobbyOpenEmbed } from '../../embeds/lfg.ts'
import { createDraftRoom, storeMatchMapping, storeUserMatchMappings } from '../../services/activity.ts'
import { attachLobbyMatch, getLobby } from '../../services/lobby.ts'
import { createDraftMatch } from '../../services/match.ts'
import { buildDiscordAvatarUrl } from '../../services/player-profile.ts'
import { addToQueue, checkQueueFull, clearQueue, getPlayerQueueMode, getQueueState, removeFromQueue } from '../../services/queue.ts'

export const GAME_MODE_CHOICES = [
  { name: '1v1', value: '1v1' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
  { name: 'FFA', value: 'ffa' },
] as const

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
      DB: D1Database
      KV: KVNamespace
      PARTY_HOST?: string
      BOT_HOST?: string
      DRAFT_WEBHOOK_SECRET?: string
    }
  },
  mode: GameMode,
  userId: string,
  displayName: string,
  avatarUrl: string,
  channelId: string,
): Promise<
  | {
    stage: 'open'
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | {
    stage: 'drafting'
    matchId: string
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | { error: string }
> {
  const kv = c.env.KV
  const existingMode = await getPlayerQueueMode(kv, userId)
  if (existingMode && existingMode !== mode) {
    return { error: `You're already in the ${existingMode.toUpperCase()} queue. Leave it first with \`/lfg leave\`.` }
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

  const matchedEntries = await checkQueueFull(kv, mode)
  if (!matchedEntries) {
    const queue = await getQueueState(kv, mode)
    return {
      stage: 'open',
      embeds: [lobbyOpenEmbed(mode, queue.entries, queue.targetSize)],
      components: lobbyComponents(mode, 'open'),
    }
  }

  try {
    const activeLobby = await getLobby(kv, mode)

    const { matchId, formatId: _formatId, seats } = await createDraftRoom(mode, matchedEntries, {
      partyHost: c.env.PARTY_HOST,
      botHost: c.env.BOT_HOST,
      webhookSecret: c.env.DRAFT_WEBHOOK_SECRET,
      timerConfig: activeLobby?.draftConfig,
    })
    const db = createDb(c.env.DB)
    await createDraftMatch(db, { matchId, mode, seats })

    await clearQueue(kv, mode, matchedEntries.map(e => e.playerId))
    await storeMatchMapping(kv, channelId, matchId)
    await storeUserMatchMappings(kv, matchedEntries.map(e => e.playerId), matchId)
    await attachLobbyMatch(kv, mode, matchId)

    return {
      stage: 'drafting',
      matchId,
      embeds: [lobbyDraftingEmbed(mode, seats)],
      components: lobbyComponents(mode, 'drafting'),
    }
  }
  catch (error) {
    console.error('Failed to start draft match from lobby:', error)
    await removeFromQueue(kv, userId)
    return { error: 'Failed to start draft. Please try joining again.' }
  }
}
