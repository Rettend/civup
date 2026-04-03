import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { RankedRoleConfig } from './roles.ts'
import { playerRatings, playerRatingSeeds, players } from '@civup/db'
import { competitiveTierRank, LEADERBOARD_MODES } from '@civup/game'
import { displayRating, RANKED_ROLE_MIN_GAMES } from '@civup/rating'
import { and, eq, gt, inArray } from 'drizzle-orm'
import { DiscordApiError, editGuildMemberRoles } from '../discord/index.ts'
import { ensureLeaderboardModeSnapshots } from '../leaderboard/snapshot.ts'
import { getActiveSeason, syncSeasonPeakModeRanks, syncSeasonPeakRanks } from '../season/index.ts'
import {
  createRankedRoleTierId,
  fetchGuildMemberRoleIds,
  formatRankedRoleSlotLabel,
  getConfiguredRankedRoleId,
  getLowestRankedRoleTier,
  getMissingRankedRoleConfigTiers,
  getRankedRoleConfig,
  getRankedRoleTierCount,
  hasConfiguredRankedRoleTier,
  normalizeRankedRoleTierId,
  RANKED_ROLE_CONFIG_KEY_PREFIX,

} from './roles.ts'

export interface CurrentRankAssignment {
  tier: CompetitiveTier
  sourceMode: LeaderboardMode | null
}

export interface RankedRoleAssignments {
  byPlayerId: Record<string, CurrentRankAssignment>
}

export interface RankedRoleDemotionCandidate {
  currentTier: CompetitiveTier
  targetTier: CompetitiveTier
  belowKeepSyncs: number
  sourceMode: LeaderboardMode | null
  updatedAt: number
}

export interface RankedRoleDemotionCandidates {
  byPlayerId: Record<string, RankedRoleDemotionCandidate>
}

export interface RankedRolesDirtyState {
  dirtyAt: number
  reason: string | null
}

export interface RankedRolePlayerPreview {
  playerId: string
  displayName: string
  assignment: CurrentRankAssignment
  previousAssignment: CurrentRankAssignment | null
  previousSourceMode: LeaderboardMode | null
  ladderTiers: Record<LeaderboardMode, CompetitiveTier | null>
  ladderScores: Record<LeaderboardMode, number | null>
  pendingDemotion: RankedRoleDemotionCandidate | null
  status: 'promoted' | 'demoted' | 'changed' | 'kept' | 'new'
}

export interface RankedRolePreview {
  guildId: string
  evaluatedAt: number
  playerPreviews: RankedRolePlayerPreview[]
  missingConfigTiers: CompetitiveTier[]
  unrankedCount: number
  distribution: Record<CompetitiveTier, number>
}

export interface RankedRoleSyncResult extends RankedRolePreview {
  appliedDiscordChanges: number
}

export interface RankedPreviewBandSummary {
  tier: CompetitiveTier
  roleId: string | null
  isFallback: boolean
  earnPercent: number | null
  cumulativeEarnPercent: number
  keepPercent: number | null
  cumulativeKeepPercent: number | null
}

export interface RankedPreviewModeTierSummary {
  tier: CompetitiveTier
  roleId: string | null
  isFallback: boolean
  locked: boolean
  unlockMinPlayers: number | null
  playersNeededToUnlock: number | null
  cutoffRank: number | null
  cutoffScore: number | null
}

export interface RankedPreviewModeSummary {
  mode: LeaderboardMode
  rankedCount: number
  tiers: RankedPreviewModeTierSummary[]
}

export interface RankedPreviewSummary {
  guildId: string
  evaluatedAt: number
  config: RankedRoleConfig
  bands: RankedPreviewBandSummary[]
  modes: RankedPreviewModeSummary[]
  unrankedCount: number
  dirty: boolean
}

interface RankedRoleSyncOptions {
  db: Database
  kv: KVNamespace
  guildId: string
  token?: string
  now?: number
  applyDiscord?: boolean
  advanceDemotionWindow?: boolean
  playerIds?: string[]
  includePlayerIdentities?: boolean
  rankedMinGames?: number
}

interface RatingSnapshotRow {
  playerId: string
  mode: LeaderboardMode
  mu: number
  sigma: number
  gamesPlayed: number
  lastPlayedAt: number | null
}

interface PlayerIdentity {
  displayName: string
}

interface LadderEntry {
  playerId: string
  score: number
  lastPlayedAt: number | null
}

interface LadderAssignment {
  playerId: string
  tier: CompetitiveTier
  mode: LeaderboardMode
  score: number
  lastPlayedAt: number | null
  overallRank: number
  tierRank: number
  tierSize: number
}

interface LadderSnapshots {
  earn: Map<string, LadderAssignment>
  keep: Map<string, LadderAssignment>
  scores: Map<string, number>
}

interface RankedRolePreviewState {
  preview: RankedRolePreview
  ratings: RatingSnapshotRow[]
  config: RankedRoleConfig
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>
}

type RankedEligibilityOverrideKey = `${string}:${LeaderboardMode}`

interface RankedTierThreshold {
  tier: CompetitiveTier
  earnPercent: number
  keepCumulativePercent: number
  unlockMinPlayers: number
  minimumCountWhenUnlocked: number
}

const CURRENT_ASSIGNMENTS_KEY_PREFIX = 'ranked-roles:current-assignments:'
const DEMOTION_CANDIDATES_KEY_PREFIX = 'ranked-roles:demotion-candidates:'
const RANKED_ROLES_DIRTY_STATE_KEY = 'ranked-roles:dirty'

const EARN_CUMULATIVE_PERCENT_ANCHORS = [0.015, 0.055, 0.155, 0.355] as const
const KEEP_CUMULATIVE_PERCENT_BUFFER_PER_TIER = 0.005
const TIER_UNLOCK_MIN_PLAYER_ANCHORS = [80, 40, 20, 8] as const

const DEMOTION_DELAY_SYNCS = 7

function buildRankedTierThresholds(config: RankedRoleConfig): RankedTierThreshold[] {
  const prestigeTierCount = Math.max(0, getRankedRoleTierCount(config) - 1)
  if (prestigeTierCount <= 0) return []

  let previousEarnPercent = 0
  return Array.from({ length: prestigeTierCount }, (_value, index) => {
    const progress = prestigeTierCount <= 1 ? 1 : index / (prestigeTierCount - 1)
    const cumulativeEarnPercent = interpolatePositiveAnchors(EARN_CUMULATIVE_PERCENT_ANCHORS, progress)
    const threshold: RankedTierThreshold = {
      tier: createRankedRoleTierId(index + 1),
      earnPercent: Math.max(0, cumulativeEarnPercent - previousEarnPercent),
      keepCumulativePercent: Math.min(1, cumulativeEarnPercent + (KEEP_CUMULATIVE_PERCENT_BUFFER_PER_TIER * (index + 1))),
      unlockMinPlayers: Math.max(0, Math.round(interpolatePositiveAnchors(TIER_UNLOCK_MIN_PLAYER_ANCHORS, progress))),
      minimumCountWhenUnlocked: index < Math.min(2, prestigeTierCount) ? 1 : 0,
    }
    previousEarnPercent = cumulativeEarnPercent
    return threshold
  })
}

function buildRankedPreviewBands(config: RankedRoleConfig): RankedPreviewBandSummary[] {
  const tierCount = getRankedRoleTierCount(config)
  if (tierCount <= 0) return []

  const bands: RankedPreviewBandSummary[] = []
  let cumulativeEarnPercent = 0
  let previousKeepCumulativePercent = 0

  for (const threshold of buildRankedTierThresholds(config)) {
    cumulativeEarnPercent += threshold.earnPercent
    bands.push({
      tier: threshold.tier,
      roleId: getConfiguredRankedRoleId(config, threshold.tier),
      isFallback: false,
      earnPercent: threshold.earnPercent,
      cumulativeEarnPercent,
      keepPercent: Math.max(0, threshold.keepCumulativePercent - previousKeepCumulativePercent),
      cumulativeKeepPercent: threshold.keepCumulativePercent,
    })
    previousKeepCumulativePercent = threshold.keepCumulativePercent
  }

  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(tierCount)
  bands.push({
    tier: fallbackTier,
    roleId: getConfiguredRankedRoleId(config, fallbackTier),
    isFallback: true,
    earnPercent: null,
    cumulativeEarnPercent: 1,
    keepPercent: null,
    cumulativeKeepPercent: null,
  })

  return bands
}

function buildRankedPreviewModeSummary(
  mode: LeaderboardMode,
  config: RankedRoleConfig,
  ladders: LadderSnapshots | undefined,
): RankedPreviewModeSummary {
  const rankedCount = ladders?.scores.size ?? 0
  if (rankedCount <= 0) {
    return {
      mode,
      rankedCount: 0,
      tiers: [],
    }
  }

  const cutoffByTier = new Map<CompetitiveTier, { rank: number, score: number }>()
  for (const assignment of ladders?.earn.values() ?? []) {
    const current = cutoffByTier.get(assignment.tier)
    if (!current || assignment.overallRank > current.rank) {
      cutoffByTier.set(assignment.tier, {
        rank: assignment.overallRank,
        score: assignment.score,
      })
    }
  }

  const tiers: RankedPreviewModeTierSummary[] = []
  for (const threshold of buildRankedTierThresholds(config)) {
    const locked = rankedCount < threshold.unlockMinPlayers
    const cutoff = locked ? null : cutoffByTier.get(threshold.tier)
    tiers.push({
      tier: threshold.tier,
      roleId: getConfiguredRankedRoleId(config, threshold.tier),
      isFallback: false,
      locked,
      unlockMinPlayers: threshold.unlockMinPlayers,
      playersNeededToUnlock: locked ? threshold.unlockMinPlayers - rankedCount : null,
      cutoffRank: cutoff?.rank ?? null,
      cutoffScore: cutoff?.score ?? null,
    })
  }

  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  tiers.push({
    tier: fallbackTier,
    roleId: getConfiguredRankedRoleId(config, fallbackTier),
    isFallback: true,
    locked: false,
    unlockMinPlayers: null,
    playersNeededToUnlock: null,
    cutoffRank: null,
    cutoffScore: null,
  })

  return {
    mode,
    rankedCount,
    tiers,
  }
}

function interpolatePositiveAnchors(values: readonly number[], progress: number): number {
  if (values.length === 0) return 0
  if (values.length === 1) return values[0] ?? 0

  const bounded = Math.max(0, Math.min(1, progress))
  const scaled = bounded * (values.length - 1)
  const leftIndex = Math.floor(scaled)
  const rightIndex = Math.min(values.length - 1, leftIndex + 1)
  const mix = scaled - leftIndex
  const left = values[leftIndex] ?? values[0] ?? 0
  const right = values[rightIndex] ?? left
  if (left <= 0 || right <= 0) return left + (right - left) * mix
  return Math.exp(Math.log(left) + (Math.log(right) - Math.log(left)) * mix)
}

export async function previewRankedRoles(options: RankedRoleSyncOptions): Promise<RankedRolePreview> {
  return await buildRankedRolePreview(options)
}

export async function summarizeRankedPreview(options: RankedRoleSyncOptions & {
  mode?: LeaderboardMode
}): Promise<RankedPreviewSummary> {
  const state = await buildRankedRolePreviewState({
    ...options,
    includePlayerIdentities: false,
  })
  const dirtyState = await getRankedRolesDirtyState(options.kv)
  const modes = options.mode ? [options.mode] : LEADERBOARD_MODES

  return {
    guildId: options.guildId,
    evaluatedAt: state.preview.evaluatedAt,
    config: state.config,
    bands: buildRankedPreviewBands(state.config),
    modes: modes.map(mode => buildRankedPreviewModeSummary(mode, state.config, state.laddersByMode.get(mode))),
    unrankedCount: state.preview.unrankedCount,
    dirty: dirtyState != null,
  }
}

export async function syncRankedRoles(options: RankedRoleSyncOptions): Promise<RankedRoleSyncResult> {
  const state = await buildRankedRolePreviewState({
    ...options,
    includePlayerIdentities: false,
  })
  const preview = state.preview
  await setCurrentRankAssignments(options.kv, options.guildId, {
    byPlayerId: Object.fromEntries(preview.playerPreviews.map(player => [player.playerId, player.assignment])),
  })
  await setRankedRoleDemotionCandidates(options.kv, options.guildId, {
    byPlayerId: Object.fromEntries(
      preview.playerPreviews
        .filter(player => player.pendingDemotion)
        .map(player => [player.playerId, player.pendingDemotion!]),
    ),
  })

  const activeSeason = await getActiveSeason(options.db)
  if (activeSeason) {
    await syncSeasonPeakRanks(options.db, {
      seasonId: activeSeason.id,
      candidates: preview.playerPreviews.map(player => ({
        playerId: player.playerId,
        tier: player.assignment.tier,
        sourceMode: player.assignment.sourceMode,
      })),
      activePlayerIds: buildSeasonActivePlayerIds(state.ratings, activeSeason.startsAt),
      now: options.now,
    })
    await syncSeasonPeakModeRanks(options.db, {
      seasonId: activeSeason.id,
      candidates: buildSeasonModePeakCandidates(state.ratings, preview.playerPreviews),
      activeModesByPlayerId: buildSeasonActiveModesByPlayerId(state.ratings, activeSeason.startsAt),
      now: options.now,
    })
  }

  let appliedDiscordChanges = 0
  if (options.applyDiscord) {
    const token = options.token?.trim()
    if (!token) throw new Error('Cannot sync ranked roles without a Discord bot token.')
    appliedDiscordChanges = await applyCurrentRankRoles(options.kv, options.guildId, token, preview.playerPreviews)
  }

  return {
    ...preview,
    appliedDiscordChanges,
  }
}

export async function listRankedRoleMatchUpdateLines(options: {
  kv: KVNamespace
  guildId: string
  preview: Pick<RankedRolePreview, 'playerPreviews'>
  playerIds: string[]
}): Promise<string[]> {
  const config = await getRankedRoleConfig(options.kv, options.guildId)
  const playerIdSet = new Set(options.playerIds)

  return options.preview.playerPreviews
    .filter(player => playerIdSet.has(player.playerId))
    .map(player => buildRankMatchUpdateLine(player, config))
    .filter((line): line is string => typeof line === 'string' && line.length > 0)
}

export async function resetCurrentRankedRoleState(options: {
  kv: KVNamespace
  guildId: string
  token?: string
}): Promise<{ clearedAssignments: number, appliedDiscordChanges: number }> {
  const previousAssignments = await getCurrentRankAssignments(options.kv, options.guildId)
  const playerIds = Object.keys(previousAssignments.byPlayerId).filter(isDiscordSnowflake)

  await setCurrentRankAssignments(options.kv, options.guildId, { byPlayerId: {} })
  await setRankedRoleDemotionCandidates(options.kv, options.guildId, { byPlayerId: {} })

  const token = options.token?.trim()
  if (!token || playerIds.length === 0) {
    return {
      clearedAssignments: playerIds.length,
      appliedDiscordChanges: 0,
    }
  }

  const config = await getRankedRoleConfig(options.kv, options.guildId)
  const rankedRoleIds = [...new Set(config.tiers
    .map(tier => tier.roleId)
    .filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0))]
  const fallbackTier = getLowestRankedRoleTier(config)
  const fallbackRoleId = fallbackTier ? getConfiguredRankedRoleId(config, fallbackTier) : null

  let appliedDiscordChanges = 0
  for (const playerId of playerIds) {
    let roleIds: string[]
    try {
      roleIds = await fetchGuildMemberRoleIds(token, options.guildId, playerId)
    }
    catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) continue
      throw error
    }

    const nextRoleIds = roleIds.filter(roleId => !rankedRoleIds.includes(roleId))
    if (fallbackRoleId && !nextRoleIds.includes(fallbackRoleId)) nextRoleIds.push(fallbackRoleId)
    nextRoleIds.sort((a, b) => a.localeCompare(b))

    const currentSorted = [...roleIds].sort((a, b) => a.localeCompare(b))
    if (sameStringArray(currentSorted, nextRoleIds)) continue

    try {
      await editGuildMemberRoles(token, options.guildId, playerId, nextRoleIds)
      appliedDiscordChanges += 1
    }
    catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) continue
      throw error
    }
  }

  return {
    clearedAssignments: playerIds.length,
    appliedDiscordChanges,
  }
}

export async function listRankedRoleConfigGuildIds(kv: KVNamespace): Promise<string[]> {
  const result = await kv.list({ prefix: RANKED_ROLE_CONFIG_KEY_PREFIX })
  const guildIds = result.keys
    .map(key => key.name.slice(RANKED_ROLE_CONFIG_KEY_PREFIX.length))
    .filter(guildId => guildId.length > 0)

  return [...new Set(guildIds)].sort((a, b) => a.localeCompare(b))
}

export async function getCurrentRankAssignments(kv: KVNamespace, guildId: string): Promise<RankedRoleAssignments> {
  const raw = await kv.get(currentAssignmentsKey(guildId), 'json') as RankedRoleAssignments | null
  if (!raw || !raw.byPlayerId || typeof raw.byPlayerId !== 'object') return { byPlayerId: {} }

  const byPlayerId: Record<string, CurrentRankAssignment> = {}
  for (const [playerId, assignment] of Object.entries(raw.byPlayerId)) {
    const normalized = normalizeCurrentRankAssignment(assignment)
    if (!normalized) continue
    byPlayerId[playerId] = normalized
  }

  return { byPlayerId }
}

export async function setCurrentRankAssignments(kv: KVNamespace, guildId: string, assignments: RankedRoleAssignments): Promise<void> {
  await kv.put(currentAssignmentsKey(guildId), JSON.stringify(assignments))
}

export async function getRankedRoleDemotionCandidates(kv: KVNamespace, guildId: string): Promise<RankedRoleDemotionCandidates> {
  const raw = await kv.get(demotionCandidatesKey(guildId), 'json') as RankedRoleDemotionCandidates | null
  if (!raw || !raw.byPlayerId || typeof raw.byPlayerId !== 'object') return { byPlayerId: {} }

  const byPlayerId: Record<string, RankedRoleDemotionCandidate> = {}
  for (const [playerId, candidate] of Object.entries(raw.byPlayerId)) {
    const normalized = normalizeDemotionCandidate(candidate)
    if (!normalized) continue
    byPlayerId[playerId] = normalized
  }

  return { byPlayerId }
}

export async function setRankedRoleDemotionCandidates(kv: KVNamespace, guildId: string, candidates: RankedRoleDemotionCandidates): Promise<void> {
  await kv.put(demotionCandidatesKey(guildId), JSON.stringify(candidates))
}

export async function getRankedRolesDirtyState(kv: KVNamespace): Promise<RankedRolesDirtyState | null> {
  const raw = await kv.get(RANKED_ROLES_DIRTY_STATE_KEY, 'json') as RankedRolesDirtyState | null
  if (!raw || typeof raw.dirtyAt !== 'number') return null
  return {
    dirtyAt: raw.dirtyAt,
    reason: typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : null,
  }
}

export async function markRankedRolesDirty(kv: KVNamespace, reason: string): Promise<RankedRolesDirtyState> {
  const existing = await getRankedRolesDirtyState(kv)
  if (existing) return existing

  const state: RankedRolesDirtyState = {
    dirtyAt: Date.now(),
    reason: reason.trim().length > 0 ? reason.trim() : null,
  }
  await kv.put(RANKED_ROLES_DIRTY_STATE_KEY, JSON.stringify(state))
  return state
}

export async function clearRankedRolesDirtyState(kv: KVNamespace): Promise<void> {
  await kv.delete(RANKED_ROLES_DIRTY_STATE_KEY)
}

function currentAssignmentsKey(guildId: string): string {
  return `${CURRENT_ASSIGNMENTS_KEY_PREFIX}${guildId}`
}

function demotionCandidatesKey(guildId: string): string {
  return `${DEMOTION_CANDIDATES_KEY_PREFIX}${guildId}`
}

async function buildRankedRolePreview(options: RankedRoleSyncOptions): Promise<RankedRolePreview> {
  const state = await buildRankedRolePreviewState(options)
  return state.preview
}

async function buildRankedRolePreviewState({
  db,
  kv,
  guildId,
  now = Date.now(),
  advanceDemotionWindow = false,
  playerIds,
  includePlayerIdentities = true,
  rankedMinGames = RANKED_ROLE_MIN_GAMES,
}: RankedRoleSyncOptions): Promise<RankedRolePreviewState> {
  const [leaderboardSnapshots, previousAssignments, previousCandidates, config, seedOverrides] = await Promise.all([
    ensureLeaderboardModeSnapshots(db, kv),
    getCurrentRankAssignments(kv, guildId),
    getRankedRoleDemotionCandidates(kv, guildId),
    getRankedRoleConfig(kv, guildId),
    db
      .select({
        playerId: playerRatingSeeds.playerId,
        mode: playerRatingSeeds.mode,
      })
      .from(playerRatingSeeds)
      .innerJoin(playerRatings, and(
        eq(playerRatings.playerId, playerRatingSeeds.playerId),
        eq(playerRatings.mode, playerRatingSeeds.mode),
      ))
      .where(and(
        eq(playerRatingSeeds.eligibleForRanked, true),
        gt(playerRatings.gamesPlayed, 0),
      )),
  ])

  const rankedEligibilityOverrideKeys = new Set<RankedEligibilityOverrideKey>(seedOverrides.flatMap((row) => {
    if (!LEADERBOARD_MODES.includes(row.mode as LeaderboardMode)) return []
    return [`${row.playerId}:${row.mode}` as RankedEligibilityOverrideKey]
  }))

  const ratings = [...leaderboardSnapshots.values()]
    .flatMap(snapshot => snapshot.rows)
    .map(row => ({
      playerId: row.playerId,
      mode: row.mode,
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
      lastPlayedAt: row.lastPlayedAt ?? null,
    }))
    .filter(row => LEADERBOARD_MODES.includes(row.mode) && isDiscordSnowflake(row.playerId))

  const laddersByMode = new Map<LeaderboardMode, LadderSnapshots>()
  for (const mode of LEADERBOARD_MODES) {
    laddersByMode.set(mode, buildLadderSnapshots(
      ratings.filter(row => row.mode === mode),
      mode,
      config,
      rankedMinGames,
      rankedEligibilityOverrideKeys,
    ))
  }

  const knownPlayerIds = new Set<string>()
  for (const row of ratings) knownPlayerIds.add(row.playerId)
  for (const playerId of Object.keys(previousAssignments.byPlayerId)) {
    if (!isDiscordSnowflake(playerId)) continue
    knownPlayerIds.add(playerId)
  }

  const requestedPlayerIds = buildRequestedPlayerIds(playerIds)
  const previewPlayerIds = requestedPlayerIds ?? [...knownPlayerIds].sort((a, b) => a.localeCompare(b))
  const playerIdentityById = await loadPlayerIdentityById(
    db,
    previewPlayerIds,
    includePlayerIdentities,
  )

  const playerPreviews: RankedRolePlayerPreview[] = []
  const distribution = createTierCounter(config)
  let unrankedCount = 0
  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))

  for (const playerId of previewPlayerIds) {
    const previousAssignment = (() => {
      const assignment = previousAssignments.byPlayerId[playerId] ?? null
      return assignment && hasConfiguredRankedRoleTier(config, assignment.tier) ? assignment : null
    })()
    const previousCandidate = (() => {
      const candidate = previousCandidates.byPlayerId[playerId] ?? null
      if (!candidate) return null
      return hasConfiguredRankedRoleTier(config, candidate.currentTier) && hasConfiguredRankedRoleTier(config, candidate.targetTier)
        ? candidate
        : null
    })()
    const earnAssignment = mergeLadderAssignments(playerId, laddersByMode, 'earn')
    const keepAssignment = mergeLadderAssignments(playerId, laddersByMode, 'keep')
    const ladderTiers = buildLadderTierMap(playerId, laddersByMode)
    const ladderScores = buildLadderScoreMap(playerId, laddersByMode)
    const finalAssignment = resolveCurrentAssignment({
      earnAssignment,
      keepAssignment,
      fallbackTier,
      previousAssignment,
      previousCandidate,
      now,
      advanceDemotionWindow,
    })

    if (finalAssignment.pendingDemotion == null && previousAssignment == null && finalAssignment.assignment.sourceMode == null) {
      unrankedCount += 1
    }

    distribution[finalAssignment.assignment.tier] = (distribution[finalAssignment.assignment.tier] ?? 0) + 1
    playerPreviews.push({
      playerId,
      displayName: playerIdentityById.get(playerId)?.displayName ?? `<@${playerId}>`,
      assignment: finalAssignment.assignment,
      previousAssignment,
      previousSourceMode: previousAssignment?.sourceMode ?? null,
      ladderTiers,
      ladderScores,
      pendingDemotion: finalAssignment.pendingDemotion,
      status: classifyPreviewStatus(previousAssignment, finalAssignment.assignment, fallbackTier),
    })
  }

  playerPreviews.sort(comparePlayerPreview)

  return {
    preview: {
      guildId,
      evaluatedAt: now,
      playerPreviews,
      missingConfigTiers: getMissingRankedRoleConfigTiers(config),
      unrankedCount,
      distribution,
    },
    ratings,
    config,
    laddersByMode,
  }
}

function buildRequestedPlayerIds(playerIds: string[] | undefined): string[] | null {
  if (!playerIds || playerIds.length === 0) return null

  const filtered = [...new Set(playerIds.filter(isDiscordSnowflake))]
  if (filtered.length === 0) return []
  return filtered.sort((a, b) => a.localeCompare(b))
}

async function loadPlayerIdentityById(
  db: Database,
  playerIds: string[],
  includePlayerIdentities: boolean,
): Promise<Map<string, PlayerIdentity>> {
  if (!includePlayerIdentities || playerIds.length === 0) return new Map()

  const playerRows = await db
    .select({ id: players.id, displayName: players.displayName })
    .from(players)
    .where(inArray(players.id, playerIds))

  return new Map(playerRows.map(row => [row.id, { displayName: row.displayName }]))
}

function buildSeasonActivePlayerIds(ratings: RatingSnapshotRow[], startsAt: number): Set<string> {
  const playerIds = new Set<string>()
  for (const row of ratings) {
    if (row.lastPlayedAt == null || row.lastPlayedAt < startsAt) continue
    playerIds.add(row.playerId)
  }
  return playerIds
}

function buildSeasonActiveModesByPlayerId(ratings: RatingSnapshotRow[], startsAt: number): Map<string, Set<LeaderboardMode>> {
  const activeModesByPlayerId = new Map<string, Set<LeaderboardMode>>()
  for (const row of ratings) {
    if (row.lastPlayedAt == null || row.lastPlayedAt < startsAt) continue
    const activeModes = activeModesByPlayerId.get(row.playerId) ?? new Set<LeaderboardMode>()
    activeModes.add(row.mode)
    activeModesByPlayerId.set(row.playerId, activeModes)
  }
  return activeModesByPlayerId
}

function buildSeasonModePeakCandidates(
  ratings: RatingSnapshotRow[],
  playerPreviews: RankedRolePlayerPreview[],
): Array<{ playerId: string, mode: LeaderboardMode, tier: CompetitiveTier | null, rating: number }> {
  const previewByPlayerId = new Map(playerPreviews.map(preview => [preview.playerId, preview]))
  return ratings.map((row) => {
    const preview = previewByPlayerId.get(row.playerId)
    return {
      playerId: row.playerId,
      mode: row.mode,
      tier: preview?.ladderTiers[row.mode] ?? null,
      rating: Math.round(displayRating(row.mu, row.sigma)),
    }
  })
}

function buildLadderSnapshots(
  rows: RatingSnapshotRow[],
  mode: LeaderboardMode,
  config: RankedRoleConfig,
  rankedMinGames: number,
  rankedEligibilityOverrideKeys: Set<RankedEligibilityOverrideKey>,
): LadderSnapshots {
  const eligible = rows
    .filter(row => row.gamesPlayed >= rankedMinGames || rankedEligibilityOverrideKeys.has(rankEligibilityOverrideKey(row.playerId, mode)))
    .map(row => ({
      playerId: row.playerId,
      score: displayRating(row.mu, row.sigma),
      lastPlayedAt: row.lastPlayedAt,
    }))
    .sort(compareLadderEntry)

  return {
    earn: buildEarnAssignments(eligible, mode, config),
    keep: buildKeepAssignments(eligible, mode, config),
    scores: new Map(eligible.map(entry => [entry.playerId, entry.score])),
  }
}

function rankEligibilityOverrideKey(playerId: string, mode: LeaderboardMode): RankedEligibilityOverrideKey {
  return `${playerId}:${mode}`
}

function buildEarnAssignments(entries: LadderEntry[], mode: LeaderboardMode, config: RankedRoleConfig): Map<string, LadderAssignment> {
  const n = entries.length
  const assignmentByPlayerId = new Map<string, LadderAssignment>()
  if (n === 0) return assignmentByPlayerId

  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  let start = 0
  for (const threshold of buildRankedTierThresholds(config)) {
    if (n < threshold.unlockMinPlayers) continue
    let size = Math.round(n * threshold.earnPercent)
    if (threshold.minimumCountWhenUnlocked > 0) size = Math.max(threshold.minimumCountWhenUnlocked, size)
    size = Math.max(0, Math.min(size, n - start))
    assignTierSlice(assignmentByPlayerId, entries, threshold.tier, mode, start, size)
    start += size
  }

  assignTierSlice(assignmentByPlayerId, entries, fallbackTier, mode, start, n - start)
  return assignmentByPlayerId
}

function buildKeepAssignments(entries: LadderEntry[], mode: LeaderboardMode, config: RankedRoleConfig): Map<string, LadderAssignment> {
  const n = entries.length
  const assignmentByPlayerId = new Map<string, LadderAssignment>()
  if (n === 0) return assignmentByPlayerId

  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  let previousCount = 0
  for (const threshold of buildRankedTierThresholds(config)) {
    const nextCount = n >= threshold.unlockMinPlayers
      ? Math.max(previousCount, threshold.minimumCountWhenUnlocked, Math.round(n * threshold.keepCumulativePercent))
      : previousCount
    const boundedCount = Math.max(0, Math.min(nextCount, n))
    assignTierSlice(assignmentByPlayerId, entries, threshold.tier, mode, previousCount, boundedCount - previousCount)
    previousCount = boundedCount
  }

  assignTierSlice(assignmentByPlayerId, entries, fallbackTier, mode, previousCount, Math.max(0, n - previousCount))

  return assignmentByPlayerId
}

function assignTierSlice(
  target: Map<string, LadderAssignment>,
  entries: LadderEntry[],
  tier: CompetitiveTier,
  mode: LeaderboardMode,
  start: number,
  size: number,
): void {
  for (let offset = 0; offset < size; offset++) {
    const index = start + offset
    const entry = entries[index]
    if (!entry) break
    target.set(entry.playerId, {
      playerId: entry.playerId,
      tier,
      mode,
      score: entry.score,
      lastPlayedAt: entry.lastPlayedAt,
      overallRank: index + 1,
      tierRank: offset + 1,
      tierSize: size,
    })
  }
}

function mergeLadderAssignments(
  playerId: string,
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>,
  kind: 'earn' | 'keep',
): CurrentRankAssignment | null {
  let best: LadderAssignment | null = null

  for (const mode of LEADERBOARD_MODES) {
    const snapshots = laddersByMode.get(mode)
    if (!snapshots) continue
    const assignment = snapshots[kind].get(playerId)
    if (!assignment) continue
    if (!best || compareMergedCandidate(assignment, best) < 0) best = assignment
  }

  if (!best) return null
  return { tier: best.tier, sourceMode: best.mode }
}

function buildLadderTierMap(playerId: string, laddersByMode: Map<LeaderboardMode, LadderSnapshots>): Record<LeaderboardMode, CompetitiveTier | null> {
  return {
    'duel': laddersByMode.get('duel')?.earn.get(playerId)?.tier ?? null,
    'duo': laddersByMode.get('duo')?.earn.get(playerId)?.tier ?? null,
    'squad': laddersByMode.get('squad')?.earn.get(playerId)?.tier ?? null,
    'ffa': laddersByMode.get('ffa')?.earn.get(playerId)?.tier ?? null,
    'red-death': laddersByMode.get('red-death')?.earn.get(playerId)?.tier ?? null,
  }
}

function buildLadderScoreMap(playerId: string, laddersByMode: Map<LeaderboardMode, LadderSnapshots>): Record<LeaderboardMode, number | null> {
  return {
    'duel': laddersByMode.get('duel')?.scores.get(playerId) ?? null,
    'duo': laddersByMode.get('duo')?.scores.get(playerId) ?? null,
    'squad': laddersByMode.get('squad')?.scores.get(playerId) ?? null,
    'ffa': laddersByMode.get('ffa')?.scores.get(playerId) ?? null,
    'red-death': laddersByMode.get('red-death')?.scores.get(playerId) ?? null,
  }
}

function resolveCurrentAssignment({
  earnAssignment,
  keepAssignment,
  fallbackTier,
  previousAssignment,
  previousCandidate,
  now,
  advanceDemotionWindow,
}: {
  earnAssignment: CurrentRankAssignment | null
  keepAssignment: CurrentRankAssignment | null
  fallbackTier: CompetitiveTier
  previousAssignment: CurrentRankAssignment | null
  previousCandidate: RankedRoleDemotionCandidate | null
  now: number
  advanceDemotionWindow: boolean
}): {
  assignment: CurrentRankAssignment
  pendingDemotion: RankedRoleDemotionCandidate | null
} {
  const earned = earnAssignment ?? { tier: fallbackTier, sourceMode: null }
  const keep = keepAssignment ?? { tier: fallbackTier, sourceMode: null }
  if (!previousAssignment) return { assignment: earned, pendingDemotion: null }

  if (competitiveTierRank(earned.tier) > competitiveTierRank(previousAssignment.tier)) {
    return { assignment: earned, pendingDemotion: null }
  }

  if (competitiveTierRank(earned.tier) === competitiveTierRank(previousAssignment.tier)) {
    return { assignment: earned, pendingDemotion: null }
  }

  if (competitiveTierRank(keep.tier) >= competitiveTierRank(previousAssignment.tier)) {
    return {
      assignment: {
        tier: previousAssignment.tier,
        sourceMode: keep.sourceMode ?? previousAssignment.sourceMode,
      },
      pendingDemotion: null,
    }
  }

  const nextCount = previousCandidate
    && previousCandidate.currentTier === previousAssignment.tier
    && previousCandidate.targetTier === earned.tier
    && previousCandidate.sourceMode === earned.sourceMode
    ? previousCandidate.belowKeepSyncs + (advanceDemotionWindow ? 1 : 0)
    : advanceDemotionWindow ? 1 : 0

  const pendingDemotion: RankedRoleDemotionCandidate = {
    currentTier: previousAssignment.tier,
    targetTier: earned.tier,
    belowKeepSyncs: nextCount,
    sourceMode: earned.sourceMode,
    updatedAt: now,
  }

  if (advanceDemotionWindow && nextCount >= DEMOTION_DELAY_SYNCS) {
    return { assignment: earned, pendingDemotion: null }
  }

  return { assignment: previousAssignment, pendingDemotion }
}

async function applyCurrentRankRoles(
  kv: KVNamespace,
  guildId: string,
  token: string,
  playerPreviews: RankedRolePlayerPreview[],
): Promise<number> {
  const config = await getRankedRoleConfig(kv, guildId)
  const missingTiers = getMissingRankedRoleConfigTiers(config)
  if (missingTiers.length > 0) {
    throw new Error(`Cannot sync ranked roles until all current roles are configured: ${missingTiers.join(', ')}`)
  }

  const rankedRoleIds = config.tiers
    .map(tier => tier.roleId)
    .filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)

  let appliedChanges = 0
  for (const preview of playerPreviews) {
    if (!isDiscordSnowflake(preview.playerId)) continue
    const desiredRoleId = getConfiguredRankedRoleId(config, preview.assignment.tier)
    if (!desiredRoleId) continue

    let roleIds: string[]
    try {
      roleIds = await fetchGuildMemberRoleIds(token, guildId, preview.playerId)
    }
    catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) continue
      throw error
    }

    const nextRoleIds = roleIds.filter(roleId => !rankedRoleIds.includes(roleId))
    nextRoleIds.push(desiredRoleId)
    nextRoleIds.sort((a, b) => a.localeCompare(b))

    const currentSorted = [...roleIds].sort((a, b) => a.localeCompare(b))
    if (sameStringArray(currentSorted, nextRoleIds)) continue

    try {
      await editGuildMemberRoles(token, guildId, preview.playerId, nextRoleIds)
      appliedChanges += 1
    }
    catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) continue
      throw error
    }
  }

  return appliedChanges
}

function buildRankMatchUpdateLine(
  player: RankedRolePlayerPreview,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string | null {
  const previous = player.previousAssignment
  const next = player.assignment
  const fallbackTier = getLowestRankedRoleTier(config)
  if (!previous) {
    if (fallbackTier && competitiveTierRank(next.tier) <= competitiveTierRank(fallbackTier)) return null
    return `🆕 <@${player.playerId}> qualified for ${formatRankAnnouncementRole(config, next.tier)}`
  }

  const previousRank = competitiveTierRank(previous.tier)
  const nextRank = competitiveTierRank(next.tier)
  if (nextRank > previousRank) {
    return `⬆️ <@${player.playerId}> ${formatRankAnnouncementRole(config, previous.tier)} -> ${formatRankAnnouncementRole(config, next.tier)}`
  }

  if (nextRank < previousRank) {
    return `⬇️ <@${player.playerId}> ${formatRankAnnouncementRole(config, previous.tier)} -> ${formatRankAnnouncementRole(config, next.tier)}`
  }

  return null
}

function formatRankAnnouncementRole(
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  tier: CompetitiveTier,
): string {
  const roleId = getConfiguredRankedRoleId(config, tier)
  return roleId ? `<@&${roleId}>` : `**${formatRankedRoleSlotLabel(tier)}**`
}

function compareLadderEntry(left: LadderEntry, right: LadderEntry): number {
  if (right.score !== left.score) return right.score - left.score
  if ((right.lastPlayedAt ?? 0) !== (left.lastPlayedAt ?? 0)) return (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0)
  return left.playerId.localeCompare(right.playerId)
}

function compareMergedCandidate(left: LadderAssignment, right: LadderAssignment): number {
  const tierDiff = competitiveTierRank(right.tier) - competitiveTierRank(left.tier)
  if (tierDiff !== 0) return tierDiff

  const leftTierPercentile = left.tierSize > 0 ? left.tierRank / left.tierSize : left.tierRank
  const rightTierPercentile = right.tierSize > 0 ? right.tierRank / right.tierSize : right.tierRank
  if (leftTierPercentile !== rightTierPercentile) return leftTierPercentile - rightTierPercentile
  if (right.score !== left.score) return right.score - left.score
  if ((right.lastPlayedAt ?? 0) !== (left.lastPlayedAt ?? 0)) return (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0)
  return left.playerId.localeCompare(right.playerId)
}

function comparePlayerPreview(left: RankedRolePlayerPreview, right: RankedRolePlayerPreview): number {
  const statusOrder = statusRank(left.status) - statusRank(right.status)
  if (statusOrder !== 0) return statusOrder

  const tierDiff = competitiveTierRank(right.assignment.tier) - competitiveTierRank(left.assignment.tier)
  if (tierDiff !== 0) return tierDiff
  return left.displayName.localeCompare(right.displayName)
}

function statusRank(status: RankedRolePlayerPreview['status']): number {
  if (status === 'promoted') return 0
  if (status === 'demoted') return 1
  if (status === 'changed') return 2
  if (status === 'new') return 3
  return 4
}

function classifyPreviewStatus(
  previous: CurrentRankAssignment | null,
  next: CurrentRankAssignment,
  fallbackTier: CompetitiveTier,
): RankedRolePlayerPreview['status'] {
  if (!previous) return next.tier === fallbackTier ? 'new' : 'promoted'
  const nextRank = competitiveTierRank(next.tier)
  const previousRank = competitiveTierRank(previous.tier)
  if (nextRank > previousRank) return 'promoted'
  if (nextRank < previousRank) return 'demoted'
  if (next.sourceMode !== previous.sourceMode) return 'changed'
  return 'kept'
}

function createTierCounter(config: RankedRoleConfig): Record<CompetitiveTier, number> {
  return Object.fromEntries(
    Array.from({ length: getRankedRoleTierCount(config) }, (_value, index) => [createRankedRoleTierId(index + 1), 0]),
  ) as Record<CompetitiveTier, number>
}

function normalizeCurrentRankAssignment(value: unknown): CurrentRankAssignment | null {
  if (!value || typeof value !== 'object') return null
  const tier = normalizeRankedRoleTierId((value as { tier?: unknown }).tier)
  if (!tier) return null

  const sourceMode = (value as { sourceMode?: unknown }).sourceMode
  return {
    tier,
    sourceMode: LEADERBOARD_MODES.includes(sourceMode as LeaderboardMode) ? sourceMode as LeaderboardMode : null,
  }
}

function normalizeDemotionCandidate(value: unknown): RankedRoleDemotionCandidate | null {
  if (!value || typeof value !== 'object') return null
  const currentTier = normalizeRankedRoleTierId((value as { currentTier?: unknown }).currentTier)
  const targetTier = normalizeRankedRoleTierId((value as { targetTier?: unknown }).targetTier)
  if (!currentTier || !targetTier) return null

  return {
    currentTier,
    targetTier,
    belowKeepSyncs: normalizePositiveInteger((value as { belowKeepSyncs?: unknown }).belowKeepSyncs),
    sourceMode: LEADERBOARD_MODES.includes((value as { sourceMode?: unknown }).sourceMode as LeaderboardMode)
      ? (value as { sourceMode?: LeaderboardMode }).sourceMode ?? null
      : null,
    updatedAt: normalizePositiveInteger((value as { updatedAt?: unknown }).updatedAt),
  }
}

function normalizePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : 0
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value)
}
