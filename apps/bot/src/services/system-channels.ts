import type { LeaderboardMode } from '@civup/game'

export type SystemChannelType = 'draft' | 'archive' | 'leaderboard'

export interface LeaderboardMessageState {
  channelId: string
  messageIds: Record<LeaderboardMode, string>
  updatedAt: number
}

interface StoredLeaderboardMessageState {
  channelId: string
  messageIds: Partial<Record<LeaderboardMode, string>>
  updatedAt?: number
}

const SYSTEM_CHANNEL_KEY_PREFIX = 'system:channel:'
const LEADERBOARD_MESSAGE_STATE_KEY = 'system:leaderboard:messages'

function systemChannelKey(type: SystemChannelType): string {
  return `${SYSTEM_CHANNEL_KEY_PREFIX}${type}`
}

export async function getSystemChannel(kv: KVNamespace, type: SystemChannelType): Promise<string | null> {
  return await kv.get(systemChannelKey(type))
}

export async function setSystemChannel(kv: KVNamespace, type: SystemChannelType, channelId: string): Promise<void> {
  await kv.put(systemChannelKey(type), channelId)
}

export async function clearSystemChannel(kv: KVNamespace, type: SystemChannelType): Promise<void> {
  await kv.delete(systemChannelKey(type))
}

export async function getLeaderboardMessageState(kv: KVNamespace): Promise<LeaderboardMessageState | null> {
  const raw = await kv.get(LEADERBOARD_MESSAGE_STATE_KEY, 'json') as StoredLeaderboardMessageState | null
  if (!raw || typeof raw.channelId !== 'string') return null

  const ffa = raw.messageIds?.ffa
  const duel = raw.messageIds?.duel
  const teamers = raw.messageIds?.teamers
  if (typeof ffa !== 'string' || typeof duel !== 'string' || typeof teamers !== 'string') return null

  return {
    channelId: raw.channelId,
    messageIds: { ffa, duel, teamers },
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  }
}

export async function setLeaderboardMessageState(
  kv: KVNamespace,
  state: LeaderboardMessageState,
): Promise<void> {
  await kv.put(LEADERBOARD_MESSAGE_STATE_KEY, JSON.stringify(state))
}

export async function clearLeaderboardMessageState(kv: KVNamespace): Promise<void> {
  await kv.delete(LEADERBOARD_MESSAGE_STATE_KEY)
}
