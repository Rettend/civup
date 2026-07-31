import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { CivLeaderboardModeScope } from './civ-snapshot.ts'
import type { StatsContext } from '../stats/context.ts'
import type { LeaderboardDirtyState, LeaderboardMessageState, SystemChannelScope, SystemChannelType } from '../system/channels.ts'
import { leaderboardDirtyStates, leaderboardMessageStates } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { eq, inArray, sql } from 'drizzle-orm'
import { civLeaderboardEmbedGroups } from '../../embeds/civ-leaderboard.ts'
import { createChannelMessage, createChannelMessageWithFile, deleteChannelMessage, editChannelMessage, editChannelMessageWithFile, isDiscordApiError, isDiscordApiErrorCode, unarchiveThread } from '../discord/index.ts'
import { loadAvatarDataUris } from '../image/avatar.ts'
import {
  getSystemChannel,
} from '../system/channels.ts'
import { CIV_LEADERBOARD_MODE_SCOPES, getStoredCivLeaderboardSnapshot, getStoredCivLeaderboardSnapshots, isCivLeaderboardStatsInitialized, rebuildCivLeaderboardSnapshots } from './civ-snapshot.ts'
import { buildPlayerLeaderboardImageDataBatch, renderPlayerLeaderboardPng } from './image.ts'
import { ensureLeaderboardModeSnapshots, getStoredLeaderboardModeSnapshots, rebuildLeaderboardModeSnapshot } from './snapshot.ts'

const LEGACY_PLAYER_LEADERBOARD_SCOPE = 'global'
const CIV_LEADERBOARD_SCOPE = 'civ'
export const PLAYER_LEADERBOARD_MESSAGE_MODES = ['duel', 'duo', 'squad', 'ffa'] as const satisfies readonly LeaderboardMode[]

interface ScopedLeaderboardDirtyState extends LeaderboardDirtyState {
  scope: string
}

interface DirtyPlayerMode {
  mode: LeaderboardMode
  dirtyAt: number
}

interface DirtyCivModeScope {
  modeScope: CivLeaderboardModeScope
  dirtyAt: number
}

interface MarkLeaderboardsDirtyOptions {
  civ?: boolean
  modes?: readonly LeaderboardMode[]
  now?: number
}

export async function markLeaderboardsDirty(db: Database, statsContext: StatsContext, reason: string, options?: MarkLeaderboardsDirtyOptions): Promise<LeaderboardDirtyState> {
  const normalizedReason = reason.trim().length > 0 ? reason.trim() : null
  const dirtyAt = options?.now ?? Date.now()
  const scopes = getDirtyScopes(statsContext, options)
  if (scopes.length === 0) return { dirtyAt, reason: normalizedReason }

  await db
    .insert(leaderboardDirtyStates)
    .values(scopes.map(scope => ({
      scope,
      dirtyAt,
      reason: normalizedReason,
    })))
    .onConflictDoUpdate({
      target: leaderboardDirtyStates.scope,
      set: {
        dirtyAt: sql`max(${leaderboardDirtyStates.dirtyAt}, excluded.dirty_at)`,
        reason: sql`case when excluded.dirty_at >= ${leaderboardDirtyStates.dirtyAt} then excluded.reason else ${leaderboardDirtyStates.reason} end`,
      },
    })

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
    channelScope: SystemChannelScope
    statsContext: StatsContext
    modes?: readonly LeaderboardMode[]
  },
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'leaderboard', options.channelScope)
  if (!leaderboardChannelId) return false

  const [initialMode, ...queuedModes] = getPlayerLeaderboardMessageModes(options.modes)
  if (!initialMode) return false
  if (!options.channelScope.guildId) throw new Error('Leaderboard publication server is required')

  await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes: [initialMode], statsContext: options.statsContext, publicationGuildId: options.channelScope.guildId })
  if (queuedModes.length > 0) await markLeaderboardsDirty(db, options.statsContext, 'refresh-configured:leaderboard', { modes: queuedModes })
  return true
}

export async function refreshConfiguredCivLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
  options: {
    channelScope: SystemChannelScope
    statsContext: StatsContext
  },
): Promise<boolean> {
  if (!options.channelScope.guildId) throw new Error('Leaderboard publication server is required')
  const configuredChannels = await getConfiguredCivLeaderboardChannels(kv, options.channelScope)
  if (configuredChannels.size === 0) return false

  let updated = false
  for (const [modeScope, channelId] of configuredChannels) {
    updated = Boolean(await upsertCivLeaderboardMessageForChannel(db, kv, token, channelId, {
      modeScope,
      statsContext: options.statsContext,
      publicationGuildId: options.channelScope.guildId,
    })) || updated
  }
  return updated
}

export async function archiveSeasonLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
  seasonName: string,
  options: {
    channelScope: SystemChannelScope
    statsContext: StatsContext
    modes?: readonly LeaderboardMode[]
  },
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'leaderboard', options.channelScope)
  if (!leaderboardChannelId) return false
  if (!options.channelScope.guildId) throw new Error('Leaderboard publication server is required')

  const archivedImages = await buildPlayerLeaderboardImages(db, kv, {
    titlePrefix: seasonName,
    modes: options.modes,
    statsContext: options.statsContext,
    publicationGuildId: options.channelScope.guildId,
  })

  for (const image of archivedImages) {
    const existing = await getLeaderboardMessageState(db, image.scope)
    if (existing?.channelId === leaderboardChannelId) {
      try {
        await withArchivedThreadRecovery(token, leaderboardChannelId, () => editChannelMessageWithFile({
          token,
          channelId: leaderboardChannelId,
          messageId: existing.messageId,
          filename: image.filename,
          contentType: 'image/png',
          data: image.data,
        }))
        continue
      }
      catch (error) {
        if (!isDiscordApiError(error, 404)) throw error
      }
    }

    await withArchivedThreadRecovery(token, leaderboardChannelId, () => createChannelMessageWithFile({
      token,
      channelId: leaderboardChannelId,
      filename: image.filename,
      contentType: 'image/png',
      data: image.data,
    }))
  }

  await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, {
    forceCreate: true,
    modes: options.modes,
    statsContext: options.statsContext,
    publicationGuildId: options.channelScope.guildId,
  })
  return true
}

export async function refreshDirtyLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
  options: {
    channelScope: SystemChannelScope
    statsContext: StatsContext
    modes?: readonly LeaderboardMode[]
    minDirtyAgeMs?: number
    now?: number
    playerModeLimit?: number
  },
): Promise<boolean> {
  const now = options.now ?? Date.now()
  if (!options.channelScope.guildId) throw new Error('Leaderboard publication server is required')
  const dirtyStates = await listLeaderboardDirtyStates(db, getDirtyScopes(options.statsContext, { modes: options.modes ?? LEADERBOARD_MODES, civ: true }))
  const dueDirtyStates = dirtyStates.filter(state => options.minDirtyAgeMs == null || now - state.dirtyAt >= options.minDirtyAgeMs)
  if (dueDirtyStates.length === 0) return false

  const modes = getPlayerLeaderboardMessageModes(options.modes)
  const allDirtyPlayerModeEntries = getDirtyPlayerModeEntries(dueDirtyStates, options.statsContext, modes)
  const playerModeLimit = normalizePlayerModeLimit(options.playerModeLimit)
  const dirtyPlayerModeEntries = playerModeLimit == null ? allDirtyPlayerModeEntries : allDirtyPlayerModeEntries.slice(0, playerModeLimit)
  const dirtyPlayerModes = dirtyPlayerModeEntries.map(entry => entry.mode)
  const dirtyCivModeEntries = getDirtyCivModeEntries(dueDirtyStates, options.statsContext)
  const dirtyCivModeScopes = dirtyCivModeEntries.map(entry => entry.modeScope)
  const [leaderboardChannelId, civLeaderboardChannels] = await Promise.all([
    getSystemChannel(kv, 'leaderboard', options.channelScope),
    getConfiguredCivLeaderboardChannels(kv, options.channelScope),
  ])

  const scopesToClear = new Set<string>()
  let leaderboardStates: LeaderboardMessageState[] = []
  let civLeaderboardStates: LeaderboardMessageState[] = []
  let civLeaderboardsProcessed = false
  let civSnapshotReady = false
  let playerLeaderboardsProcessed = false

  if (dirtyPlayerModes.length > 0) {
    const snapshots = await getStoredLeaderboardModeSnapshots(kv, options.statsContext, dirtyPlayerModes)
    const staleModes = dirtyPlayerModeEntries.filter((entry) => {
      const snapshot = snapshots.get(entry.mode)
      return !snapshot || snapshot.updatedAt < entry.dirtyAt
    })

    await Promise.all(staleModes.map(entry => rebuildLeaderboardModeSnapshot(db, kv, options.statsContext, entry.mode, now)))
    playerLeaderboardsProcessed = true

    if (leaderboardChannelId) {
      leaderboardStates = await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes: dirtyPlayerModes, useCachedSnapshots: true, statsContext: options.statsContext, publicationGuildId: options.channelScope.guildId })
    }
  }

  if (dirtyCivModeScopes.length > 0) civSnapshotReady = await isCivLeaderboardStatsInitialized(db, options.statsContext)

  if (dirtyCivModeScopes.length > 0 && civSnapshotReady) {
    const snapshots = await getStoredCivLeaderboardSnapshots(kv, options.statsContext, dirtyCivModeScopes)
    const staleModeScopes = dirtyCivModeEntries.filter((entry) => {
      const snapshot = snapshots.get(entry.modeScope)
      return !snapshot || snapshot.updatedAt <= entry.dirtyAt
    }).map(entry => entry.modeScope)

    if (staleModeScopes.length > 0) await rebuildCivLeaderboardSnapshots(db, kv, options.statsContext, staleModeScopes, now)
    civLeaderboardsProcessed = true

    for (const modeScope of dirtyCivModeScopes) {
      const channelId = civLeaderboardChannels.get(modeScope)
      if (!channelId) continue
      const state = await upsertCivLeaderboardMessageForChannel(db, kv, token, channelId, {
        modeScope,
        statsContext: options.statsContext,
        publicationGuildId: options.channelScope.guildId,
      })
      if (state) civLeaderboardStates.push(state)
    }
  }

  if (playerLeaderboardsProcessed) {
    for (const mode of dirtyPlayerModes) scopesToClear.add(playerDirtyScope(options.statsContext, mode))
  }
  if (civLeaderboardsProcessed) {
    for (const modeScope of dirtyCivModeScopes) scopesToClear.add(civLeaderboardDirtyScope(options.statsContext, modeScope))
  }

  await clearLeaderboardDirtyStates(db, [...scopesToClear])
  return Boolean(leaderboardStates.length > 0 || civLeaderboardStates.length > 0 || civLeaderboardsProcessed || playerLeaderboardsProcessed)
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
    statsContext: StatsContext
    publicationGuildId: string
  },
): Promise<LeaderboardMessageState[]> {
  const images = await buildPlayerLeaderboardImages(db, kv, { modes: options.modes, useCachedSnapshots: options.useCachedSnapshots, statsContext: options.statsContext, publicationGuildId: options.publicationGuildId })
  const states: LeaderboardMessageState[] = []
  for (const image of images) {
    states.push(await upsertScopedLeaderboardImageMessage(db, token, channelId, image.scope, image.filename, image.data, {
      forceCreate: options.forceCreate,
    }))
  }

  return states
}

export async function upsertCivLeaderboardMessageForChannel(
  db: Database,
  kv: KVNamespace,
  token: string,
  channelId: string,
  options: {
    forceCreate?: boolean
    modeScope?: CivLeaderboardModeScope
    statsContext: StatsContext
    publicationGuildId: string
  },
): Promise<LeaderboardMessageState | null> {
  const modeScope = options.modeScope ?? 'all'
  const embedGroups = await buildCivLeaderboardEmbedGroups(kv, options.statsContext, modeScope)
  if (!embedGroups) return null

  const states: LeaderboardMessageState[] = []

  for (const [index, embeds] of embedGroups.entries()) {
    const scope = civLeaderboardMessageScope(options.publicationGuildId, options.statsContext, modeScope, index)

    const state = await upsertScopedLeaderboardMessage(db, token, channelId, scope, embeds, {
      forceCreate: options.forceCreate,
    })
    states.push(state)
  }

  await deleteUnusedCivLeaderboardMessages(db, token, channelId, options.publicationGuildId, options.statsContext, modeScope, embedGroups.length)
  return states[0] ?? await upsertScopedLeaderboardMessage(db, token, channelId, civLeaderboardMessageScope(options.publicationGuildId, options.statsContext, modeScope), [], {
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
    statsContext: StatsContext
    publicationGuildId: string
  },
) {
  const modes = getPlayerLeaderboardMessageModes(options.modes)
  const snapshots = options.useCachedSnapshots
    ? await getStoredLeaderboardModeSnapshots(kv, options.statsContext, modes)
    : await ensureLeaderboardModeSnapshots(db, kv, options.statsContext, modes)
  const imageData = await buildPlayerLeaderboardImageDataBatch(db, modes.flatMap((mode) => {
    const snapshot = snapshots.get(mode)
    if (!snapshot && options.useCachedSnapshots) return []
    return [{
      mode,
      rows: snapshot?.rows ?? [],
      options: { titlePrefix: options.titlePrefix },
    }]
  }))
  const avatarData = await loadAvatarDataUris(imageData.flatMap(data => data.rows))
  const images: Array<{ scope: string, filename: string, data: Uint8Array }> = []
  for (const data of imageData) {
    images.push({
      scope: playerLeaderboardMessageScope(options.publicationGuildId, options.statsContext, data.mode),
      filename: `leaderboard-${data.mode}.png`,
      data: await renderPlayerLeaderboardPng(data, { avatarData }),
    })
  }
  return images
}

async function buildCivLeaderboardEmbedGroups(
  kv: KVNamespace,
  statsContext: StatsContext,
  modeScope: CivLeaderboardModeScope,
) {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv, statsContext, modeScope)
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
      await withArchivedThreadRecovery(token, channelId, () => editChannelMessage(token, channelId, previousMessageId, {
        content: null,
        embeds,
      }))

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

  const created = await withArchivedThreadRecovery(token, channelId, () => createChannelMessage(token, channelId, { embeds }))
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
      await withArchivedThreadRecovery(token, channelId, () => editChannelMessageWithFile({
        token,
        channelId,
        messageId: previousMessageId,
        filename,
        contentType: 'image/png',
        data,
      }))

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

  const created = await withArchivedThreadRecovery(token, channelId, () => createChannelMessageWithFile({
    token,
    channelId,
    filename,
    contentType: 'image/png',
    data,
  }))
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
  publicationGuildId: string,
  statsContext: StatsContext,
  modeScope: CivLeaderboardModeScope,
  activeCount: number,
): Promise<void> {
  for (const scope of civLeaderboardMessageScopes(publicationGuildId, statsContext, modeScope).slice(activeCount)) {
    const existing = await getLeaderboardMessageState(db, scope)
    if (existing?.channelId === channelId) {
      try {
        await withArchivedThreadRecovery(token, channelId, () => deleteChannelMessage(token, channelId, existing.messageId))
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
      await withArchivedThreadRecovery(token, channelId, () => deleteChannelMessage(token, channelId, existing.messageId))
    }
    catch (error) {
      if (!isDiscordApiError(error, 404)) throw error
    }
  }
  await deleteLeaderboardMessageState(db, scope)
}

async function withArchivedThreadRecovery<T>(token: string, channelId: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  }
  catch (error) {
    if (!isDiscordApiErrorCode(error, 50083)) throw error
    await unarchiveThread(token, channelId)
    return action()
  }
}

function getDirtyScopes(statsContext: StatsContext, options: MarkLeaderboardsDirtyOptions | undefined): string[] {
  const scopes = new Set<string>()
  for (const mode of options?.modes ?? LEADERBOARD_MODES) {
    if (LEADERBOARD_MODES.includes(mode)) scopes.add(playerDirtyScope(statsContext, mode))
  }
  if (options?.civ) {
    for (const modeScope of getCivDirtyModeScopes(options.modes)) scopes.add(civLeaderboardDirtyScope(statsContext, modeScope))
  }
  return [...scopes]
}

function getCivDirtyModeScopes(modes: readonly LeaderboardMode[] | undefined): CivLeaderboardModeScope[] {
  if (!modes || modes.length === 0) return [...CIV_LEADERBOARD_MODE_SCOPES]

  const scopes = new Set<CivLeaderboardModeScope>()
  for (const mode of modes) {
    if (mode === 'ffa') {
      scopes.add('all')
      continue
    }
    if (mode === 'duel' || mode === 'duo' || mode === 'squad') {
      scopes.add('all')
      scopes.add(mode)
    }
  }
  return scopes.size > 0 ? [...scopes] : [...CIV_LEADERBOARD_MODE_SCOPES]
}

function getDirtyPlayerModeEntries(
  dirtyStates: readonly ScopedLeaderboardDirtyState[],
  statsContext: StatsContext,
  modes: readonly LeaderboardMode[],
): DirtyPlayerMode[] {
  const modeOrder = new Map(modes.map((mode, index) => [mode, index]))

  return dirtyStates.flatMap((state) => {
    const mode = parsePlayerDirtyScope(statsContext, state.scope)
    if (!mode || !modeOrder.has(mode)) return []
    return [{ mode, dirtyAt: state.dirtyAt }]
  }).sort((a, b) => {
    const dirtyDiff = a.dirtyAt - b.dirtyAt
    if (dirtyDiff !== 0) return dirtyDiff
    return (modeOrder.get(a.mode) ?? 0) - (modeOrder.get(b.mode) ?? 0)
  })
}

function getDirtyCivModeEntries(
  dirtyStates: readonly ScopedLeaderboardDirtyState[],
  statsContext: StatsContext,
): DirtyCivModeScope[] {
  const dirtyByModeScope = new Map<CivLeaderboardModeScope, DirtyCivModeScope>()
  for (const state of dirtyStates) {
    const modeScope = parseCivDirtyScope(statsContext, state.scope)
    if (!modeScope) continue
    const existing = dirtyByModeScope.get(modeScope)
    if (!existing || state.dirtyAt < existing.dirtyAt) dirtyByModeScope.set(modeScope, { modeScope, dirtyAt: state.dirtyAt })
  }

  return CIV_LEADERBOARD_MODE_SCOPES.flatMap(modeScope => dirtyByModeScope.get(modeScope) ?? [])
}

function normalizePlayerModeLimit(value: number | undefined): number | null {
  if (value == null) return null
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}

function playerDirtyScope(statsContext: StatsContext, mode: LeaderboardMode): string {
  return `stats:dirty:${statsContext.statsKey}:player:${mode}`
}

function playerLeaderboardMessageScope(publicationGuildId: string, statsContext: StatsContext, mode: LeaderboardMode): string {
  return `leaderboard:message:${publicationGuildId}:${statsContext.statsKey}:player:${mode}:1`
}

function civLeaderboardDirtyScope(statsContext: StatsContext, modeScope: CivLeaderboardModeScope): string {
  return `stats:dirty:${statsContext.statsKey}:civ:${modeScope}`
}

function parseCivDirtyScope(statsContext: StatsContext, scope: string): CivLeaderboardModeScope | null {
  const prefix = `stats:dirty:${statsContext.statsKey}:civ:`
  if (!scope.startsWith(prefix)) return null
  const modeScope = scope.slice(prefix.length)
  return CIV_LEADERBOARD_MODE_SCOPES.includes(modeScope as CivLeaderboardModeScope) ? modeScope as CivLeaderboardModeScope : null
}

function civLeaderboardMessageScope(publicationGuildId: string, statsContext: StatsContext, modeScope: CivLeaderboardModeScope, groupIndex = 0): string {
  return `leaderboard:message:${publicationGuildId}:${statsContext.statsKey}:${CIV_LEADERBOARD_SCOPE}:${modeScope}:${groupIndex + 1}`
}

function civLeaderboardMessageScopes(publicationGuildId: string, statsContext: StatsContext, modeScope: CivLeaderboardModeScope): string[] {
  return [0, 1, 2].map(groupIndex => civLeaderboardMessageScope(publicationGuildId, statsContext, modeScope, groupIndex))
}

function civLeaderboardSystemChannelType(modeScope: CivLeaderboardModeScope): SystemChannelType {
  if (modeScope === 'all') return 'civ-leaderboard-all'
  return `civ-leaderboard-${modeScope}` as SystemChannelType
}

async function getConfiguredCivLeaderboardChannels(kv: KVNamespace, channelScope: SystemChannelScope): Promise<Map<CivLeaderboardModeScope, string>> {
  const [legacyAllChannelId, ...scopedChannelIds] = await Promise.all([
    getSystemChannel(kv, 'civ-leaderboard', channelScope),
    ...CIV_LEADERBOARD_MODE_SCOPES.map(modeScope => getSystemChannel(kv, civLeaderboardSystemChannelType(modeScope), channelScope)),
  ])
  const channelByModeScope = new Map<CivLeaderboardModeScope, string>()
  for (let index = 0; index < CIV_LEADERBOARD_MODE_SCOPES.length; index++) {
    const modeScope = CIV_LEADERBOARD_MODE_SCOPES[index]!
    const channelId = scopedChannelIds[index] ?? (modeScope === 'all' ? legacyAllChannelId : null)
    if (channelId) channelByModeScope.set(modeScope, channelId)
  }
  return channelByModeScope
}

function getPlayerLeaderboardMessageModes(modes?: readonly LeaderboardMode[]): LeaderboardMode[] {
  const requested = modes ?? PLAYER_LEADERBOARD_MESSAGE_MODES
  const allowed = new Set<LeaderboardMode>(PLAYER_LEADERBOARD_MESSAGE_MODES)
  return [...new Set(requested.filter(mode => allowed.has(mode)))]
}

function parsePlayerDirtyScope(statsContext: StatsContext, scope: string): LeaderboardMode | null {
  const prefix = `stats:dirty:${statsContext.statsKey}:player:`
  if (!scope.startsWith(prefix)) return null
  const mode = scope.slice(prefix.length)
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
