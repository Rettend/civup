import type { Database } from '@civup/db'
import type { LeaderboardDirtyState } from './system-channels.ts'
import type { LeaderboardMessageState } from './system-channels.ts'
import { leaderboardDirtyStates, leaderboardMessageStates } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { eq } from 'drizzle-orm'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from './discord.ts'
import {
  getSystemChannel,
} from './system-channels.ts'

const LEADERBOARD_SCOPE = 'global'

export async function markLeaderboardsDirty(db: Database, reason: string): Promise<LeaderboardDirtyState> {
  const existing = await getLeaderboardDirtyState(db)
  if (existing) return existing

  const normalizedReason = reason.trim().length > 0 ? reason.trim() : null
  const dirtyAt = Date.now()

  await db
    .insert(leaderboardDirtyStates)
    .values({
      scope: LEADERBOARD_SCOPE,
      dirtyAt,
      reason: normalizedReason,
    })
    .onConflictDoNothing()

  return (await getLeaderboardDirtyState(db)) ?? {
    dirtyAt,
    reason: normalizedReason,
  }
}

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

export async function refreshDirtyLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
): Promise<boolean> {
  const dirtyState = await getLeaderboardDirtyState(db)
  if (!dirtyState) return false

  const refreshed = await refreshConfiguredLeaderboards(db, kv, token)
  if (!refreshed) return false

  await clearLeaderboardDirtyState(db)
  return true
}

export async function upsertLeaderboardMessagesForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
): Promise<LeaderboardMessageState> {
  const existing = await getLeaderboardMessageState(db)
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
      await setLeaderboardMessageState(db, state)
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
  await setLeaderboardMessageState(db, state)
  return state
}

async function getLeaderboardMessageState(db: Database): Promise<LeaderboardMessageState | null> {
  const [row] = await db
    .select({
      channelId: leaderboardMessageStates.channelId,
      messageId: leaderboardMessageStates.messageId,
      updatedAt: leaderboardMessageStates.updatedAt,
    })
    .from(leaderboardMessageStates)
    .where(eq(leaderboardMessageStates.scope, LEADERBOARD_SCOPE))
    .limit(1)

  if (!row) return null
  return row
}

async function setLeaderboardMessageState(
  db: Database,
  state: LeaderboardMessageState,
): Promise<void> {
  await db
    .insert(leaderboardMessageStates)
    .values({
      scope: LEADERBOARD_SCOPE,
      channelId: state.channelId,
      messageId: state.messageId,
      updatedAt: state.updatedAt,
    })
    .onConflictDoUpdate({
      target: leaderboardMessageStates.scope,
      set: {
        channelId: state.channelId,
        messageId: state.messageId,
        updatedAt: state.updatedAt,
      },
    })
}

async function getLeaderboardDirtyState(db: Database): Promise<LeaderboardDirtyState | null> {
  const [row] = await db
    .select({
      dirtyAt: leaderboardDirtyStates.dirtyAt,
      reason: leaderboardDirtyStates.reason,
    })
    .from(leaderboardDirtyStates)
    .where(eq(leaderboardDirtyStates.scope, LEADERBOARD_SCOPE))
    .limit(1)

  if (!row) return null
  return {
    dirtyAt: row.dirtyAt,
    reason: typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : null,
  }
}

async function clearLeaderboardDirtyState(db: Database): Promise<void> {
  await db.delete(leaderboardDirtyStates).where(eq(leaderboardDirtyStates.scope, LEADERBOARD_SCOPE))
}
