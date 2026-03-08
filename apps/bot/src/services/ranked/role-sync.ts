import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { playerRatings, players } from '@civup/db'
import { COMPETITIVE_TIERS, competitiveTierRank, formatLeaderboardModeLabel, LEADERBOARD_MODES } from '@civup/game'
import { displayRating, LEADERBOARD_MIN_GAMES } from '@civup/rating'
import { createChannelMessage, DiscordApiError, editGuildMemberRoles } from '../discord/index.ts'
import { getActiveSeason, syncSeasonPeakModeRanks, syncSeasonPeakRanks } from '../season/index.ts'
import { getSystemChannel } from '../system/channels.ts'
import { fetchGuildMemberRoleIds, formatRankedRoleSlotLabel, getMissingRankedRoleConfigTiers, getRankedRoleConfig, RANKED_ROLE_CONFIG_KEY_PREFIX, RANKED_TIERS_BY_PRESTIGE } from './roles.ts'

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

const CURRENT_ASSIGNMENTS_KEY_PREFIX = 'ranked-roles:current-assignments:'
const DEMOTION_CANDIDATES_KEY_PREFIX = 'ranked-roles:demotion-candidates:'
const RANKED_ROLES_DIRTY_STATE_KEY = 'ranked-roles:dirty'

const TIER_EARN_PERCENT: Record<Exclude<CompetitiveTier, 'pleb'>, number> = {
  champion: 0.015,
  legion: 0.04,
  gladiator: 0.10,
  squire: 0.20,
}

const TIER_UNLOCK_MIN_PLAYERS: Record<CompetitiveTier, number> = {
  champion: 80,
  legion: 40,
  gladiator: 20,
  squire: 8,
  pleb: 0,
}

const TIER_KEEP_OVERALL_PERCENT: Record<Exclude<CompetitiveTier, 'pleb'>, number> = {
  champion: 0.025,
  legion: 0.08,
  gladiator: 0.22,
  squire: 0.45,
}

const DEMOTION_DELAY_SYNCS = 7
const MAX_INACTIVITY_PENALTY = 90

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
    try {
      await postRankAnnouncements(options.kv, options.guildId, token, preview.playerPreviews)
    }
    catch (error) {
      console.error('Failed to post rank announcements:', error)
    }
  }

  return {
    ...preview,
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
    laddersByMode.set(mode, buildLadderSnapshots(ratings.filter(row => row.mode === mode), now))
  }

  const knownPlayerIds = new Set<string>()
  for (const row of ratings) knownPlayerIds.add(row.playerId)
  for (const playerId of Object.keys(previousAssignments.byPlayerId)) {
    if (!isDiscordSnowflake(playerId)) continue
    knownPlayerIds.add(playerId)
  }

  const playerPreviews: RankedRolePlayerPreview[] = []
  const distribution = createTierCounter()
  let unrankedCount = 0

  for (const playerId of [...knownPlayerIds].sort((a, b) => a.localeCompare(b))) {
    const previousAssignment = previousAssignments.byPlayerId[playerId] ?? null
    const previousCandidate = previousCandidates.byPlayerId[playerId] ?? null
    const earnAssignment = mergeLadderAssignments(playerId, laddersByMode, 'earn')
    const keepAssignment = mergeLadderAssignments(playerId, laddersByMode, 'keep')
    const ladderTiers = buildLadderTierMap(playerId, laddersByMode)
    const ladderScores = buildLadderScoreMap(playerId, laddersByMode)
    const finalAssignment = resolveCurrentAssignment({
      earnAssignment,
      keepAssignment,
      previousAssignment,
      previousCandidate,
      now,
      advanceDemotionWindow,
    })

    if (finalAssignment.pendingDemotion == null && previousAssignment == null && finalAssignment.assignment.sourceMode == null) {
      unrankedCount += 1
    }

    distribution[finalAssignment.assignment.tier] += 1
    playerPreviews.push({
      playerId,
      displayName: playerIdentityById.get(playerId)?.displayName ?? `<@${playerId}>`,
      assignment: finalAssignment.assignment,
      previousAssignment,
      previousSourceMode: previousAssignment?.sourceMode ?? null,
      ladderTiers,
      ladderScores,
      pendingDemotion: finalAssignment.pendingDemotion,
      status: classifyPreviewStatus(previousAssignment, finalAssignment.assignment),
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

function buildLadderSnapshots(rows: RatingSnapshotRow[], now: number): LadderSnapshots {
  const eligible = rows
    .filter(row => row.gamesPlayed >= LEADERBOARD_MIN_GAMES)
    .map(row => ({
      playerId: row.playerId,
      score: displayRating(row.mu, row.sigma) - getInactivityPenalty(row.lastPlayedAt, now),
      lastPlayedAt: row.lastPlayedAt,
    }))
    .sort(compareLadderEntry)

  return {
    earn: buildEarnAssignments(eligible),
    keep: buildKeepAssignments(eligible),
    scores: new Map(eligible.map(entry => [entry.playerId, entry.score])),
  }
}

function buildEarnAssignments(entries: LadderEntry[]): Map<string, LadderAssignment> {
  const n = entries.length
  const assignmentByPlayerId = new Map<string, LadderAssignment>()
  if (n === 0) return assignmentByPlayerId

  let start = 0
  for (const tier of RANKED_TIERS_BY_PRESTIGE) {
    if (tier === 'pleb') break
    if (n < TIER_UNLOCK_MIN_PLAYERS[tier]) continue
    let size = Math.round(n * TIER_EARN_PERCENT[tier])
    if ((tier === 'champion' || tier === 'legion') && size < 1) size = 1
    size = Math.max(0, Math.min(size, n - start))
    assignTierSlice(assignmentByPlayerId, entries, tier, start, size)
    start += size
  }

  assignTierSlice(assignmentByPlayerId, entries, 'pleb', start, n - start)
  return assignmentByPlayerId
}

function buildKeepAssignments(entries: LadderEntry[]): Map<string, LadderAssignment> {
  const n = entries.length
  const assignmentByPlayerId = new Map<string, LadderAssignment>()
  if (n === 0) return assignmentByPlayerId

  const championCount = n >= TIER_UNLOCK_MIN_PLAYERS.champion ? Math.max(1, Math.round(n * TIER_KEEP_OVERALL_PERCENT.champion)) : 0
  const legionCount = n >= TIER_UNLOCK_MIN_PLAYERS.legion ? Math.max(Math.max(championCount, 1), Math.round(n * TIER_KEEP_OVERALL_PERCENT.legion)) : championCount
  const gladiatorCount = n >= TIER_UNLOCK_MIN_PLAYERS.gladiator ? Math.max(legionCount, Math.round(n * TIER_KEEP_OVERALL_PERCENT.gladiator)) : legionCount
  const squireCount = n >= TIER_UNLOCK_MIN_PLAYERS.squire ? Math.max(gladiatorCount, Math.round(n * TIER_KEEP_OVERALL_PERCENT.squire)) : gladiatorCount

  assignTierSlice(assignmentByPlayerId, entries, 'champion', 0, Math.max(0, Math.min(championCount, n)))
  assignTierSlice(assignmentByPlayerId, entries, 'legion', championCount, Math.max(0, Math.min(legionCount, n) - championCount))
  assignTierSlice(assignmentByPlayerId, entries, 'gladiator', legionCount, Math.max(0, Math.min(gladiatorCount, n) - legionCount))
  assignTierSlice(assignmentByPlayerId, entries, 'squire', gladiatorCount, Math.max(0, Math.min(squireCount, n) - gladiatorCount))
  assignTierSlice(assignmentByPlayerId, entries, 'pleb', squireCount, Math.max(0, n - squireCount))

  return assignmentByPlayerId
}

function assignTierSlice(
  target: Map<string, LadderAssignment>,
  entries: LadderEntry[],
  tier: CompetitiveTier,
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
      mode: 'ffa',
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
    const withMode = { ...assignment, mode }
    if (!best || compareMergedCandidate(withMode, best) < 0) best = withMode
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
  previousAssignment,
  previousCandidate,
  now,
  advanceDemotionWindow,
}: {
  earnAssignment: CurrentRankAssignment | null
  keepAssignment: CurrentRankAssignment | null
  previousAssignment: CurrentRankAssignment | null
  previousCandidate: RankedRoleDemotionCandidate | null
  now: number
  advanceDemotionWindow: boolean
}): {
  assignment: CurrentRankAssignment
  pendingDemotion: RankedRoleDemotionCandidate | null
} {
  const earned = earnAssignment ?? { tier: 'pleb', sourceMode: null }
  const keep = keepAssignment ?? { tier: 'pleb', sourceMode: null }
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

  const rankedRoleIds = COMPETITIVE_TIERS
    .map(tier => config.currentRoles[tier])
    .filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)

  let appliedChanges = 0
  for (const preview of playerPreviews) {
    if (!isDiscordSnowflake(preview.playerId)) continue
    const desiredRoleId = config.currentRoles[preview.assignment.tier]
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

async function postRankAnnouncements(
  kv: KVNamespace,
  guildId: string,
  token: string,
  playerPreviews: RankedRolePlayerPreview[],
): Promise<void> {
  const channelId = await getSystemChannel(kv, 'rank-announcements')
  if (!channelId) return
  const config = await getRankedRoleConfig(kv, guildId)

  const changedPlayers = playerPreviews
    .map(player => ({ player, line: buildRankAnnouncementLine(player, config) }))
    .filter((entry): entry is { player: RankedRolePlayerPreview, line: string } => typeof entry.line === 'string' && entry.line.length > 0)

  if (changedPlayers.length === 0) return

  await createChannelMessage(token, channelId, {
    content: ['**Rank updates**', ...changedPlayers.map(entry => entry.line)].join('\n'),
    allowed_mentions: {
      users: changedPlayers.map(entry => entry.player.playerId),
      roles: [...new Set(changedPlayers.flatMap((entry) => {
        const roles = [config.currentRoles[entry.player.assignment.tier]]
        if (entry.player.previousAssignment) roles.push(config.currentRoles[entry.player.previousAssignment.tier])
        return roles.filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)
      }))],
    },
  })
}

function buildRankAnnouncementLine(
  player: RankedRolePlayerPreview,
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
): string | null {
  const previous = player.previousAssignment
  const next = player.assignment
  if (!previous) {
    if (competitiveTierRank(next.tier) <= competitiveTierRank('pleb')) return null
    return `- <@${player.playerId}> qualified for ranked at ${formatRankAnnouncementRole(config, next.tier)}${next.sourceMode ? ` in ${formatLeaderboardModeLabel(next.sourceMode, next.sourceMode)}` : ''}.`
  }

  const previousRank = competitiveTierRank(previous.tier)
  const nextRank = competitiveTierRank(next.tier)
  if (nextRank > previousRank) {
    return `- <@${player.playerId}> promoted from ${formatRankAnnouncementRole(config, previous.tier)} to ${formatRankAnnouncementRole(config, next.tier)}${next.sourceMode ? ` in ${formatLeaderboardModeLabel(next.sourceMode, next.sourceMode)}` : ''}.`
  }

  if (nextRank < previousRank) {
    return `- <@${player.playerId}> dropped from ${formatRankAnnouncementRole(config, previous.tier)} to ${formatRankAnnouncementRole(config, next.tier)}${next.sourceMode ? ` in ${formatLeaderboardModeLabel(next.sourceMode, next.sourceMode)}` : ''}.`
  }

  return null
}

function formatRankAnnouncementRole(
  config: Awaited<ReturnType<typeof getRankedRoleConfig>>,
  tier: CompetitiveTier,
): string {
  const roleId = config.currentRoles[tier]
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

function classifyPreviewStatus(previous: CurrentRankAssignment | null, next: CurrentRankAssignment): RankedRolePlayerPreview['status'] {
  if (!previous) return next.tier === 'pleb' ? 'new' : 'promoted'
  const nextRank = competitiveTierRank(next.tier)
  const previousRank = competitiveTierRank(previous.tier)
  if (nextRank > previousRank) return 'promoted'
  if (nextRank < previousRank) return 'demoted'
  if (next.sourceMode !== previous.sourceMode) return 'changed'
  return 'kept'
}

function createTierCounter(): Record<CompetitiveTier, number> {
  return {
    pleb: 0,
    squire: 0,
    gladiator: 0,
    legion: 0,
    champion: 0,
  }
}

function normalizeCurrentRankAssignment(value: unknown): CurrentRankAssignment | null {
  if (!value || typeof value !== 'object') return null
  const tier = (value as { tier?: unknown }).tier
  if (!COMPETITIVE_TIERS.includes(tier as CompetitiveTier)) return null

  const sourceMode = (value as { sourceMode?: unknown }).sourceMode
  return {
    tier: tier as CompetitiveTier,
    sourceMode: LEADERBOARD_MODES.includes(sourceMode as LeaderboardMode) ? sourceMode as LeaderboardMode : null,
  }
}

function normalizeDemotionCandidate(value: unknown): RankedRoleDemotionCandidate | null {
  if (!value || typeof value !== 'object') return null
  const currentTier = (value as { currentTier?: unknown }).currentTier
  const targetTier = (value as { targetTier?: unknown }).targetTier
  if (!COMPETITIVE_TIERS.includes(currentTier as CompetitiveTier)) return null
  if (!COMPETITIVE_TIERS.includes(targetTier as CompetitiveTier)) return null

  return {
    currentTier: currentTier as CompetitiveTier,
    targetTier: targetTier as CompetitiveTier,
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
