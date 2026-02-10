import type { Database } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from './discord.ts'
import {
  getLeaderboardMessageState,
  getSystemChannel,
  setLeaderboardMessageState,
  type LeaderboardMessageState,
} from './system-channels.ts'

export async function refreshConfiguredLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'leaderboard')
  if (!leaderboardChannelId) return false

  await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId)
  return true
}

export async function upsertLeaderboardMessagesForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
): Promise<LeaderboardMessageState> {
  const existing = await getLeaderboardMessageState(kv)
  const previousMessageId = existing?.channelId === channelId ? existing.messageId : null
  const embeds = await Promise.all(LEADERBOARD_MODES.map(mode => leaderboardEmbed(db, mode)))

  if (previousMessageId) {
    try {
      await editChannelMessage(token, channelId, previousMessageId, {
        content: null,
        embeds,
      })

      const state: LeaderboardMessageState = {
        channelId,
        messageId: previousMessageId,
        updatedAt: Date.now(),
      }
      await setLeaderboardMessageState(kv, state)
      return state
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
    }
  }

  const created = await createChannelMessage(token, channelId, {
    embeds,
  })

  const state: LeaderboardMessageState = {
    channelId,
    messageId: created.id,
    updatedAt: Date.now(),
  }
  await setLeaderboardMessageState(kv, state)
  return state
}
