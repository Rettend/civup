import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { LeaderboardDirtyState, LeaderboardMessageState } from '../system/channels.ts'
import { leaderboardDirtyStates, leaderboardMessageStates } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { eq } from 'drizzle-orm'
import { buildLeaderboardImageCard } from '../discord/leaderboard-card.ts'
import type { DiscordMessagePayload } from '../discord/index.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import {
  getSystemChannel,
} from '../system/channels.ts'
import { ensureLeaderboardModeSnapshots } from './snapshot.ts'

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
  options: {
    modes?: readonly LeaderboardMode[]
  } = {},
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'leaderboard')
  if (!leaderboardChannelId) return false

  await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes: options.modes })
  return true
}

export async function archiveSeasonLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
  seasonName: string,
  options: {
    modes?: readonly LeaderboardMode[]
  } = {},
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'leaderboard')
  if (!leaderboardChannelId) return false

  const existing = await getLeaderboardMessageState(db)
  const archivedPayload = await buildLeaderboardMessagePayload(db, kv, {
    titlePrefix: seasonName,
    modes: options.modes,
  })

  if (existing?.channelId === leaderboardChannelId) {
    try {
      await editChannelMessage(token, leaderboardChannelId, existing.messageId, {
        ...archivedPayload,
      })
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
      await createChannelMessage(token, leaderboardChannelId, archivedPayload)
    }
  }
  else {
    await createChannelMessage(token, leaderboardChannelId, archivedPayload)
  }

  await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, {
    forceCreate: true,
    modes: options.modes,
  })
  return true
}

export async function refreshDirtyLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
  options: {
    modes?: readonly LeaderboardMode[]
  } = {},
): Promise<boolean> {
  const dirtyState = await getLeaderboardDirtyState(db)
  if (!dirtyState) return false

  const refreshed = await refreshConfiguredLeaderboards(db, kv, token, { modes: options.modes })
  if (!refreshed) return false

  await clearLeaderboardDirtyState(db)
  return true
}

export async function upsertLeaderboardMessagesForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
  options: {
    forceCreate?: boolean
    modes?: readonly LeaderboardMode[]
  } = {},
): Promise<LeaderboardMessageState> {
  const existing = await getLeaderboardMessageState(db)
  const previousMessageId = !options.forceCreate && existing?.channelId === channelId ? existing.messageId : null
  const payload = await buildLeaderboardMessagePayload(db, kv, { modes: options.modes })

  if (previousMessageId) {
    try {
      await editChannelMessage(token, channelId, previousMessageId, payload)

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

  const created = await createChannelMessage(token, channelId, payload)

  const state: LeaderboardMessageState = {
    channelId,
    messageId: created.id,
    updatedAt: Date.now(),
  }
  await setLeaderboardMessageState(db, state)
  return state
}

async function buildLeaderboardMessagePayload(
  db: Database,
  kv: KVNamespace,
  options: {
    titlePrefix?: string
    modes?: readonly LeaderboardMode[]
  } = {},
): Promise<DiscordMessagePayload> {
  const modes = options.modes ?? LEADERBOARD_MODES
  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, modes)
  const cards = await Promise.all(modes.map(async (mode) => {
    const snapshot = snapshots.get(mode)
    return await buildLeaderboardImageCard({
      db,
      mode,
      rows: snapshot?.rows ?? [],
      titlePrefix: options.titlePrefix,
    })
  }))

  return {
    content: null,
    embeds: cards.map(card => card.embed),
    files: cards.map(card => card.file),
    allowed_mentions: { parse: [] },
  }
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
