import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { RankedRoleConfig } from './roles.ts'
import { playerRatings, players } from '@civup/db'
import { competitiveTierRank, formatLeaderboardModeLabel, LEADERBOARD_MODES } from '@civup/game'
import { displayRating, LEADERBOARD_MIN_GAMES } from '@civup/rating'
import { DiscordApiError, editGuildMemberRoles } from '../discord/index.ts'
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

interface RankedRoleSyncOptions {
  db: Database
  kv: KVNamespace
  guildId: string
  token?: string
  now?: number
  applyDiscord?: boolean
  advanceDemotionWindow?: boolean
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
}

interface RankedTierThreshold {
  tier: CompetitiveTier
  earnPercent: number
  keepOverallPercent: number
  unlockMinPlayers: number
  minimumCountWhenUnlocked: number
}

const CURRENT_ASSIGNMENTS_KEY_PREFIX = 'ranked-roles:current-assignments:'
const DEMOTION_CANDIDATES_KEY_PREFIX = 'ranked-roles:demotion-candidates:'
const RANKED_ROLES_DIRTY_STATE_KEY = 'ranked-roles:dirty'

const EARN_CUMULATIVE_PERCENT_ANCHORS = [0.015, 0.055, 0.155, 0.355] as const
const KEEP_CUMULATIVE_PERCENT_ANCHORS = [0.025, 0.08, 0.22, 0.45] as const
const TIER_UNLOCK_MIN_PLAYER_ANCHORS = [80, 40, 20, 8] as const

const DEMOTION_DELAY_SYNCS = 7
const MAX_INACTIVITY_PENALTY = 90

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
      keepOverallPercent: interpolatePositiveAnchors(KEEP_CUMULATIVE_PERCENT_ANCHORS, progress),
      unlockMinPlayers: Math.max(0, Math.round(interpolatePositiveAnchors(TIER_UNLOCK_MIN_PLAYER_ANCHORS, progress))),
      minimumCountWhenUnlocked: index < Math.min(2, prestigeTierCount) ? 1 : 0,
    }
    previousEarnPercent = cumulativeEarnPercent
    return threshold
  })
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

export async function syncRankedRoles(options: RankedRoleSyncOptions): Promise<RankedRoleSyncResult> {
  const state = await buildRankedRolePreviewState(options)
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

async function buildRankedRolePreview({ db, kv, guildId, now = Date.now(), advanceDemotionWindow = false }: RankedRoleSyncOptions): Promise<RankedRolePreview> {
  const state = await buildRankedRolePreviewState({ db, kv, guildId, now, advanceDemotionWindow })
  return state.preview
}

async function buildRankedRolePreviewState({ db, kv, guildId, now = Date.now(), advanceDemotionWindow = false }: RankedRoleSyncOptions): Promise<RankedRolePreviewState> {
  const [ratingRows, playerRows, previousAssignments, previousCandidates, config] = await Promise.all([
    db.select().from(playerRatings),
    db.select({ id: players.id, displayName: players.displayName }).from(players),
    getCurrentRankAssignments(kv, guildId),
    getRankedRoleDemotionCandidates(kv, guildId),
    getRankedRoleConfig(kv, guildId),
  ])

  const ratings = ratingRows.map(row => ({
    playerId: row.playerId,
    mode: row.mode as LeaderboardMode,
    mu: row.mu,
    sigma: row.sigma,
    gamesPlayed: row.gamesPlayed,
    lastPlayedAt: row.lastPlayedAt ?? null,
  })).filter(row => LEADERBOARD_MODES.includes(row.mode) && isDiscordSnowflake(row.playerId))

  const playerIdentityById = new Map<string, PlayerIdentity>(
    playerRows.map(row => [row.id, { displayName: row.displayName }]),
  )

  const laddersByMode = new Map<LeaderboardMode, LadderSnapshots>()
  for (const mode of LEADERBOARD_MODES) {
    laddersByMode.set(mode, buildLadderSnapshots(ratings.filter(row => row.mode === mode), mode, now, config))
  }

  const knownPlayerIds = new Set<string>()
  for (const row of ratings) knownPlayerIds.add(row.playerId)
  for (const playerId of Object.keys(previousAssignments.byPlayerId)) {
    if (!isDiscordSnowflake(playerId)) continue
    knownPlayerIds.add(playerId)
  }

  const playerPreviews: RankedRolePlayerPreview[] = []
  const distribution = createTierCounter(config)
  let unrankedCount = 0
  const fallbackTier = getLowestRankedRoleTier(config) ?? createRankedRoleTierId(getRankedRoleTierCount(config))

  for (const playerId of [...knownPlayerIds].sort((a, b) => a.localeCompare(b))) {
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
  }
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

function buildLadderSnapshots(rows: RatingSnapshotRow[], mode: LeaderboardMode, now: number, config: RankedRoleConfig): LadderSnapshots {
  const eligible = rows
    .filter(row => row.gamesPlayed >= LEADERBOARD_MIN_GAMES)
    .map(row => ({
      playerId: row.playerId,
      score: displayRating(row.mu, row.sigma) - getInactivityPenalty(row.lastPlayedAt, now),
      lastPlayedAt: row.lastPlayedAt,
    }))
    .sort(compareLadderEntry)

  return {
    earn: buildEarnAssignments(eligible, mode, config),
    keep: buildKeepAssignments(eligible, mode, config),
    scores: new Map(eligible.map(entry => [entry.playerId, entry.score])),
  }
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
      ? Math.max(previousCount, threshold.minimumCountWhenUnlocked, Math.round(n * threshold.keepOverallPercent))
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
    ffa: laddersByMode.get('ffa')?.earn.get(playerId)?.tier ?? null,
    duel: laddersByMode.get('duel')?.earn.get(playerId)?.tier ?? null,
    teamers: laddersByMode.get('teamers')?.earn.get(playerId)?.tier ?? null,
  }
}

function buildLadderScoreMap(playerId: string, laddersByMode: Map<LeaderboardMode, LadderSnapshots>): Record<LeaderboardMode, number | null> {
  return {
    ffa: laddersByMode.get('ffa')?.scores.get(playerId) ?? null,
    duel: laddersByMode.get('duel')?.scores.get(playerId) ?? null,
    teamers: laddersByMode.get('teamers')?.scores.get(playerId) ?? null,
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
    return `🆕 <@${player.playerId}> qualified for ${formatRankAnnouncementRole(config, next.tier)}${next.sourceMode ? ` (${formatLeaderboardModeLabel(next.sourceMode, next.sourceMode)})` : ''}`
  }

  const previousRank = competitiveTierRank(previous.tier)
  const nextRank = competitiveTierRank(next.tier)
  if (nextRank > previousRank) {
    return `⬆️ <@${player.playerId}> ${formatRankAnnouncementRole(config, previous.tier)} -> ${formatRankAnnouncementRole(config, next.tier)}${next.sourceMode ? ` (${formatLeaderboardModeLabel(next.sourceMode, next.sourceMode)})` : ''}`
  }

  if (nextRank < previousRank) {
    return `⬇️ <@${player.playerId}> ${formatRankAnnouncementRole(config, previous.tier)} -> ${formatRankAnnouncementRole(config, next.tier)}${next.sourceMode ? ` (${formatLeaderboardModeLabel(next.sourceMode, next.sourceMode)})` : ''}`
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

function getInactivityPenalty(lastPlayedAt: number | null, now: number): number {
  if (!lastPlayedAt || lastPlayedAt >= now) return 0
  const inactiveDays = Math.floor((now - lastPlayedAt) / 86_400_000)
  if (inactiveDays <= 21) return 0

  let penalty = 0
  penalty += Math.max(0, Math.min(inactiveDays, 42) - 21) * 0.5
  penalty += Math.max(0, Math.min(inactiveDays, 70) - 42) * 0.75
  penalty += Math.max(0, inactiveDays - 70) * 1.0
  return Math.min(MAX_INACTIVITY_PENALTY, penalty)
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
