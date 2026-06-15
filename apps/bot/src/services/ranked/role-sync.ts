import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { RankedRoleConfig } from './roles.ts'
import { playerRatings, players } from '@civup/db'
import { competitiveTierRank, LEADERBOARD_MODES } from '@civup/game'
import { displayRating, getLeaderboardMinGames, RANKED_ROLE_MIN_EFFECTIVE_GAMES, roleRating } from '@civup/rating'
import { eq, inArray } from 'drizzle-orm'
import { addGuildMemberRole, DiscordApiError, removeGuildMemberRole } from '../discord/index.ts'
import { getLeaderboardModeSnapshotsForPreview } from '../leaderboard/snapshot.ts'
import { getActiveSeason, syncSeasonPeakModeRanks, syncSeasonPeakRanks } from '../season/index.ts'
import {
  createRankedRoleTierId,
  fetchGuildMemberRoleIds,
  formatRankedRoleSlotLabel,
  getConfiguredRankedRoleId,
  getConfiguredRankedRoleLabel,
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
  appliedRoleId?: string | null
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

interface AppliedRankedRoleConfig {
  byTier: Record<string, string | null>
}

export interface RankedRolePlayerPreview {
  playerId: string
  displayName: string
  qualified: boolean
  managed: boolean
  globalScore: number | null
  liveAssignment: CurrentRankAssignment
  assignment: CurrentRankAssignment
  previousAssignment: CurrentRankAssignment | null
  previousSourceMode: LeaderboardMode | null
  ladderTiers: Record<LeaderboardMode, CompetitiveTier | null>
  ladderRanks: Record<LeaderboardMode, number | null>
  ladderScores: Record<LeaderboardMode, number | null>
  pendingDemotion: RankedRoleDemotionCandidate | null
  status: 'promoted' | 'demoted' | 'changed' | 'kept' | 'new'
}

export interface RankedRolePreview {
  guildId: string
  evaluatedAt: number
  config: RankedRoleConfig
  playerPreviews: RankedRolePlayerPreview[]
  missingConfigTiers: CompetitiveTier[]
  unrankedCount: number
  distribution: Record<CompetitiveTier, number>
}

export interface RankedRoleSyncResult extends RankedRolePreview {
  attemptedDiscordChanges: number
  appliedDiscordChanges: number
  pendingDiscordChanges: number
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

export interface ProjectedRankedTierSummary {
  tier: CompetitiveTier | null
  roleId: string | null
  label: string | null
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
  maxDiscordRoleSyncPlayers?: number
  /** Full role sync needs full-roster grace caps; single-player read views can skip them. */
  fullRosterGraceCaps?: boolean
}

interface RatingSnapshotRow {
  playerId: string
  mode: LeaderboardMode
  mu: number
  sigma: number
  gamesPlayed: number
  lastPlayedAt: number | null
}

interface GlobalRatingSnapshotRow {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
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
  mode: LeaderboardMode | null
  score: number
  lastPlayedAt: number | null
  overallRank: number
  tierRank: number
  tierSize: number
}

interface LadderSnapshots {
  earn: Map<string, LadderAssignment>
  keep: Map<string, LadderAssignment>
  ranks: Map<string, number>
  scores: Map<string, number>
}

interface PlannedRankRoleChange {
  removeRoleIds: string[]
  addRoleId: string | null
}

interface PendingRankedRoleApplication {
  playerId: string
  assignment: CurrentRankAssignment
  desiredRoleId: string
}

interface RankedRolePreviewState {
  preview: RankedRolePreview
  ratings: RatingSnapshotRow[]
  globalRatings: GlobalRatingSnapshotRow[]
  config: RankedRoleConfig
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>
  globalLadders: LadderSnapshots
  previousAssignments: RankedRoleAssignments
  previousCandidates: RankedRoleDemotionCandidates
}

interface RankedTierThreshold {
  tier: CompetitiveTier
  earnPercent: number
  keepCumulativePercent: number
  minimumCountWhenUnlocked: number
}

const CURRENT_ASSIGNMENTS_KEY_PREFIX = 'ranked-roles:current-assignments:'
const DEMOTION_CANDIDATES_KEY_PREFIX = 'ranked-roles:demotion-candidates:'
const RANKED_ROLES_DIRTY_STATE_KEY = 'ranked-roles:dirty'
const APPLIED_ROLE_CONFIG_KEY_PREFIX = 'ranked-roles:applied-config:'
const DISCORD_APPLY_CURSOR_KEY_PREFIX = 'ranked-roles:discord-apply-cursor:'
// Keep this shorter than the daily role sync interval so old isolates do not
// hide a fresh daily assignment snapshot for another full day.
const CURRENT_ASSIGNMENTS_CACHE_TTL_MS = 4 * 60 * 60 * 1_000

const currentRankAssignmentsCacheByNamespace = new WeakMap<KVNamespace, Map<string, { assignments: RankedRoleAssignments, expiresAt: number }>>()

const EARN_CUMULATIVE_PERCENT_ANCHORS = [0.05, 0.20, 0.40, 0.90] as const
const KEEP_CUMULATIVE_PERCENT_BUFFER_PER_TIER = 0.005
const DEMOTION_DELAY_SYNCS = 7
const GLOBAL_RATING_SCOPE = 'global'
const MODE_LADDER_MIN_GAMES = 10
const TIER_1_EVIDENCE_GATE = { effectiveGames: 18 }
const TIER_2_EVIDENCE_GATE = { effectiveGames: 16 }
const TIER_3_EVIDENCE_GATE = { effectiveGames: 8 }
const TIER_1_QUALITY_GATE = { winsVsTier1: 1, winsVsTier2Plus: 4 }
const BEST_MODE_QUALITY_FLOOR_MIN_GAMES = 20
const TIER_2_MODE_QUALITY_FLOOR = { modeTier: 3, minModeGames: 18, minRoleScore: 900, winsVsTier1: 2 }
const TIER_4_PARTICIPATION_FLOOR = { effectiveGames: 30, wins: 5 }
const TIER_4_PARTICIPATION_FLOOR_TIER_NUMBER = 4
const TIER_3_EFFECTIVE_TIER_1_WIN_FLOOR = 0.5
const TIER_3_EFFECTIVE_TIER_2_PLUS_WIN_FLOOR = 1 / 3
const TIER_3_RAW_TIER_2_PLUS_WIN_FLOOR = 2
const QUALITY_FLOOR_EPSILON = 1e-9
const GRACE_CAP_RATIO_BY_TIER_RANK = new Map<number, number>([
  [1, 0.75],
  [2, 0.75],
  [3, 1.20],
])

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
    const cutoff = cutoffByTier.get(threshold.tier)
    tiers.push({
      tier: threshold.tier,
      roleId: getConfiguredRankedRoleId(config, threshold.tier),
      isFallback: false,
      locked: false,
      unlockMinPlayers: null,
      playersNeededToUnlock: null,
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
  return buildRankedRolePreview(options)
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

export async function projectRankedTierForScore(options: RankedRoleSyncOptions & {
  mode: LeaderboardMode
  score: number
}): Promise<ProjectedRankedTierSummary> {
  const state = await buildRankedRolePreviewState({
    ...options,
    includePlayerIdentities: false,
  })
  const tier = resolveProjectedTierForScore(state.laddersByMode.get(options.mode), state.config, options.score)

  return {
    tier,
    roleId: tier ? getConfiguredRankedRoleId(state.config, tier) : null,
    label: tier ? getConfiguredRankedRoleLabel(state.config, tier) : null,
  }
}

export async function syncRankedRoles(options: RankedRoleSyncOptions): Promise<RankedRoleSyncResult> {
  const state = await buildRankedRolePreviewState({
    ...options,
    includePlayerIdentities: false,
  })
  const preview = state.preview

  const activeSeason = await getActiveSeason(options.db)
  if (activeSeason) {
    await syncSeasonPeakRanks(options.db, {
      seasonId: activeSeason.id,
      candidates: preview.playerPreviews.map(player => ({
        playerId: player.playerId,
        tier: player.liveAssignment.tier,
        sourceMode: player.liveAssignment.sourceMode,
      })).filter((candidate, index) => preview.playerPreviews[index]?.managed),
      activePlayerIds: buildSeasonActivePlayerIds(state.globalRatings, activeSeason.startsAt),
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
  let attemptedDiscordChanges = 0
  let pendingDiscordChanges = 0
  if (options.applyDiscord) {
    const token = options.token?.trim()
    if (!token) throw new Error('Cannot sync ranked roles without a Discord bot token.')
    await persistRankedRoleSyncState({
      kv: options.kv,
      guildId: options.guildId,
      previousAssignments: state.previousAssignments,
      previousCandidates: state.previousCandidates,
      playerPreviews: preview.playerPreviews,
      appliedRoleIdsByPlayerId: null,
    })
    const applyResult = await applyPendingRankedRoleDiscordChanges({
      kv: options.kv,
      guildId: options.guildId,
      token,
      maxPlayers: options.maxDiscordRoleSyncPlayers,
    })
    attemptedDiscordChanges = applyResult.attemptedChanges
    appliedDiscordChanges = applyResult.appliedChanges
    pendingDiscordChanges = applyResult.pendingChanges
  }
  else {
    await persistRankedRoleSyncState({
      kv: options.kv,
      guildId: options.guildId,
      previousAssignments: state.previousAssignments,
      previousCandidates: state.previousCandidates,
      playerPreviews: preview.playerPreviews,
      appliedRoleIdsByPlayerId: null,
    })
  }

  return {
    ...preview,
    attemptedDiscordChanges,
    appliedDiscordChanges,
    pendingDiscordChanges,
  }
}

export async function applyPendingRankedRoleDiscordChanges(options: {
  kv: KVNamespace
  guildId: string
  token: string
  maxPlayers?: number
}): Promise<{ attemptedChanges: number, appliedChanges: number, pendingChanges: number }> {
  const token = options.token.trim()
  if (!token) throw new Error('Cannot apply ranked roles without a Discord bot token.')
  return applyCurrentRankRoles(options.kv, options.guildId, token, { maxPlayers: options.maxPlayers })
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
  const trackedAssignments = Object.entries(previousAssignments.byPlayerId)
    .filter(([playerId]) => isDiscordSnowflake(playerId))

  await setCurrentRankAssignments(options.kv, options.guildId, { byPlayerId: {} })
  await setRankedRoleDemotionCandidates(options.kv, options.guildId, { byPlayerId: {} })

  const token = options.token?.trim()
  if (!token || trackedAssignments.length === 0) {
    return {
      clearedAssignments: trackedAssignments.length,
      appliedDiscordChanges: 0,
    }
  }

  const [config, previousAppliedConfig] = await Promise.all([
    getRankedRoleConfig(options.kv, options.guildId),
    getAppliedRankedRoleConfig(options.kv, options.guildId),
  ])
  const fallbackTier = getLowestRankedRoleTier(config)
  const fallbackRoleId = fallbackTier ? getConfiguredRankedRoleId(config, fallbackTier) : null

  let appliedDiscordChanges = 0
  for (const [playerId, previousAssignment] of trackedAssignments) {
    const previousRoleId = resolvePreviouslyAppliedRoleId(previousAssignment, previousAppliedConfig, config)
    const changed = await applyTrackedRankRoleChange({
      token,
      guildId: options.guildId,
      playerId,
      previousRoleId,
      nextRoleId: fallbackRoleId,
    })
    if (changed) appliedDiscordChanges += 1
  }

  await setAppliedRankedRoleConfig(options.kv, options.guildId, config)

  return {
    clearedAssignments: trackedAssignments.length,
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
  const now = Date.now()
  const cached = getCachedCurrentRankAssignments(kv, guildId, now)
  if (cached) return cached

  const key = currentRankAssignmentsKey(guildId)
  const raw = await kv.get(key, 'json')
  const assignments = normalizeRankedRoleAssignments(raw)
  cacheCurrentRankAssignments(kv, guildId, assignments, now)
  return assignments
}

export function getCachedCurrentRankAssignments(kv: KVNamespace, guildId: string, now = Date.now()): RankedRoleAssignments | null {
  const cached = getCurrentRankAssignmentsCache(kv).get(currentRankAssignmentsKey(guildId))
  if (!cached || cached.expiresAt <= now) return null
  return cloneRankedRoleAssignments(cached.assignments)
}

export function normalizeRankedRoleAssignments(raw: unknown): RankedRoleAssignments {
  const rawByPlayerId = raw && typeof raw === 'object' ? (raw as { byPlayerId?: unknown }).byPlayerId : null
  if (!rawByPlayerId || typeof rawByPlayerId !== 'object') return { byPlayerId: {} }

  const byPlayerId: Record<string, CurrentRankAssignment> = {}
  for (const [playerId, assignment] of Object.entries(rawByPlayerId as Record<string, unknown>)) {
    const normalized = normalizeCurrentRankAssignment(assignment)
    if (!normalized) continue
    byPlayerId[playerId] = normalized
  }

  return { byPlayerId }
}

function cloneRankedRoleAssignments(assignments: RankedRoleAssignments): RankedRoleAssignments {
  return {
    byPlayerId: Object.fromEntries(Object.entries(assignments.byPlayerId).map(([playerId, assignment]) => [playerId, { ...assignment }])),
  }
}

export async function setCurrentRankAssignments(kv: KVNamespace, guildId: string, assignments: RankedRoleAssignments): Promise<void> {
  await kv.put(currentRankAssignmentsKey(guildId), JSON.stringify(assignments))
  cacheCurrentRankAssignments(kv, guildId, normalizeRankedRoleAssignments(assignments))
}

export function cacheCurrentRankAssignments(kv: KVNamespace, guildId: string, assignments: RankedRoleAssignments, now = Date.now()): void {
  getCurrentRankAssignmentsCache(kv).set(currentRankAssignmentsKey(guildId), {
    assignments: cloneRankedRoleAssignments(assignments),
    expiresAt: now + CURRENT_ASSIGNMENTS_CACHE_TTL_MS,
  })
}

export function clearCurrentRankAssignmentsCache(kv: KVNamespace, guildId?: string): void {
  const cache = currentRankAssignmentsCacheByNamespace.get(kv)
  if (!cache) return
  if (guildId) cache.delete(currentRankAssignmentsKey(guildId))
  else cache.clear()
}

function getCurrentRankAssignmentsCache(kv: KVNamespace): Map<string, { assignments: RankedRoleAssignments, expiresAt: number }> {
  const current = currentRankAssignmentsCacheByNamespace.get(kv)
  if (current) return current
  const next = new Map<string, { assignments: RankedRoleAssignments, expiresAt: number }>()
  currentRankAssignmentsCacheByNamespace.set(kv, next)
  return next
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

export function currentRankAssignmentsKey(guildId: string): string {
  return `${CURRENT_ASSIGNMENTS_KEY_PREFIX}${guildId}`
}

function demotionCandidatesKey(guildId: string): string {
  return `${DEMOTION_CANDIDATES_KEY_PREFIX}${guildId}`
}

function appliedRoleConfigKey(guildId: string): string {
  return `${APPLIED_ROLE_CONFIG_KEY_PREFIX}${guildId}`
}

function discordApplyCursorKey(guildId: string): string {
  return `${DISCORD_APPLY_CURSOR_KEY_PREFIX}${guildId}`
}

async function getDiscordApplyCursor(kv: KVNamespace, guildId: string): Promise<string | null> {
  const value = await kv.get(discordApplyCursorKey(guildId))
  return typeof value === 'string' && isDiscordSnowflake(value) ? value : null
}

async function setDiscordApplyCursor(kv: KVNamespace, guildId: string, playerId: string): Promise<void> {
  await kv.put(discordApplyCursorKey(guildId), playerId)
}

async function clearDiscordApplyCursor(kv: KVNamespace, guildId: string): Promise<void> {
  await kv.delete(discordApplyCursorKey(guildId))
}

function normalizeMaxDiscordRoleSyncPlayers(value: number | undefined): number {
  if (value == null) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.round(value))
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
  rankedMinGames = MODE_LADDER_MIN_GAMES,
  fullRosterGraceCaps = true,
}: RankedRoleSyncOptions): Promise<RankedRolePreviewState> {
  const requestedPlayerIds = buildRequestedPlayerIds(playerIds)
  const [leaderboardSnapshots, previousAssignments, config, globalRatingRows] = await Promise.all([
    getLeaderboardModeSnapshotsForPreview(db, kv),
    getCurrentRankAssignments(kv, guildId),
    getRankedRoleConfig(kv, guildId),
    db
      .select({
        playerId: playerRatings.playerId,
        mu: playerRatings.mu,
        sigma: playerRatings.sigma,
        gamesPlayed: playerRatings.gamesPlayed,
        wins: playerRatings.wins,
        importedGames: playerRatings.importedGames,
        effectiveGames: playerRatings.effectiveGames,
        winsVsTier1: playerRatings.winsVsTier1,
        winsVsTier2Plus: playerRatings.winsVsTier2Plus,
        effectiveWinsVsTier1: playerRatings.effectiveWinsVsTier1,
        effectiveWinsVsTier2Plus: playerRatings.effectiveWinsVsTier2Plus,
        lastPlayedAt: playerRatings.lastPlayedAt,
      })
      .from(playerRatings)
      .where(eq(playerRatings.mode, GLOBAL_RATING_SCOPE)),
  ])
  const previousCandidates = shouldLoadRankedRoleDemotionCandidates(previousAssignments, fullRosterGraceCaps ? null : requestedPlayerIds)
    ? await getRankedRoleDemotionCandidates(kv, guildId)
    : { byPlayerId: {} }

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
  const globalRatings: GlobalRatingSnapshotRow[] = globalRatingRows
    .map(row => ({
      playerId: row.playerId,
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      importedGames: row.importedGames,
      effectiveGames: row.effectiveGames,
      winsVsTier1: row.winsVsTier1,
      winsVsTier2Plus: row.winsVsTier2Plus,
      effectiveWinsVsTier1: row.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: row.effectiveWinsVsTier2Plus,
      lastPlayedAt: row.lastPlayedAt ?? null,
    }))
    .filter(row => isDiscordSnowflake(row.playerId))

  const globalRatingByPlayerId = new Map(globalRatings.map(row => [row.playerId, row]))
  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  const globalLadders = buildGlobalLadderSnapshots(globalRatings, config)
  const rawGlobalEarnAssignments = buildRawGlobalEarnAssignments(globalRatings, config)

  const laddersByMode = new Map<LeaderboardMode, LadderSnapshots>()
  for (const mode of LEADERBOARD_MODES) {
    laddersByMode.set(mode, buildLadderSnapshots(
      ratings.filter(row => row.mode === mode),
      mode,
      config,
      rankedMinGames,
    ))
  }
  const modeRatingsByPlayerId = buildModeRatingsByPlayerId(ratings)

  const knownPlayerIds = new Set<string>()
  for (const row of ratings) knownPlayerIds.add(row.playerId)
  for (const row of globalRatings) knownPlayerIds.add(row.playerId)
  for (const playerId of Object.keys(previousAssignments.byPlayerId)) {
    if (!isDiscordSnowflake(playerId)) continue
    knownPlayerIds.add(playerId)
  }

  const calculationPlayerIds = fullRosterGraceCaps || !requestedPlayerIds
    ? [...new Set([...knownPlayerIds, ...(requestedPlayerIds ?? [])])].sort((a, b) => a.localeCompare(b))
    : requestedPlayerIds
  const previewPlayerIdSet = requestedPlayerIds ? new Set(requestedPlayerIds) : null
  const identityPlayerIds = requestedPlayerIds ?? calculationPlayerIds
  const playerIdentityById = await loadPlayerIdentityById(
    db,
    identityPlayerIds,
    includePlayerIdentities,
  )

  const playerPreviews: RankedRolePlayerPreview[] = []

  for (const playerId of calculationPlayerIds) {
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
    const globalRating = globalRatingByPlayerId.get(playerId) ?? null
    const qualified = globalRating ? isGlobalRatingQualified(globalRating) : false
    const earnAssignment = qualified ? toCurrentAssignment(globalLadders.earn.get(playerId) ?? null) : null
    const keepAssignment = qualified ? toCurrentAssignment(globalLadders.keep.get(playerId) ?? null) : null
    const ladderTiers = buildLadderTierMap(playerId, laddersByMode)
    const ladderRanks = buildLadderRankMap(playerId, laddersByMode)
    const ladderScores = buildLadderScoreMap(playerId, laddersByMode)
    const liveAssignment = qualified
      ? resolveLiveAssignment({
          earnAssignment,
          keepAssignment,
          fallbackTier,
          previousAssignment,
          previousCandidate,
          now,
          advanceDemotionWindow,
        })
      : { assignment: previousAssignment ?? { tier: fallbackTier, sourceMode: null }, pendingDemotion: null }
    const qualityAdjustedAssignment = qualified && globalRating
      ? applyQualityFloor({
          liveAssignment,
          globalRating,
          globalEarnTier: earnAssignment?.tier ?? fallbackTier,
          modeRatings: modeRatingsByPlayerId.get(playerId) ?? new Map(),
          laddersByMode,
          config,
        })
      : liveAssignment
    const evidenceCappedAssignment = qualified && globalRating
      ? capAssignmentResultByEvidence(qualityAdjustedAssignment, globalRating, config)
      : liveAssignment
    const tier1ProtectedAssignment = qualified && globalRating
      ? applyThinTier1Protection(evidenceCappedAssignment, previousAssignment, globalRating)
      : evidenceCappedAssignment
    const finalAssignment = qualified && globalRating
      ? applyTier4ParticipationFloor(tier1ProtectedAssignment, globalRating, config)
      : tier1ProtectedAssignment

    playerPreviews.push({
      playerId,
      displayName: playerIdentityById.get(playerId)?.displayName ?? `<@${playerId}>`,
      qualified,
      managed: qualified,
      globalScore: globalRating ? roleRating(globalRating.mu, globalRating.sigma) : null,
      liveAssignment: liveAssignment.assignment,
      assignment: finalAssignment.assignment,
      previousAssignment,
      previousSourceMode: previousAssignment?.sourceMode ?? null,
      ladderTiers,
      ladderRanks,
      ladderScores,
      pendingDemotion: finalAssignment.pendingDemotion,
      status: qualified ? classifyPreviewStatus(previousAssignment, finalAssignment.assignment, fallbackTier) : 'kept',
    })
  }

  applyGraceCaps(playerPreviews, rawGlobalEarnAssignments, globalRatingByPlayerId, config)
  for (const player of playerPreviews) {
    player.status = player.qualified ? classifyPreviewStatus(player.previousAssignment, player.assignment, fallbackTier) : 'kept'
  }

  const outputPlayerPreviews = previewPlayerIdSet
    ? playerPreviews.filter(player => previewPlayerIdSet.has(player.playerId))
    : playerPreviews
  const distribution = createTierCounter(config)
  let unrankedCount = 0
  for (const player of outputPlayerPreviews) {
    if (!player.qualified && player.previousAssignment == null) unrankedCount += 1
    if (player.qualified) distribution[player.assignment.tier] = (distribution[player.assignment.tier] ?? 0) + 1
  }

  outputPlayerPreviews.sort(comparePlayerPreview)

  return {
    preview: {
      guildId,
      evaluatedAt: now,
      config,
      playerPreviews: outputPlayerPreviews,
      missingConfigTiers: getMissingRankedRoleConfigTiers(config),
      unrankedCount,
      distribution,
    },
    ratings,
    globalRatings,
    config,
    laddersByMode,
    globalLadders,
    previousAssignments,
    previousCandidates,
  }
}

function buildRequestedPlayerIds(playerIds: string[] | undefined): string[] | null {
  if (!playerIds || playerIds.length === 0) return null

  const filtered = [...new Set(playerIds.filter(isDiscordSnowflake))]
  if (filtered.length === 0) return []
  return filtered.sort((a, b) => a.localeCompare(b))
}

function shouldLoadRankedRoleDemotionCandidates(
  previousAssignments: RankedRoleAssignments,
  requestedPlayerIds: string[] | null,
): boolean {
  if (requestedPlayerIds) {
    return requestedPlayerIds.some(playerId => previousAssignments.byPlayerId[playerId] != null)
  }

  return Object.keys(previousAssignments.byPlayerId).some(isDiscordSnowflake)
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

function buildSeasonActivePlayerIds(ratings: Array<{ playerId: string, lastPlayedAt: number | null }>, startsAt: number): Set<string> {
  const playerIds = new Set<string>()
  for (const row of ratings) {
    if (row.lastPlayedAt == null || row.lastPlayedAt < startsAt) continue
    playerIds.add(row.playerId)
  }
  return playerIds
}

function buildModeRatingsByPlayerId(ratings: RatingSnapshotRow[]): Map<string, Map<LeaderboardMode, RatingSnapshotRow>> {
  const byPlayerId = new Map<string, Map<LeaderboardMode, RatingSnapshotRow>>()
  for (const row of ratings) {
    const playerRatings = byPlayerId.get(row.playerId) ?? new Map<LeaderboardMode, RatingSnapshotRow>()
    playerRatings.set(row.mode, row)
    byPlayerId.set(row.playerId, playerRatings)
  }
  return byPlayerId
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
): LadderSnapshots {
  const ranked = rows
    .filter(row => row.gamesPlayed >= getLeaderboardMinGames(mode))
    .map(row => ({
      playerId: row.playerId,
      score: displayRating(row.mu, row.sigma),
      lastPlayedAt: row.lastPlayedAt,
    }))
    .sort(compareLadderEntry)
  const qualifiedPlayerIds = new Set(rows
    .filter(row => row.gamesPlayed >= rankedMinGames)
    .map(row => row.playerId))

  return {
    earn: buildEarnAssignments(ranked, mode, config, qualifiedPlayerIds),
    keep: buildKeepAssignments(ranked, mode, config, qualifiedPlayerIds),
    ranks: new Map(ranked.map((entry, index) => [entry.playerId, index + 1])),
    scores: new Map(ranked.map(entry => [entry.playerId, entry.score])),
  }
}

function buildGlobalLadderSnapshots(
  rows: GlobalRatingSnapshotRow[],
  config: RankedRoleConfig,
): LadderSnapshots {
  const rowByPlayerId = new Map(rows.map(row => [row.playerId, row]))
  const ranked = buildGlobalLadderEntries(rows)
  const qualifiedPlayerIds = new Set(ranked.map(row => row.playerId))

  return {
    earn: applyGlobalEvidenceGates(buildEarnAssignments(ranked, null, config, qualifiedPlayerIds), rowByPlayerId, config),
    keep: applyGlobalEvidenceGates(buildKeepAssignments(ranked, null, config, qualifiedPlayerIds), rowByPlayerId, config),
    ranks: new Map(ranked.map((entry, index) => [entry.playerId, index + 1])),
    scores: new Map(ranked.map(entry => [entry.playerId, entry.score])),
  }
}

function buildRawGlobalEarnAssignments(
  rows: GlobalRatingSnapshotRow[],
  config: RankedRoleConfig,
): Map<string, LadderAssignment> {
  const ranked = buildGlobalLadderEntries(rows)
  return buildEarnAssignments(ranked, null, config, new Set(ranked.map(row => row.playerId)))
}

function buildGlobalLadderEntries(rows: GlobalRatingSnapshotRow[]): LadderEntry[] {
  return rows
    .filter(isGlobalRatingQualified)
    .map(row => ({
      playerId: row.playerId,
      score: roleRating(row.mu, row.sigma),
      lastPlayedAt: row.lastPlayedAt,
    }))
    .sort(compareLadderEntry)
}

function applyGraceCaps(
  playerPreviews: RankedRolePlayerPreview[],
  rawGlobalEarnAssignments: Map<string, LadderAssignment>,
  globalRatingByPlayerId: Map<string, GlobalRatingSnapshotRow>,
  config: RankedRoleConfig,
): void {
  const rawBandSizes = createTierCounter(config)
  for (const assignment of rawGlobalEarnAssignments.values()) {
    rawBandSizes[assignment.tier] = (rawBandSizes[assignment.tier] ?? 0) + 1
  }

  const graceCandidatesByTier = new Map<CompetitiveTier, RankedRolePlayerPreview[]>()
  for (const player of playerPreviews) {
    if (!player.qualified) continue
    const rawAssignment = rawGlobalEarnAssignments.get(player.playerId)
    if (!rawAssignment) continue
    const targetRank = rankedRoleTierNumber(player.assignment.tier)
    if (targetRank == null || !GRACE_CAP_RATIO_BY_TIER_RANK.has(targetRank)) continue
    if (competitiveTierRank(player.assignment.tier) <= competitiveTierRank(rawAssignment.tier)) continue

    const candidates = graceCandidatesByTier.get(player.assignment.tier) ?? []
    candidates.push(player)
    graceCandidatesByTier.set(player.assignment.tier, candidates)
  }

  for (const [tier, candidates] of graceCandidatesByTier) {
    const tierRank = rankedRoleTierNumber(tier)
    if (tierRank == null) continue
    const ratio = GRACE_CAP_RATIO_BY_TIER_RANK.get(tierRank)
    if (ratio == null) continue
    const rawBandSize = rawBandSizes[tier] ?? 0
    const cap = rawBandSize > 0 ? Math.max(1, Math.floor(rawBandSize * ratio)) : 0
    const excludedCount = Math.max(0, candidates.length - cap)
    if (excludedCount <= 0) continue

    candidates.sort((left, right) => compareGraceCapCandidate(left, right, globalRatingByPlayerId))
    const fallbackTier = createRankedRoleTierId(tierRank + 1)
    if (!hasConfiguredRankedRoleTier(config, fallbackTier)) continue

    for (const player of candidates.slice(0, excludedCount)) {
      player.assignment = { tier: fallbackTier, sourceMode: null }
      player.pendingDemotion = null
    }
  }
}

function compareGraceCapCandidate(
  left: RankedRolePlayerPreview,
  right: RankedRolePlayerPreview,
  globalRatingByPlayerId: Map<string, GlobalRatingSnapshotRow>,
): number {
  const leftRating = globalRatingByPlayerId.get(left.playerId)
  const rightRating = globalRatingByPlayerId.get(right.playerId)
  return (left.globalScore ?? Number.POSITIVE_INFINITY) - (right.globalScore ?? Number.POSITIVE_INFINITY)
    || (leftRating?.effectiveGames ?? Number.POSITIVE_INFINITY) - (rightRating?.effectiveGames ?? Number.POSITIVE_INFINITY)
    || left.playerId.localeCompare(right.playerId)
}

function isGlobalRatingQualified(row: GlobalRatingSnapshotRow): boolean {
  return row.effectiveGames >= RANKED_ROLE_MIN_EFFECTIVE_GAMES
}

function applyGlobalEvidenceGates(
  assignments: Map<string, LadderAssignment>,
  rowByPlayerId: Map<string, GlobalRatingSnapshotRow>,
  config: RankedRoleConfig,
): Map<string, LadderAssignment> {
  for (const [playerId, assignment] of assignments) {
    const row = rowByPlayerId.get(playerId)
    if (!row) continue
    assignments.set(playerId, {
      ...assignment,
      tier: capTierByEvidence(assignment.tier, row, config),
    })
  }
  return assignments
}

function capTierByEvidence(tier: CompetitiveTier, row: GlobalRatingSnapshotRow, config: RankedRoleConfig): CompetitiveTier {
  const tierNumber = rankedRoleTierNumber(tier)
  if (tierNumber == null) return tier

  if (tierNumber <= 1 && (!meetsEvidenceGate(row, TIER_1_EVIDENCE_GATE) || !meetsTier1QualityGate(row))) {
    return capTierByEvidence(createRankedRoleTierId(2), row, config)
  }
  if (tierNumber <= 2 && !meetsEvidenceGate(row, TIER_2_EVIDENCE_GATE)) {
    return capTierByEvidence(createRankedRoleTierId(3), row, config)
  }
  if (tierNumber <= 3 && !meetsEvidenceGate(row, TIER_3_EVIDENCE_GATE)) {
    return getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  }

  return hasConfiguredRankedRoleTier(config, tier)
    ? tier
    : getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
}

function meetsEvidenceGate(row: GlobalRatingSnapshotRow, gate: { effectiveGames: number }): boolean {
  return row.effectiveGames >= gate.effectiveGames
}

function meetsTier1QualityGate(row: GlobalRatingSnapshotRow): boolean {
  return row.winsVsTier1 >= TIER_1_QUALITY_GATE.winsVsTier1
    && row.winsVsTier2Plus >= TIER_1_QUALITY_GATE.winsVsTier2Plus
}

function capAssignmentResultByEvidence(
  result: { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null },
  row: GlobalRatingSnapshotRow,
  config: RankedRoleConfig,
): { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null } {
  const cappedTier = capTierByEvidence(result.assignment.tier, row, config)
  if (cappedTier === result.assignment.tier) return result
  return {
    assignment: { tier: cappedTier, sourceMode: null },
    pendingDemotion: null,
  }
}

function applyThinTier1Protection(
  result: { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null },
  previousAssignment: CurrentRankAssignment | null,
  row: GlobalRatingSnapshotRow,
): { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null } {
  if (!previousAssignment || rankedRoleTierNumber(previousAssignment.tier) !== 1) return result
  if (row.effectiveGames >= TIER_1_EVIDENCE_GATE.effectiveGames) return result
  if (competitiveTierRank(result.assignment.tier) >= competitiveTierRank(previousAssignment.tier)) return result
  return {
    assignment: { tier: previousAssignment.tier, sourceMode: null },
    pendingDemotion: null,
  }
}

function applyQualityFloor(input: {
  liveAssignment: { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null }
  globalRating: GlobalRatingSnapshotRow
  globalEarnTier: CompetitiveTier
  modeRatings: Map<LeaderboardMode, RatingSnapshotRow>
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>
  config: RankedRoleConfig
}): { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null } {
  const floorTier = resolveQualityFloorTier(input)
  if (!floorTier || competitiveTierRank(input.liveAssignment.assignment.tier) >= competitiveTierRank(floorTier)) {
    return input.liveAssignment
  }

  return {
    assignment: { tier: floorTier, sourceMode: null },
    pendingDemotion: null,
  }
}

function applyTier4ParticipationFloor(
  result: { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null },
  row: GlobalRatingSnapshotRow,
  config: RankedRoleConfig,
): { assignment: CurrentRankAssignment, pendingDemotion: RankedRoleDemotionCandidate | null } {
  const floorTier = qualityFloorTier(TIER_4_PARTICIPATION_FLOOR_TIER_NUMBER, config)
  if (!floorTier || !meetsTier4ParticipationFloor(row)) return result
  if (competitiveTierRank(result.assignment.tier) >= competitiveTierRank(floorTier)) return result
  return {
    assignment: { tier: floorTier, sourceMode: null },
    pendingDemotion: null,
  }
}

function meetsTier4ParticipationFloor(row: GlobalRatingSnapshotRow): boolean {
  return row.effectiveGames >= TIER_4_PARTICIPATION_FLOOR.effectiveGames
    && row.wins >= TIER_4_PARTICIPATION_FLOOR.wins
}

function resolveQualityFloorTier(input: {
  globalRating: GlobalRatingSnapshotRow
  globalEarnTier: CompetitiveTier
  modeRatings: Map<LeaderboardMode, RatingSnapshotRow>
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>
  config: RankedRoleConfig
}): CompetitiveTier | null {
  if (!meetsEvidenceGate(input.globalRating, TIER_3_EVIDENCE_GATE)) return null

  const tier3 = qualityFloorTier(3, input.config)
  const tier2 = qualityFloorTier(2, input.config)
  const hasTier2BestModeEvidence = playerHasTier2BestModeEvidence(input.globalRating.playerId, input.modeRatings, input.laddersByMode)
  const hasTier2ModeQualityFloorEvidence = playerHasModeEvidence(
    input.globalRating.playerId,
    input.modeRatings,
    input.laddersByMode,
    TIER_2_MODE_QUALITY_FLOOR.modeTier,
    TIER_2_MODE_QUALITY_FLOOR.minModeGames,
  )
  let floorTier: CompetitiveTier | null = null

  if (tier3 && hasTier2BestModeEvidence) floorTier = morePrestigiousFloor(floorTier, tier3)
  if (tier3 && rankedRoleTierNumber(input.globalEarnTier) === 4 && hasTier3QualityWinFloor(input.globalRating)) {
    floorTier = morePrestigiousFloor(floorTier, tier3)
  }

  if (tier2 && meetsEvidenceGate(input.globalRating, TIER_2_EVIDENCE_GATE)) {
    if (isAtLeastTier(input.globalEarnTier, 3) && input.globalRating.winsVsTier1 >= 3 && input.globalRating.winsVsTier2Plus >= 15) {
      floorTier = morePrestigiousFloor(floorTier, tier2)
    }
    if (hasTier2BestModeEvidence && input.globalRating.winsVsTier1 >= 3) {
      floorTier = morePrestigiousFloor(floorTier, tier2)
    }
    if (
      hasTier2ModeQualityFloorEvidence
      && roleRating(input.globalRating.mu, input.globalRating.sigma) >= TIER_2_MODE_QUALITY_FLOOR.minRoleScore
      && input.globalRating.winsVsTier1 >= TIER_2_MODE_QUALITY_FLOOR.winsVsTier1
    ) {
      floorTier = morePrestigiousFloor(floorTier, tier2)
    }
  }

  return floorTier
}

function hasTier3QualityWinFloor(row: GlobalRatingSnapshotRow): boolean {
  return row.effectiveWinsVsTier1 + QUALITY_FLOOR_EPSILON >= TIER_3_EFFECTIVE_TIER_1_WIN_FLOOR
    || (
      row.winsVsTier2Plus >= TIER_3_RAW_TIER_2_PLUS_WIN_FLOOR
      && row.effectiveWinsVsTier2Plus + QUALITY_FLOOR_EPSILON >= TIER_3_EFFECTIVE_TIER_2_PLUS_WIN_FLOOR
    )
}

function playerHasTier2BestModeEvidence(
  playerId: string,
  modeRatings: Map<LeaderboardMode, RatingSnapshotRow>,
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>,
): boolean {
  return playerHasModeEvidence(playerId, modeRatings, laddersByMode, 2, BEST_MODE_QUALITY_FLOOR_MIN_GAMES)
}

function playerHasModeEvidence(
  playerId: string,
  modeRatings: Map<LeaderboardMode, RatingSnapshotRow>,
  laddersByMode: Map<LeaderboardMode, LadderSnapshots>,
  tierNumber: number,
  minGames: number,
): boolean {
  for (const mode of LEADERBOARD_MODES) {
    const rating = modeRatings.get(mode)
    if (!rating || rating.gamesPlayed < minGames) continue
    const tier = laddersByMode.get(mode)?.earn.get(playerId)?.tier ?? null
    if (isAtLeastTier(tier, tierNumber)) return true
  }
  return false
}

function qualityFloorTier(tierNumber: number, config: RankedRoleConfig): CompetitiveTier | null {
  const tier = createRankedRoleTierId(tierNumber)
  return hasConfiguredRankedRoleTier(config, tier) ? tier : null
}

function morePrestigiousFloor(current: CompetitiveTier | null, candidate: CompetitiveTier): CompetitiveTier {
  if (!current) return candidate
  return competitiveTierRank(candidate) > competitiveTierRank(current) ? candidate : current
}

function isAtLeastTier(tier: CompetitiveTier | null, tierNumber: number): boolean {
  const currentTierNumber = tier ? rankedRoleTierNumber(tier) : null
  return currentTierNumber != null && currentTierNumber <= tierNumber
}

function rankedRoleTierNumber(tier: CompetitiveTier): number | null {
  const match = /^tier(\d+)$/i.exec(tier.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value) : null
}

function buildEarnAssignments(
  entries: LadderEntry[],
  mode: LeaderboardMode | null,
  config: RankedRoleConfig,
  qualifiedPlayerIds: Set<string>,
): Map<string, LadderAssignment> {
  const n = entries.length
  const assignmentByPlayerId = new Map<string, LadderAssignment>()
  if (n === 0) return assignmentByPlayerId

  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  let start = 0
  for (const threshold of buildRankedTierThresholds(config)) {
    let size = Math.round(n * threshold.earnPercent)
    if (threshold.minimumCountWhenUnlocked > 0) size = Math.max(threshold.minimumCountWhenUnlocked, size)
    size = Math.max(0, Math.min(size, n - start))
    assignTierSlice(assignmentByPlayerId, entries, threshold.tier, mode, start, size, qualifiedPlayerIds)
    start += size
  }

  assignTierSlice(assignmentByPlayerId, entries, fallbackTier, mode, start, n - start, qualifiedPlayerIds)
  return assignmentByPlayerId
}

function buildKeepAssignments(
  entries: LadderEntry[],
  mode: LeaderboardMode | null,
  config: RankedRoleConfig,
  qualifiedPlayerIds: Set<string>,
): Map<string, LadderAssignment> {
  const n = entries.length
  const assignmentByPlayerId = new Map<string, LadderAssignment>()
  if (n === 0) return assignmentByPlayerId

  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
  let previousCount = 0
  for (const threshold of buildRankedTierThresholds(config)) {
    const nextCount = Math.max(previousCount, threshold.minimumCountWhenUnlocked, Math.round(n * threshold.keepCumulativePercent))
    const boundedCount = Math.max(0, Math.min(nextCount, n))
    assignTierSlice(assignmentByPlayerId, entries, threshold.tier, mode, previousCount, boundedCount - previousCount, qualifiedPlayerIds)
    previousCount = boundedCount
  }

  assignTierSlice(assignmentByPlayerId, entries, fallbackTier, mode, previousCount, Math.max(0, n - previousCount), qualifiedPlayerIds)

  return assignmentByPlayerId
}

function assignTierSlice(
  target: Map<string, LadderAssignment>,
  entries: LadderEntry[],
  tier: CompetitiveTier,
  mode: LeaderboardMode | null,
  start: number,
  size: number,
  qualifiedPlayerIds: Set<string>,
): void {
  for (let offset = 0; offset < size; offset++) {
    const index = start + offset
    const entry = entries[index]
    if (!entry) break
    if (!qualifiedPlayerIds.has(entry.playerId)) continue
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

function resolveProjectedTierForScore(
  ladders: LadderSnapshots | undefined,
  config: RankedRoleConfig,
  score: number,
): CompetitiveTier | null {
  if (!Number.isFinite(score)) return null

  const rankedScores = [...(ladders?.scores.values() ?? [])].sort((a, b) => b - a)
  const rankedCount = rankedScores.length
  if (rankedCount <= 0) return null

  let start = 0
  for (const threshold of buildRankedTierThresholds(config)) {
    let size = Math.round(rankedCount * threshold.earnPercent)
    if (threshold.minimumCountWhenUnlocked > 0) size = Math.max(threshold.minimumCountWhenUnlocked, size)
    size = Math.max(0, Math.min(size, rankedCount - start))
    if (size <= 0) continue

    const cutoffScore = rankedScores[(start + size) - 1]
    if (cutoffScore != null && score >= cutoffScore) return threshold.tier
    start += size
  }

  return getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))
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

function buildLadderRankMap(playerId: string, laddersByMode: Map<LeaderboardMode, LadderSnapshots>): Record<LeaderboardMode, number | null> {
  return {
    'duel': laddersByMode.get('duel')?.ranks.get(playerId) ?? null,
    'duo': laddersByMode.get('duo')?.ranks.get(playerId) ?? null,
    'squad': laddersByMode.get('squad')?.ranks.get(playerId) ?? null,
    'ffa': laddersByMode.get('ffa')?.ranks.get(playerId) ?? null,
    'red-death': laddersByMode.get('red-death')?.ranks.get(playerId) ?? null,
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

function toCurrentAssignment(assignment: LadderAssignment | null): CurrentRankAssignment | null {
  if (!assignment) return null
  return { tier: assignment.tier, sourceMode: assignment.mode }
}

function resolveLiveAssignment({
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

async function persistRankedRoleSyncState(options: {
  kv: KVNamespace
  guildId: string
  previousAssignments: RankedRoleAssignments
  previousCandidates: RankedRoleDemotionCandidates
  playerPreviews: RankedRolePlayerPreview[]
  appliedRoleIdsByPlayerId: Map<string, string | null> | null
}): Promise<void> {
  const nextAssignments = { ...options.previousAssignments.byPlayerId }
  const nextCandidates = { ...options.previousCandidates.byPlayerId }

  for (const player of options.playerPreviews) {
    if (!player.managed) continue
    const appliedRoleId = options.appliedRoleIdsByPlayerId?.get(player.playerId)
    const previousAppliedRoleId = options.previousAssignments.byPlayerId[player.playerId]?.appliedRoleId
    const nextAppliedRoleId = appliedRoleId === undefined ? previousAppliedRoleId : appliedRoleId
    nextAssignments[player.playerId] = nextAppliedRoleId
      ? { ...player.assignment, appliedRoleId: nextAppliedRoleId }
      : player.assignment
    if (player.pendingDemotion) nextCandidates[player.playerId] = player.pendingDemotion
    else delete nextCandidates[player.playerId]
  }

  await Promise.all([
    setCurrentRankAssignments(options.kv, options.guildId, { byPlayerId: nextAssignments }),
    setRankedRoleDemotionCandidates(options.kv, options.guildId, { byPlayerId: nextCandidates }),
  ])
}

async function applyCurrentRankRoles(
  kv: KVNamespace,
  guildId: string,
  token: string,
  options: { maxPlayers?: number } = {},
): Promise<{ attemptedChanges: number, appliedChanges: number, pendingChanges: number }> {
  const [config, previousAppliedConfig, currentAssignments, cursor] = await Promise.all([
    getRankedRoleConfig(kv, guildId),
    getAppliedRankedRoleConfig(kv, guildId),
    getCurrentRankAssignments(kv, guildId),
    getDiscordApplyCursor(kv, guildId),
  ])
  const missingTiers = getMissingRankedRoleConfigTiers(config)
  if (missingTiers.length > 0) {
    throw new Error(`Cannot sync ranked roles until all current roles are configured: ${missingTiers.join(', ')}`)
  }
  const managedRoleIds = buildManagedRankedRoleIds(config, previousAppliedConfig)
  const pendingApplications = orderPendingRankedRoleApplications(
    buildPendingRankedRoleApplications(currentAssignments, config),
    cursor,
  )
  if (pendingApplications.length === 0) {
    if (cursor) await clearDiscordApplyCursor(kv, guildId)
    return { attemptedChanges: 0, appliedChanges: 0, pendingChanges: 0 }
  }

  let appliedChanges = 0
  let failedChanges = 0
  let attemptedPlayers = 0
  const maxPlayers = normalizeMaxDiscordRoleSyncPlayers(options.maxPlayers)

  for (const pending of pendingApplications) {
    if (attemptedPlayers >= maxPlayers) break
    attemptedPlayers += 1
    try {
      const plan = await planTrackedRankRoleChange({
        token,
        guildId,
        playerId: pending.playerId,
        previousRoleId: resolvePreviouslyAppliedRoleId(pending.assignment, previousAppliedConfig, config),
        nextRoleId: pending.desiredRoleId,
        managedRoleIds,
      })
      if (!plannedRankRoleChangeHasChanges(plan)) {
        await persistAppliedRankedRoleId(kv, guildId, currentAssignments, pending.playerId, pending.desiredRoleId)
        await setDiscordApplyCursor(kv, guildId, pending.playerId)
        continue
      }

      const changed = await applyPlannedRankRoleChange({
        token,
        guildId,
        playerId: pending.playerId,
        plan,
      })
      await persistAppliedRankedRoleId(kv, guildId, currentAssignments, pending.playerId, pending.desiredRoleId)
      await setDiscordApplyCursor(kv, guildId, pending.playerId)
      if (changed) appliedChanges += 1
    }
    catch (error) {
      failedChanges += 1
      await setDiscordApplyCursor(kv, guildId, pending.playerId)
      console.error(`[ranked-roles] Failed to apply Discord role for ${pending.playerId} in guild ${guildId}:`, error)
    }
  }

  const unattemptedChanges = Math.max(0, pendingApplications.length - attemptedPlayers)
  const pendingChanges = failedChanges + unattemptedChanges
  if (pendingChanges === 0) {
    await clearDiscordApplyCursor(kv, guildId)
    await setAppliedRankedRoleConfig(kv, guildId, config)
  }

  return {
    attemptedChanges: attemptedPlayers,
    appliedChanges,
    pendingChanges,
  }
}

function buildPendingRankedRoleApplications(
  assignments: RankedRoleAssignments,
  config: RankedRoleConfig,
): PendingRankedRoleApplication[] {
  const pending: PendingRankedRoleApplication[] = []
  for (const [playerId, assignment] of Object.entries(assignments.byPlayerId)) {
    if (!isDiscordSnowflake(playerId)) continue
    const desiredRoleId = getConfiguredRankedRoleId(config, assignment.tier)
    if (!desiredRoleId || assignment.appliedRoleId === desiredRoleId) continue
    pending.push({ playerId, assignment, desiredRoleId })
  }
  return pending.sort(comparePendingRankedRoleApplications)
}

function orderPendingRankedRoleApplications(
  pending: PendingRankedRoleApplication[],
  cursor: string | null,
): PendingRankedRoleApplication[] {
  if (pending.length <= 1) return pending

  const knownAppliedRole = pending.filter(item => item.assignment.appliedRoleId != null)
  const unknownAppliedRole = pending.filter(item => item.assignment.appliedRoleId == null)
  return [
    ...rotatePendingApplicationsByCursor(knownAppliedRole, cursor),
    ...rotatePendingApplicationsByCursor(unknownAppliedRole, cursor),
  ]
}

function comparePendingRankedRoleApplications(left: PendingRankedRoleApplication, right: PendingRankedRoleApplication): number {
  const priorityDiff = pendingRankedRoleApplicationPriority(left) - pendingRankedRoleApplicationPriority(right)
  if (priorityDiff !== 0) return priorityDiff
  return left.playerId.localeCompare(right.playerId)
}

function pendingRankedRoleApplicationPriority(application: PendingRankedRoleApplication): number {
  return application.assignment.appliedRoleId == null ? 1 : 0
}

function rotatePendingApplicationsByCursor(
  pending: PendingRankedRoleApplication[],
  cursor: string | null,
): PendingRankedRoleApplication[] {
  if (!cursor || pending.length <= 1) return pending
  const nextIndex = pending.findIndex(item => item.playerId.localeCompare(cursor) > 0)
  if (nextIndex <= 0) return nextIndex === 0 ? pending : pending
  return [...pending.slice(nextIndex), ...pending.slice(0, nextIndex)]
}

async function persistAppliedRankedRoleId(
  kv: KVNamespace,
  guildId: string,
  assignments: RankedRoleAssignments,
  playerId: string,
  roleId: string,
): Promise<void> {
  const assignment = assignments.byPlayerId[playerId]
  if (!assignment) return
  assignments.byPlayerId[playerId] = { ...assignment, appliedRoleId: roleId }
  await setCurrentRankAssignments(kv, guildId, assignments)
}

async function getAppliedRankedRoleConfig(
  kv: KVNamespace,
  guildId: string,
): Promise<Map<CompetitiveTier, string | null> | null> {
  const raw = await kv.get(appliedRoleConfigKey(guildId), 'json') as AppliedRankedRoleConfig | null
  if (!raw || !raw.byTier || typeof raw.byTier !== 'object') return null

  const byTier = new Map<CompetitiveTier, string | null>()
  for (const [rawTier, rawRoleId] of Object.entries(raw.byTier)) {
    const tier = normalizeRankedRoleTierId(rawTier)
    if (!tier) continue
    byTier.set(tier, typeof rawRoleId === 'string' && rawRoleId.length > 0 ? rawRoleId : null)
  }

  return byTier
}

async function setAppliedRankedRoleConfig(
  kv: KVNamespace,
  guildId: string,
  config: RankedRoleConfig,
): Promise<void> {
  const byTier: Record<string, string | null> = {}
  for (let index = 0; index < getRankedRoleTierCount(config); index++) {
    const tier = createRankedRoleTierId(index + 1)
    byTier[tier] = getConfiguredRankedRoleId(config, tier)
  }

  await kv.put(appliedRoleConfigKey(guildId), JSON.stringify({ byTier }))
}

function resolvePreviouslyAppliedRoleId(
  previousAssignment: CurrentRankAssignment | null,
  previousAppliedConfig: Map<CompetitiveTier, string | null> | null,
  currentConfig: RankedRoleConfig,
): string | null {
  if (!previousAssignment) return null
  if (previousAssignment.appliedRoleId) return previousAssignment.appliedRoleId
  if (previousAppliedConfig?.has(previousAssignment.tier)) return previousAppliedConfig.get(previousAssignment.tier) ?? null
  return getConfiguredRankedRoleId(currentConfig, previousAssignment.tier)
}

function buildManagedRankedRoleIds(
  currentConfig: RankedRoleConfig,
  previousAppliedConfig: Map<CompetitiveTier, string | null> | null,
): Set<string> {
  const roleIds = new Set<string>()

  for (let index = 0; index < getRankedRoleTierCount(currentConfig); index++) {
    const roleId = getConfiguredRankedRoleId(currentConfig, createRankedRoleTierId(index + 1))
    if (roleId) roleIds.add(roleId)
  }

  for (const roleId of previousAppliedConfig?.values() ?? []) {
    if (roleId) roleIds.add(roleId)
  }

  return roleIds
}

async function planTrackedRankRoleChange(options: {
  token: string
  guildId: string
  playerId: string
  previousRoleId: string | null
  nextRoleId: string | null
  managedRoleIds: Set<string>
}): Promise<PlannedRankRoleChange> {
  const currentRoleIds = new Set(await fetchGuildMemberRoleIds(options.token, options.guildId, options.playerId))
  const removeRoleIds = new Set<string>()

  for (const roleId of currentRoleIds) {
    if (options.managedRoleIds.has(roleId) && roleId !== options.nextRoleId) removeRoleIds.add(roleId)
  }
  if (options.previousRoleId && options.previousRoleId !== options.nextRoleId && currentRoleIds.has(options.previousRoleId)) {
    removeRoleIds.add(options.previousRoleId)
  }

  return {
    removeRoleIds: [...removeRoleIds].sort((left, right) => left.localeCompare(right)),
    addRoleId: options.nextRoleId && !currentRoleIds.has(options.nextRoleId) ? options.nextRoleId : null,
  }
}

function plannedRankRoleChangeHasChanges(plan: PlannedRankRoleChange): boolean {
  return plan.removeRoleIds.length > 0 || plan.addRoleId != null
}

async function applyPlannedRankRoleChange(options: {
  token: string
  guildId: string
  playerId: string
  plan: PlannedRankRoleChange
}): Promise<boolean> {
  let changed = false

  for (const roleId of options.plan.removeRoleIds) {
    try {
      await removeGuildMemberRole(options.token, options.guildId, options.playerId, roleId)
      changed = true
    }
    catch (error) {
      if (!(error instanceof DiscordApiError && error.status === 404)) throw error
    }
  }

  if (options.plan.addRoleId) {
    try {
      await addGuildMemberRole(options.token, options.guildId, options.playerId, options.plan.addRoleId)
      changed = true
    }
    catch (error) {
      if (!(error instanceof DiscordApiError && error.status === 404)) throw error
    }
  }

  return changed
}

async function applyTrackedRankRoleChange(options: {
  token: string
  guildId: string
  playerId: string
  previousRoleId: string | null
  nextRoleId: string | null
}): Promise<boolean> {
  let changed = false

  if (options.previousRoleId && options.previousRoleId !== options.nextRoleId) {
    try {
      await removeGuildMemberRole(options.token, options.guildId, options.playerId, options.previousRoleId)
      changed = true
    }
    catch (error) {
      if (!(error instanceof DiscordApiError && error.status === 404)) throw error
    }
  }

  if (options.nextRoleId && options.nextRoleId !== options.previousRoleId) {
    try {
      await addGuildMemberRole(options.token, options.guildId, options.playerId, options.nextRoleId)
      changed = true
    }
    catch (error) {
      if (!(error instanceof DiscordApiError && error.status === 404)) throw error
    }
  }

  return changed
}

function buildRankMatchUpdateLine(
  player: RankedRolePlayerPreview,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string | null {
  if (!player.managed) return null
  const previous = player.previousAssignment
  const next = player.assignment
  if (!previous || player.pendingDemotion) return null

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
  const sourceMode = LEADERBOARD_MODES.includes((value as { sourceMode?: unknown }).sourceMode as LeaderboardMode)
    ? (value as { sourceMode?: LeaderboardMode }).sourceMode ?? null
    : null
  const appliedRoleId = normalizeSnowflake((value as { appliedRoleId?: unknown }).appliedRoleId)

  return {
    tier,
    sourceMode,
    ...(appliedRoleId ? { appliedRoleId } : {}),
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

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value)
}

function normalizeSnowflake(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return isDiscordSnowflake(trimmed) ? trimmed : null
}
