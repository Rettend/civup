import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { CivLeaderboardModeScope } from './civ-snapshot.ts'
import type { LeaderboardDirtyState, LeaderboardMessageState, SystemChannelType } from '../system/channels.ts'
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
const LEGACY_LEADERBOARD_DIRTY_SCOPE = 'global'
const LEGACY_CIV_LEADERBOARD_DIRTY_SCOPE = 'civ'
const CIV_LEADERBOARD_DIRTY_SCOPE_PREFIX = 'civ:'
const PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX = 'player:'
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
    modes?: readonly LeaderboardMode[]
  } = {},
): Promise<boolean> {
  const leaderboardChannelId = await getSystemChannel(kv, 'leaderboard')
  if (!leaderboardChannelId) return false

  const [initialMode, ...queuedModes] = getPlayerLeaderboardMessageModes(options.modes)
  if (!initialMode) return false

  await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes: [initialMode] })
  if (queuedModes.length > 0) await markLeaderboardsDirty(db, 'refresh-configured:leaderboard', { modes: queuedModes })
  return true
}

export async function refreshConfiguredCivLeaderboards(
  db: Database,
  kv: KVNamespace,
  token: string,
): Promise<boolean> {
  const configuredChannels = await getConfiguredCivLeaderboardChannels(kv)
  if (configuredChannels.size === 0) return false

  let updated = false
  for (const [modeScope, channelId] of configuredChannels) {
    updated = Boolean(await upsertCivLeaderboardMessageForChannel(db, kv, token, channelId, { modeScope })) || updated
  }
  return updated
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
    playerModeLimit?: number
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now()
  const dirtyStates = await listLeaderboardDirtyStates(db)
  const dueDirtyStates = dirtyStates.filter(state => options.minDirtyAgeMs == null || now - state.dirtyAt >= options.minDirtyAgeMs)
  if (dueDirtyStates.length === 0) return false

  const modes = getPlayerLeaderboardMessageModes(options.modes)
  const legacyDirtyState = dueDirtyStates.find(state => state.scope === LEGACY_LEADERBOARD_DIRTY_SCOPE) ?? null
  const allDirtyPlayerModeEntries = getDirtyPlayerModeEntries(dueDirtyStates, modes, legacyDirtyState)
  const playerModeLimit = normalizePlayerModeLimit(options.playerModeLimit)
  const dirtyPlayerModeEntries = playerModeLimit == null ? allDirtyPlayerModeEntries : allDirtyPlayerModeEntries.slice(0, playerModeLimit)
  const dirtyPlayerModes = dirtyPlayerModeEntries.map(entry => entry.mode)
  const legacyCivDirtyState = dueDirtyStates.find(state => state.scope === LEGACY_CIV_LEADERBOARD_DIRTY_SCOPE) ?? null
  const dirtyCivModeEntries = getDirtyCivModeEntries(dueDirtyStates, legacyDirtyState, legacyCivDirtyState)
  const dirtyCivModeScopes = dirtyCivModeEntries.map(entry => entry.modeScope)
  const [leaderboardChannelId, civLeaderboardChannels] = await Promise.all([
    getSystemChannel(kv, 'leaderboard'),
    getConfiguredCivLeaderboardChannels(kv),
  ])

  const scopesToClear = new Set<string>()
  let leaderboardStates: LeaderboardMessageState[] = []
  let civLeaderboardStates: LeaderboardMessageState[] = []
  let civLeaderboardsProcessed = false
  let civSnapshotReady = false
  let playerLeaderboardsProcessed = false

  if (dirtyPlayerModes.length > 0) {
    const snapshots = await getStoredLeaderboardModeSnapshots(kv, dirtyPlayerModes)
    const staleModes = dirtyPlayerModeEntries.filter((entry) => {
      const snapshot = snapshots.get(entry.mode)
      return !snapshot || snapshot.updatedAt < entry.dirtyAt
    })

    await Promise.all(staleModes.map(entry => rebuildLeaderboardModeSnapshot(db, kv, entry.mode, now)))
    playerLeaderboardsProcessed = true

    if (leaderboardChannelId) {
      leaderboardStates = await upsertLeaderboardMessagesForChannel(db, kv, token, leaderboardChannelId, { modes: dirtyPlayerModes, useCachedSnapshots: true })
    }
  }

  if (dirtyCivModeScopes.length > 0) civSnapshotReady = await isCivLeaderboardStatsInitialized(db)

  if (dirtyCivModeScopes.length > 0 && civSnapshotReady) {
    const snapshots = await getStoredCivLeaderboardSnapshots(kv, dirtyCivModeScopes)
    const staleModeScopes = dirtyCivModeEntries.filter((entry) => {
      const snapshot = snapshots.get(entry.modeScope)
      return !snapshot || snapshot.updatedAt <= entry.dirtyAt
    }).map(entry => entry.modeScope)

    if (staleModeScopes.length > 0) await rebuildCivLeaderboardSnapshots(db, kv, staleModeScopes, now)
    civLeaderboardsProcessed = true

    for (const modeScope of dirtyCivModeScopes) {
      const channelId = civLeaderboardChannels.get(modeScope)
      if (!channelId) continue
      const state = await upsertCivLeaderboardMessageForChannel(db, kv, token, channelId, { modeScope })
      if (state) civLeaderboardStates.push(state)
    }
  }

  if (playerLeaderboardsProcessed) {
    for (const mode of dirtyPlayerModes) scopesToClear.add(playerDirtyScope(mode))
  }
  if (civLeaderboardsProcessed) {
    for (const modeScope of dirtyCivModeScopes) scopesToClear.add(civLeaderboardDirtyScope(modeScope))
    if (legacyCivDirtyState) scopesToClear.add(LEGACY_CIV_LEADERBOARD_DIRTY_SCOPE)
  }
  if (legacyDirtyState) {
    const processedModes = new Set(dirtyPlayerModes)
    const remainingModes = allDirtyPlayerModeEntries.map(entry => entry.mode).filter(mode => !processedModes.has(mode))
    if (remainingModes.length > 0) {
      await markLeaderboardsDirty(db, legacyDirtyState.reason ?? 'legacy-player-dirty', {
        modes: remainingModes,
        now: legacyDirtyState.dirtyAt,
      })
    }
    scopesToClear.add(LEGACY_LEADERBOARD_DIRTY_SCOPE)
  }
  if (legacyDirtyState && dirtyCivModeScopes.length > 0 && !civLeaderboardsProcessed) {
    await markLeaderboardsDirty(db, legacyDirtyState.reason ?? 'legacy-civ-dirty', {
      civ: true,
      now: legacyDirtyState.dirtyAt,
    })
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
    modeScope?: CivLeaderboardModeScope
  } = {},
): Promise<LeaderboardMessageState | null> {
  const modeScope = options.modeScope ?? 'all'
  const embedGroups = await buildCivLeaderboardEmbedGroups(kv, modeScope)
  if (!embedGroups) return null

  const states: LeaderboardMessageState[] = []

  for (const [index, embeds] of embedGroups.entries()) {
    const scope = civLeaderboardMessageScope(modeScope, index)

    const state = await upsertScopedLeaderboardMessage(db, token, channelId, scope, embeds, {
      forceCreate: options.forceCreate,
    })
    states.push(state)
  }

  await deleteUnusedCivLeaderboardMessages(db, token, channelId, modeScope, embedGroups.length)
  return states[0] ?? await upsertScopedLeaderboardMessage(db, token, channelId, civLeaderboardMessageScope(modeScope), [], {
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
      scope: playerLeaderboardMessageScope(data.mode),
      filename: `leaderboard-${data.mode}.png`,
      data: await renderPlayerLeaderboardPng(data, { avatarData }),
    })
  }
  return images
}

async function buildCivLeaderboardEmbedGroups(
  kv: KVNamespace,
  modeScope: CivLeaderboardModeScope,
) {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv, modeScope)
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
  modeScope: CivLeaderboardModeScope,
  activeCount: number,
): Promise<void> {
  for (const scope of civLeaderboardMessageScopes(modeScope).slice(activeCount)) {
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

function getDirtyScopes(options: MarkLeaderboardsDirtyOptions | undefined): string[] {
  if (!options) return [LEGACY_LEADERBOARD_DIRTY_SCOPE]

  const scopes = new Set<string>()
  for (const mode of options.modes ?? []) {
    if (LEADERBOARD_MODES.includes(mode)) scopes.add(playerDirtyScope(mode))
  }
  if (options.civ) {
    for (const modeScope of getCivDirtyModeScopes(options.modes)) scopes.add(civLeaderboardDirtyScope(modeScope))
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
  modes: readonly LeaderboardMode[],
  legacyDirtyState: ScopedLeaderboardDirtyState | null,
): DirtyPlayerMode[] {
  const modeOrder = new Map(modes.map((mode, index) => [mode, index]))
  if (legacyDirtyState) return modes.map(mode => ({ mode, dirtyAt: legacyDirtyState.dirtyAt }))

  return dirtyStates.flatMap((state) => {
    const mode = parsePlayerDirtyScope(state.scope)
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
  legacyDirtyState: ScopedLeaderboardDirtyState | null,
  legacyCivDirtyState: ScopedLeaderboardDirtyState | null,
): DirtyCivModeScope[] {
  const legacyState = legacyDirtyState ?? legacyCivDirtyState
  if (legacyState) return CIV_LEADERBOARD_MODE_SCOPES.map(modeScope => ({ modeScope, dirtyAt: legacyState.dirtyAt }))

  const dirtyByModeScope = new Map<CivLeaderboardModeScope, DirtyCivModeScope>()
  for (const state of dirtyStates) {
    const modeScope = parseCivDirtyScope(state.scope)
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

function playerDirtyScope(mode: LeaderboardMode): string {
  return `${PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX}${mode}`
}

function playerLeaderboardMessageScope(mode: LeaderboardMode): string {
  return `${PLAYER_LEADERBOARD_DIRTY_SCOPE_PREFIX}${mode}`
}

function civLeaderboardDirtyScope(modeScope: CivLeaderboardModeScope): string {
  return `${CIV_LEADERBOARD_DIRTY_SCOPE_PREFIX}${modeScope}`
}

function parseCivDirtyScope(scope: string): CivLeaderboardModeScope | null {
  if (!scope.startsWith(CIV_LEADERBOARD_DIRTY_SCOPE_PREFIX)) return null
  const modeScope = scope.slice(CIV_LEADERBOARD_DIRTY_SCOPE_PREFIX.length)
  return CIV_LEADERBOARD_MODE_SCOPES.includes(modeScope as CivLeaderboardModeScope) ? modeScope as CivLeaderboardModeScope : null
}

function civLeaderboardMessageScope(modeScope: CivLeaderboardModeScope, groupIndex = 0): string {
  if (modeScope === 'all') return groupIndex === 0 ? CIV_LEADERBOARD_SCOPE : `${CIV_LEADERBOARD_SCOPE}:${groupIndex + 1}`
  return groupIndex === 0 ? `${CIV_LEADERBOARD_SCOPE}:${modeScope}` : `${CIV_LEADERBOARD_SCOPE}:${modeScope}:${groupIndex + 1}`
}

function civLeaderboardMessageScopes(modeScope: CivLeaderboardModeScope): string[] {
  return [0, 1, 2].map(groupIndex => civLeaderboardMessageScope(modeScope, groupIndex))
}

function civLeaderboardSystemChannelType(modeScope: CivLeaderboardModeScope): SystemChannelType {
  if (modeScope === 'all') return 'civ-leaderboard-all'
  return `civ-leaderboard-${modeScope}` as SystemChannelType
}

async function getConfiguredCivLeaderboardChannels(kv: KVNamespace): Promise<Map<CivLeaderboardModeScope, string>> {
  const [legacyAllChannelId, ...scopedChannelIds] = await Promise.all([
    getSystemChannel(kv, 'civ-leaderboard'),
    ...CIV_LEADERBOARD_MODE_SCOPES.map(modeScope => getSystemChannel(kv, civLeaderboardSystemChannelType(modeScope))),
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
