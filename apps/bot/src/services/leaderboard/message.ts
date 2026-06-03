import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { LeaderboardDirtyState, LeaderboardMessageState } from '../system/channels.ts'
import { leaderboardDirtyStates, leaderboardMessageStates } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { eq, inArray } from 'drizzle-orm'
import { civLeaderboardEmbedGroups } from '../../embeds/civ-leaderboard.ts'
import { createChannelMessage, createChannelMessageWithFile, deleteChannelMessage, editChannelMessage, editChannelMessageWithFile, isDiscordApiError } from '../discord/index.ts'
import {
  getSystemChannel,
} from '../system/channels.ts'
import { getStoredCivLeaderboardSnapshot, isCivLeaderboardStatsInitialized, rebuildCivLeaderboardSnapshot } from './civ-snapshot.ts'
import { buildPlayerLeaderboardImageData, renderPlayerLeaderboardPng } from './image.ts'
import { ensureLeaderboardModeSnapshots, getStoredLeaderboardModeSnapshots, rebuildLeaderboardModeSnapshot } from './snapshot.ts'

const LEGACY_PLAYER_LEADERBOARD_SCOPE = 'global'
const CIV_LEADERBOARD_SCOPE = 'civ'
const CIV_LEADERBOARD_MESSAGE_SCOPES = [CIV_LEADERBOARD_SCOPE, 'civ:2', 'civ:3'] as const
const LEGACY_LEADERBOARD_DIRTY_SCOPE = 'global'
const CIV_LEADERBOARD_DIRTY_SCOPE = 'civ'
const PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX = 'player:'
const PLAYER_LEADERBOARD_MESSAGE_MODES = ['duel', 'duo', 'squad', 'ffa'] as const satisfies readonly LeaderboardMode[]

interface ScopedLeaderboardDirtyState extends LeaderboardDirtyState {
  scope: string
}

interface MarkLeaderboardsDirtyOptions {
  civ?: boolean
  modes?: readonly LeaderboardMode[]
  now?: number
}

export async function markLeaderboardsDirty(db: Database, reason: string, options?: MarkLeaderboardsDirtyOptions): Promise<LeaderboardDirtyState> {
  const normalizedReason = reason.trim().length > 0 ? reason.trim() : null
  const dirtyAt = options?.now ?? Date.now()
  const scopes = getDirtyScopes(options)
  if (scopes.length === 0) return { dirtyAt, reason: normalizedReason }

  await db
    .insert(leaderboardDirtyStates)
    .values(scopes.map(scope => ({
      scope,
      dirtyAt,
      reason: normalizedReason,
    })))
    .onConflictDoNothing()

  const [state] = await listLeaderboardDirtyStates(db, scopes)
  return state ?? {
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

  return Boolean(await upsertCivLeaderboardMessageForChannel(db, kv, token, leaderboardChannelId))
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

  const archivedImages = await buildPlayerLeaderboardImages(db, kv, {
    titlePrefix: seasonName,
    modes: options.modes,
  })

  for (const image of archivedImages) {
    const existing = await getLeaderboardMessageState(db, image.scope)
    if (existing?.channelId === leaderboardChannelId) {
      try {
        await editChannelMessageWithFile({
          token,
          channelId: leaderboardChannelId,
          messageId: existing.messageId,
          filename: image.filename,
          contentType: 'image/png',
          data: image.data,
        })
        continue
      }
      catch (error) {
        if (!isDiscordApiError(error, 404)) throw error
      }
    }

    await createChannelMessageWithFile({
      token,
      channelId: leaderboardChannelId,
      filename: image.filename,
      contentType: 'image/png',
      data: image.data,
    })
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
  const now = options.now ?? Date.now()
  const dirtyStates = await listLeaderboardDirtyStates(db)
  const dueDirtyStates = dirtyStates.filter(state => options.minDirtyAgeMs == null || now - state.dirtyAt >= options.minDirtyAgeMs)
  if (dueDirtyStates.length === 0) return false

  const modes = [...new Set(options.modes ?? LEADERBOARD_MODES)]
  const legacyDirtyState = dueDirtyStates.find(state => state.scope === LEGACY_LEADERBOARD_DIRTY_SCOPE) ?? null
  const dirtyPlayerModes = getDirtyPlayerModes(dueDirtyStates, modes, legacyDirtyState)
  const civDirtyState = legacyDirtyState ?? dueDirtyStates.find(state => state.scope === CIV_LEADERBOARD_DIRTY_SCOPE) ?? null
  const [leaderboardChannelId, civLeaderboardChannelId] = await Promise.all([
    getSystemChannel(kv, 'leaderboard'),
    getSystemChannel(kv, 'civ-leaderboard'),
  ])

  const scopesToClear = new Set<string>()
  let leaderboardStates: LeaderboardMessageState[] = []
  let civLeaderboardState: LeaderboardMessageState | null = null
  let civSnapshotUpdated = false
  let civSnapshotReady = false
  let playerSnapshotsUpdated = false

  if (dirtyPlayerModes.length > 0) {
    await Promise.all(dirtyPlayerModes.map(mode => rebuildLeaderboardModeSnapshot(db, kv, mode, now)))
    playerSnapshotsUpdated = true

    if (leaderboardChannelId) {
      leaderboardStates = await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes, useCachedSnapshots: true })
    }
  }

  if (civDirtyState) civSnapshotReady = await isCivLeaderboardStatsInitialized(db)

  if (civDirtyState && civSnapshotReady) {
    await rebuildCivLeaderboardSnapshot(db, kv, now)
    civSnapshotUpdated = true
    if (civLeaderboardChannelId) {
      civLeaderboardState = await upsertCivLeaderboardMessageForChannel(db, kv, token, civLeaderboardChannelId)
    }
  }

  if (playerSnapshotsUpdated) {
    for (const mode of dirtyPlayerModes) scopesToClear.add(playerDirtyScope(mode))
  }
  if (civSnapshotUpdated) scopesToClear.add(CIV_LEADERBOARD_DIRTY_SCOPE)
  if (legacyDirtyState && playerSnapshotsUpdated && civDirtyState && !civSnapshotUpdated) {
    await markLeaderboardsDirty(db, legacyDirtyState.reason ?? 'legacy-civ-dirty', {
      civ: true,
      now: legacyDirtyState.dirtyAt,
    })
  }
  if (legacyDirtyState && playerSnapshotsUpdated && (!civDirtyState || civSnapshotUpdated || !civSnapshotReady)) scopesToClear.add(LEGACY_LEADERBOARD_DIRTY_SCOPE)

  await clearLeaderboardDirtyStates(db, [...scopesToClear])
  return Boolean(leaderboardStates.length > 0 || civLeaderboardState || civSnapshotUpdated || playerSnapshotsUpdated)
}

export async function upsertLeaderboardMessagesForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
  options: {
    forceCreate?: boolean
    modes?: readonly LeaderboardMode[]
    useCachedSnapshots?: boolean
  } = {},
): Promise<LeaderboardMessageState[]> {
  const images = await buildPlayerLeaderboardImages(db, kv, { modes: options.modes, useCachedSnapshots: options.useCachedSnapshots })
  const states: LeaderboardMessageState[] = []
  for (const image of images) {
    states.push(await upsertScopedLeaderboardImageMessage(db, token, channelId, image.scope, image.filename, image.data, {
      forceCreate: options.forceCreate,
    }))
  }

  await deleteLeaderboardMessage(db, token, channelId, LEGACY_PLAYER_LEADERBOARD_SCOPE)
  return states
}

export async function upsertCivLeaderboardMessageForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
  options: {
    forceCreate?: boolean
  } = {},
): Promise<LeaderboardMessageState | null> {
  const embedGroups = await buildCivLeaderboardEmbedGroups(kv)
  if (!embedGroups) return null

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

async function buildPlayerLeaderboardImages(
  db: Database,
  kv: KVNamespace,
  options: {
    titlePrefix?: string
    modes?: readonly LeaderboardMode[]
    useCachedSnapshots?: boolean
  } = {},
) {
  const modes = getPlayerLeaderboardMessageModes(options.modes)
  const snapshots = options.useCachedSnapshots
    ? await getStoredLeaderboardModeSnapshots(kv, modes)
    : await ensureLeaderboardModeSnapshots(db, kv, modes)
  const images: Array<{ scope: string, filename: string, data: Uint8Array }> = []
  for (const mode of modes) {
    const snapshot = snapshots.get(mode)
    if (!snapshot && options.useCachedSnapshots) continue

    const imageData = await buildPlayerLeaderboardImageData(db, mode, snapshot?.rows ?? [], {
      titlePrefix: options.titlePrefix,
    })
    images.push({
      scope: playerLeaderboardMessageScope(mode),
      filename: `leaderboard-${mode}.png`,
      data: await renderPlayerLeaderboardPng(imageData),
    })
  }
  return images
}

async function buildCivLeaderboardEmbedGroups(
  kv: KVNamespace,
) {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv)
  if (!snapshot?.historyInitialized) return null
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

async function upsertScopedLeaderboardImageMessage(
  db: Database,
  token: string,
  channelId: string,
  scope: string,
  filename: string,
  data: Uint8Array,
  options: {
    forceCreate?: boolean
  } = {},
): Promise<LeaderboardMessageState> {
  const existing = await getLeaderboardMessageState(db, scope)
  const previousMessageId = !options.forceCreate && existing?.channelId === channelId ? existing.messageId : null

  if (previousMessageId) {
    try {
      await editChannelMessageWithFile({
        token,
        channelId,
        messageId: previousMessageId,
        filename,
        contentType: 'image/png',
        data,
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

  const created = await createChannelMessageWithFile({
    token,
    channelId,
    filename,
    contentType: 'image/png',
    data,
  })
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

async function deleteLeaderboardMessage(db: Database, token: string, channelId: string, scope: string): Promise<void> {
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

function getDirtyScopes(options: MarkLeaderboardsDirtyOptions | undefined): string[] {
  if (!options) return [LEGACY_LEADERBOARD_DIRTY_SCOPE]

  const scopes = new Set<string>()
  for (const mode of options.modes ?? []) {
    if (LEADERBOARD_MODES.includes(mode)) scopes.add(playerDirtyScope(mode))
  }
  if (options.civ) scopes.add(CIV_LEADERBOARD_DIRTY_SCOPE)
  return [...scopes]
}

function getDirtyPlayerModes(
  dirtyStates: readonly ScopedLeaderboardDirtyState[],
  modes: readonly LeaderboardMode[],
  legacyDirtyState: ScopedLeaderboardDirtyState | null,
): LeaderboardMode[] {
  const requestedModes = new Set(modes)
  if (legacyDirtyState) return [...requestedModes]

  return dirtyStates.flatMap((state) => {
    const mode = parsePlayerDirtyScope(state.scope)
    return mode && requestedModes.has(mode) ? [mode] : []
  })
}

function playerDirtyScope(mode: LeaderboardMode): string {
  return `${PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX}${mode}`
}

function playerLeaderboardMessageScope(mode: LeaderboardMode): string {
  return `${PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX}${mode}`
}

function getPlayerLeaderboardMessageModes(modes?: readonly LeaderboardMode[]): LeaderboardMode[] {
  const requested = modes ?? PLAYER_LEADERBOARD_MESSAGE_MODES
  const allowed = new Set<LeaderboardMode>(PLAYER_LEADERBOARD_MESSAGE_MODES)
  return [...new Set(requested.filter(mode => allowed.has(mode)))]
}

function parsePlayerDirtyScope(scope: string): LeaderboardMode | null {
  if (!scope.startsWith(PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX)) return null
  const mode = scope.slice(PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX.length)
  return LEADERBOARD_MODES.includes(mode as LeaderboardMode) ? mode as LeaderboardMode : null
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

async function listLeaderboardDirtyStates(db: Database, scopes?: readonly string[]): Promise<ScopedLeaderboardDirtyState[]> {
  const query = db
    .select({
      scope: leaderboardDirtyStates.scope,
      dirtyAt: leaderboardDirtyStates.dirtyAt,
      reason: leaderboardDirtyStates.reason,
    })
    .from(leaderboardDirtyStates)
  const rows = scopes && scopes.length > 0
    ? await query.where(inArray(leaderboardDirtyStates.scope, [...scopes]))
    : await query

  return rows.map(row => ({
    scope: row.scope,
    dirtyAt: row.dirtyAt,
    reason: typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : null,
  }))
}

async function clearLeaderboardDirtyStates(db: Database, scopes: readonly string[]): Promise<void> {
  if (scopes.length === 0) return
  await db.delete(leaderboardDirtyStates).where(inArray(leaderboardDirtyStates.scope, [...new Set(scopes)]))
}
