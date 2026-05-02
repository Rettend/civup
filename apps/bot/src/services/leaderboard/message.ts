import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { LeaderboardDirtyState, LeaderboardMessageState } from '../system/channels.ts'
import { leaderboardDirtyStates, leaderboardMessageStates } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { eq } from 'drizzle-orm'
import { civLeaderboardEmbedGroups } from '../../embeds/civ-leaderboard.ts'
import { leaderboardEmbed } from '../../embeds/leaderboard.ts'
import { createChannelMessage, deleteChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import {
  getSystemChannel,
} from '../system/channels.ts'
import { ensureCivLeaderboardSnapshot, rebuildCivLeaderboardSnapshot } from './civ-snapshot.ts'
import { clearAllTeamLeaderboardSnapshots } from './team-snapshot.ts'
import { ensureLeaderboardModeSnapshots, rebuildLeaderboardModeSnapshot } from './snapshot.ts'

const PLAYER_LEADERBOARD_SCOPE = 'global'
const CIV_LEADERBOARD_SCOPE = 'civ'
const CIV_LEADERBOARD_MESSAGE_SCOPES = [CIV_LEADERBOARD_SCOPE, 'civ:2', 'civ:3'] as const
const LEADERBOARD_DIRTY_SCOPE = 'global'

export async function markLeaderboardsDirty(db: Database, reason: string): Promise<LeaderboardDirtyState> {
  const existing = await getLeaderboardDirtyState(db)
  if (existing) return existing

  const normalizedReason = reason.trim().length > 0 ? reason.trim() : null
  const dirtyAt = Date.now()

  await db
    .insert(leaderboardDirtyStates)
    .values({
      scope: LEADERBOARD_DIRTY_SCOPE,
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

export async function refreshConfiguredCivLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'civ-leaderboard')
  if (!leaderboardChannelId) return false

  await upsertCivLeaderboardMessageForChannel(db, kv, token, leaderboardChannelId)
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

  const existing = await getLeaderboardMessageState(db, PLAYER_LEADERBOARD_SCOPE)
  const archivedEmbeds = await buildLeaderboardEmbeds(db, kv, {
    titlePrefix: seasonName,
    modes: options.modes,
  })

  if (existing?.channelId === leaderboardChannelId) {
    try {
      await editChannelMessage(token, leaderboardChannelId, existing.messageId, {
        content: null,
        embeds: archivedEmbeds,
      })
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
      await createChannelMessage(token, leaderboardChannelId, { embeds: archivedEmbeds })
    }
  }
  else {
    await createChannelMessage(token, leaderboardChannelId, { embeds: archivedEmbeds })
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
    minDirtyAgeMs?: number
    now?: number
  } = {},
): Promise<boolean> {
  const dirtyState = await getLeaderboardDirtyState(db)
  if (!dirtyState) return false
  if (options.minDirtyAgeMs != null && (options.now ?? Date.now()) - dirtyState.dirtyAt < options.minDirtyAgeMs) return false

  const modes = [...new Set(options.modes ?? LEADERBOARD_MODES)]
  const [leaderboardChannelId, civLeaderboardChannelId] = await Promise.all([
    getSystemChannel(kv, 'leaderboard'),
    getSystemChannel(kv, 'civ-leaderboard'),
  ])

  await Promise.all([
    rebuildLeaderboardSnapshots(db, kv, modes),
    civLeaderboardChannelId ? rebuildCivLeaderboardSnapshot(db, kv) : Promise.resolve(),
  ])

  const [leaderboardState, civLeaderboardState] = await Promise.all([
    leaderboardChannelId
      ? upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes })
      : Promise.resolve(null),
    civLeaderboardChannelId
      ? upsertCivLeaderboardMessageForChannel(db, kv, token, civLeaderboardChannelId)
      : Promise.resolve(null),
  ])
  await clearLeaderboardDirtyState(db)
  return Boolean(leaderboardState || civLeaderboardState)
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
  const existing = await getLeaderboardMessageState(db, PLAYER_LEADERBOARD_SCOPE)
  const previousMessageId = !options.forceCreate && existing?.channelId === channelId ? existing.messageId : null
  const embeds = await buildLeaderboardEmbeds(db, kv, { modes: options.modes })

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
      await setLeaderboardMessageState(db, PLAYER_LEADERBOARD_SCOPE, state)
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
  await setLeaderboardMessageState(db, PLAYER_LEADERBOARD_SCOPE, state)
  return state
}

export async function upsertCivLeaderboardMessageForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
  options: {
    forceCreate?: boolean
  } = {},
): Promise<LeaderboardMessageState> {
  const embedGroups = await buildCivLeaderboardEmbedGroups(db, kv)
  const states: LeaderboardMessageState[] = []

  for (const [index, embeds] of embedGroups.entries()) {
    const scope = CIV_LEADERBOARD_MESSAGE_SCOPES[index]
    if (!scope) break

    const state = await upsertScopedLeaderboardMessage(db, token, channelId, scope, embeds, {
      forceCreate: options.forceCreate,
    })
    states.push(state)
  }

  await deleteUnusedCivLeaderboardMessages(db, token, channelId, embedGroups.length)
  return states[0] ?? await upsertScopedLeaderboardMessage(db, token, channelId, CIV_LEADERBOARD_SCOPE, [], {
    forceCreate: options.forceCreate,
  })
}

async function buildLeaderboardEmbeds(
  db: Database,
  kv: KVNamespace,
  options: {
    titlePrefix?: string
    modes?: readonly LeaderboardMode[]
  } = {},
) {
  const modes = options.modes ?? LEADERBOARD_MODES
  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, modes)
  return modes.map((mode) => {
    const snapshot = snapshots.get(mode)
    return leaderboardEmbed(mode, snapshot?.rows ?? [], options)
  })
}

async function buildCivLeaderboardEmbedGroups(
  db: Database,
  kv: KVNamespace,
) {
  const snapshot = await ensureCivLeaderboardSnapshot(db, kv)
  return civLeaderboardEmbedGroups(snapshot)
}

async function upsertScopedLeaderboardMessage(
  db: Database,
  token: string,
  channelId: string,
  scope: string,
  embeds: unknown[],
  options: {
    forceCreate?: boolean
  } = {},
): Promise<LeaderboardMessageState> {
  const existing = await getLeaderboardMessageState(db, scope)
  const previousMessageId = !options.forceCreate && existing?.channelId === channelId ? existing.messageId : null

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
      await setLeaderboardMessageState(db, scope, state)
      return state
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
    }
  }

  const created = await createChannelMessage(token, channelId, { embeds })
  const state: LeaderboardMessageState = {
    channelId,
    messageId: created.id,
    updatedAt: Date.now(),
  }
  await setLeaderboardMessageState(db, scope, state)
  return state
}

async function deleteUnusedCivLeaderboardMessages(
  db: Database,
  token: string,
  channelId: string,
  activeCount: number,
): Promise<void> {
  for (const scope of CIV_LEADERBOARD_MESSAGE_SCOPES.slice(activeCount)) {
    const existing = await getLeaderboardMessageState(db, scope)
    if (existing?.channelId === channelId) {
      try {
        await deleteChannelMessage(token, channelId, existing.messageId)
      }
      catch (error) {
        if (!isDiscordApiError(error, 404)) throw error
      }
    }
    await deleteLeaderboardMessageState(db, scope)
  }
}

async function rebuildLeaderboardSnapshots(
  db: Database,
  kv: KVNamespace,
  modes: readonly LeaderboardMode[],
): Promise<void> {
  await Promise.all(modes.map(mode => rebuildLeaderboardModeSnapshot(db, kv, mode)))
  if (modes.some(mode => mode === 'duo' || mode === 'squad')) {
    await clearAllTeamLeaderboardSnapshots(kv)
  }
}

async function getLeaderboardMessageState(db: Database, scope: string): Promise<LeaderboardMessageState | null> {
  const [row] = await db
    .select({
      channelId: leaderboardMessageStates.channelId,
      messageId: leaderboardMessageStates.messageId,
      updatedAt: leaderboardMessageStates.updatedAt,
    })
    .from(leaderboardMessageStates)
    .where(eq(leaderboardMessageStates.scope, scope))
    .limit(1)

  if (!row) return null
  return row
}

async function setLeaderboardMessageState(
  db: Database,
  scope: string,
  state: LeaderboardMessageState,
): Promise<void> {
  await db
    .insert(leaderboardMessageStates)
    .values({
      scope,
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

async function deleteLeaderboardMessageState(db: Database, scope: string): Promise<void> {
  await db.delete(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, scope))
}

async function getLeaderboardDirtyState(db: Database): Promise<LeaderboardDirtyState | null> {
  const [row] = await db
    .select({
      dirtyAt: leaderboardDirtyStates.dirtyAt,
      reason: leaderboardDirtyStates.reason,
    })
    .from(leaderboardDirtyStates)
    .where(eq(leaderboardDirtyStates.scope, LEADERBOARD_DIRTY_SCOPE))
    .limit(1)

  if (!row) return null
  return {
    dirtyAt: row.dirtyAt,
    reason: typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : null,
  }
}

async function clearLeaderboardDirtyState(db: Database): Promise<void> {
  await db.delete(leaderboardDirtyStates).where(eq(leaderboardDirtyStates.scope, LEADERBOARD_DIRTY_SCOPE))
}
