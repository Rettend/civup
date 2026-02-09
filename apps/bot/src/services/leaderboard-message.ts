import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
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
  const existingMessageIds = existing?.channelId === channelId ? existing.messageIds : null

  const nextMessageIds: Record<LeaderboardMode, string> = {
    ffa: '',
    duel: '',
    teamers: '',
  }

  for (const mode of LEADERBOARD_MODES) {
    const embed = await leaderboardEmbed(db, mode)
    const previousMessageId = existingMessageIds?.[mode]

    if (previousMessageId) {
      try {
        await editChannelMessage(token, channelId, previousMessageId, {
          content: null,
          embeds: [embed],
        })
        nextMessageIds[mode] = previousMessageId
        continue
      }
      catch (error) {
        if (!isDiscordApiError(error, 404)) throw error
      }
    }

    const created = await createChannelMessage(token, channelId, {
      embeds: [embed],
    })
    nextMessageIds[mode] = created.id
  }

  const state: LeaderboardMessageState = {
    channelId,
    messageIds: nextMessageIds,
    updatedAt: Date.now(),
  }
  await setLeaderboardMessageState(kv, state)
  return state
}
