import type { CompetitiveTier, DraftState, GameMode } from '@civup/game'
import type { PlayerRating } from '@civup/rating'
import type { LobbyJoinEligibilitySnapshot, LobbySnapshot, RankedRoleOptionSnapshot } from '~/client/stores'
import { getDefaultLeaderPoolSize, getMinimumLeaderPoolSize, inferGameMode, MAX_LEADER_POOL_SIZE, slotToTeamIndex, toBalanceLeaderboardMode } from '@civup/game'
import { createRating, predictWinProbabilities, RANKED_ROLE_MIN_GAMES } from '@civup/rating'

export const MAX_TIMER_MINUTES = 30
export const MAX_LEADER_POOL_INPUT = MAX_LEADER_POOL_SIZE

export type LobbyModeValue = GameMode

export interface PlayerRow {
  key: string
  slot: number
  name: string
  playerId: string | null
  avatarUrl: string | null
  partyIds: string[]
  isHost: boolean
  empty: boolean
  pendingSelf: boolean
}

export interface DraftTimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

export interface MinRoleMismatchDetail {
  playerName: string
  roleLabel: string
  roleColor: string | null
}

export interface RankRoleSetDetail {
  boundLabel: string
  roleLabel: string
  roleColor: string | null
}

interface LobbyBalancePlayer {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
}

export interface LobbyBalanceTeamSummary {
  team: number
  playerCount: number
  probability: number
  uncertainty: number
}

export interface LobbyBalanceSummary {
  teams: LobbyBalanceTeamSummary[]
  lowConfidence: boolean
  lowConfidencePlayerCount: number
  averageSigma: number
}

export type OptimisticLobbyAction
  = | {
    kind: 'place-self'
    targetSlot: number
    baseRevision: number
    expiresAt: number
  }
  | {
    kind: 'remove-self'
    baseRevision: number
    expiresAt: number
  }
  | {
    kind: 'move-player'
    playerId: string
    targetSlot: number
    baseRevision: number
    expiresAt: number
  }
  | {
    kind: 'remove-player'
    playerId: string
    baseRevision: number
    expiresAt: number
  }

export type PendingOptimisticLobbyAction
  = | {
    kind: 'place-self'
    targetSlot: number
  }
  | {
    kind: 'remove-self'
  }
  | {
    kind: 'move-player'
    playerId: string
    targetSlot: number
  }
  | {
    kind: 'remove-player'
    playerId: string
  }

export function buildLobbyBalanceSummary(lobby: LobbySnapshot | null): LobbyBalanceSummary | null {
  if (!lobby) return null

  const mode = inferGameMode(lobby.mode)
  if (mode === 'ffa' || !toBalanceLeaderboardMode(mode, { redDeath: lobby.draftConfig.redDeath })) return null

  const playersByTeam = new Map<number, LobbyBalancePlayer[]>()
  for (let slot = 0; slot < lobby.entries.length; slot++) {
    const entry = lobby.entries[slot]
    if (!entry) continue

    const team = slotToTeamIndex(mode, slot, lobby.targetSize)
    if (team == null) continue

    const fallback = createRating(entry.playerId)
    const balanceRating = entry.balanceRating ?? {
      mu: fallback.mu,
      sigma: fallback.sigma,
      gamesPlayed: 0,
    }

    const teamPlayers = playersByTeam.get(team) ?? []
    teamPlayers.push({
      playerId: entry.playerId,
      mu: balanceRating.mu,
      sigma: balanceRating.sigma,
      gamesPlayed: balanceRating.gamesPlayed,
    })
    playersByTeam.set(team, teamPlayers)
  }

  const activeTeams = [...playersByTeam.entries()]
    .filter(([, players]) => players.length > 0)
    .sort((left, right) => left[0] - right[0])
  if (activeTeams.length < 2) return null

  const teamRatings = activeTeams.map(([, players]) => players.map(player => ({
    playerId: player.playerId,
    mu: player.mu,
    sigma: player.sigma,
  } satisfies PlayerRating)))
  const probabilities = predictTeamProbabilities(teamRatings)
  if (!probabilities) return null

  const allPlayers = activeTeams.flatMap(([, players]) => players)
  const lowConfidencePlayerCount = allPlayers.filter(player => player.gamesPlayed < RANKED_ROLE_MIN_GAMES).length
  const averageSigma = allPlayers.reduce((total, player) => total + player.sigma, 0) / allPlayers.length

  return {
    teams: activeTeams.map(([team, players], index) => {
      const probability = probabilities[index] ?? 0
      return {
        team,
        playerCount: players.length,
        probability,
        uncertainty: estimateProbabilityUncertainty(teamRatings, index, probability),
      }
    }),
    lowConfidence: lowConfidencePlayerCount > 0,
    lowConfidencePlayerCount,
    averageSigma,
  }
}

function predictTeamProbabilities(teams: PlayerRating[][]): number[] | null {
  try {
    const probabilities = predictWinProbabilities(teams)
    if (probabilities.length !== teams.length) return null
    if (probabilities.some(probability => typeof probability !== 'number' || !Number.isFinite(probability))) return null
    return probabilities.map(probability => Math.max(0, Math.min(1, probability)))
  }
  catch {
    return null
  }
}

// Estimate how much each side's probability can swing within one sigma.
function estimateProbabilityUncertainty(teams: PlayerRating[][], focusTeam: number, baseProbability: number): number {
  const optimistic = predictTeamProbabilities(adjustTeamRatings(teams, focusTeam, 1))
  const pessimistic = predictTeamProbabilities(adjustTeamRatings(teams, focusTeam, -1))
  if (!optimistic || !pessimistic) return 0

  const optimisticProbability = optimistic[focusTeam] ?? baseProbability
  const pessimisticProbability = pessimistic[focusTeam] ?? baseProbability
  return Math.max(
    Math.abs(baseProbability - optimisticProbability),
    Math.abs(baseProbability - pessimisticProbability),
  )
}

function adjustTeamRatings(teams: PlayerRating[][], focusTeam: number, direction: 1 | -1): PlayerRating[][] {
  return teams.map((team, teamIndex) => team.map(player => ({
    playerId: player.playerId,
    mu: player.mu + ((teamIndex === focusTeam ? direction : -direction) * player.sigma),
    sigma: player.sigma,
  })))
}

export function resolveOptimisticLobbyPlacementAction(
  lobby: LobbySnapshot | null,
  currentUserId: string | null,
  movingPlayerId: string | null,
  targetSlot: number,
  isHostUser: boolean,
): PendingOptimisticLobbyAction | null {
  if (!lobby || !currentUserId || !movingPlayerId) return null
  if (targetSlot < 0 || targetSlot >= lobby.entries.length) return null

  const movingEntry = lobby.entries.find(entry => entry?.playerId === movingPlayerId) ?? null
  const isLinkedMove = lobby.mode !== 'ffa' && (movingEntry?.partyIds?.length ?? 0) > 0

  if (movingPlayerId === currentUserId) {
    const currentUserSlot = lobby.entries.findIndex(entry => entry?.playerId === currentUserId)
    if (currentUserSlot < 0 || currentUserSlot === targetSlot || isLinkedMove) return null
    return { kind: 'place-self', targetSlot }
  }

  if (!isHostUser || isLinkedMove) return null
  return { kind: 'move-player', playerId: movingPlayerId, targetSlot }
}

export function getTimerConfigFromDraft(state: DraftState | null): DraftTimerConfig {
  if (!state) return { banTimerSeconds: null, pickTimerSeconds: null }

  const banTimer = state.steps.find(step => step.action === 'ban')?.timer ?? null
  const pickTimer = state.steps.find(step => step.action === 'pick')?.timer ?? null
  return { banTimerSeconds: banTimer, pickTimerSeconds: pickTimer }
}

export function timerSecondsToMinutesInput(timerSeconds: number | null): string {
  if (timerSeconds == null) return ''
  return formatTimerMinutesInput(timerSeconds)
}

export function timerSecondsToMinutesPlaceholder(timerSeconds: number | null): string {
  if (timerSeconds == null) return ''
  return formatTimerMinutesInput(timerSeconds)
}

export function parseTimerMinutesInput(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return undefined
  if (numeric < 0 || numeric > MAX_TIMER_MINUTES) return undefined
  return numeric
}

export function normalizeTimerMinutesInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return value

  const bounded = Math.min(MAX_TIMER_MINUTES, Math.max(0, numeric))
  return trimTrailingZeros(bounded.toFixed(3))
}

export function formatTimerValue(timerSeconds: number | null, defaultTimerSeconds: number | null = null): string {
  if (timerSeconds == null && defaultTimerSeconds != null) {
    return formatTimerDuration(defaultTimerSeconds)
  }

  if (timerSeconds == null) return 'Server default'
  return formatTimerDuration(timerSeconds)
}

function formatTimerMinutesInput(timerSeconds: number): string {
  return trimTrailingZeros((timerSeconds / 60).toFixed(3))
}

function formatTimerDuration(timerSeconds: number): string {
  if (timerSeconds === 0) return 'Unlimited'
  if (timerSeconds < 60) return timerSeconds === 1 ? '1 second' : `${timerSeconds} seconds`

  const minutes = timerSeconds / 60
  if (Number.isInteger(minutes)) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  return `${trimTrailingZeros(minutes.toFixed(2))} minutes`
}

function trimTrailingZeros(value: string): string {
  return value.replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, '$1')
}

export function leaderPoolSizeToInput(leaderPoolSize: number | null): string {
  if (leaderPoolSize == null) return ''
  return String(leaderPoolSize)
}

export function leaderPoolSizePlaceholder(mode: GameMode, playerCount: number, targetSize?: number): string {
  return String(getDefaultLeaderPoolSize(mode, resolveLeaderPoolDefaultPlayerCount(mode, playerCount, targetSize)))
}

export function getLeaderPoolSizeMinimum(mode: GameMode, playerCount: number): number {
  return getMinimumLeaderPoolSize(mode, playerCount)
}

export function supportsBlindBansControl(mode: GameMode, options: { redDeath?: boolean, targetSize?: number } = {}): boolean {
  if (options.redDeath) return false
  if (mode === 'ffa') return false
  if (mode === '2v2') return options.targetSize === 4
  return true
}

export function parseLeaderPoolSizeInput(value: string, minimum: number, maximum: number = MAX_LEADER_POOL_INPUT): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return undefined
  if (numeric < minimum || numeric > maximum) return undefined
  return numeric
}

export function normalizeLeaderPoolSizeInput(value: string, minimum: number, maximum: number = MAX_LEADER_POOL_INPUT): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return value

  const bounded = Math.min(maximum, Math.max(minimum, Math.round(numeric)))
  return String(bounded)
}

export function formatLeaderPoolValue(
  leaderPoolSize: number | null,
  mode: GameMode,
  playerCount: number,
  targetSize?: number,
): string {
  return String(leaderPoolSize ?? getDefaultLeaderPoolSize(mode, resolveLeaderPoolDefaultPlayerCount(mode, playerCount, targetSize)))
}

function resolveLeaderPoolDefaultPlayerCount(mode: GameMode, playerCount: number, targetSize?: number): number {
  if (typeof targetSize === 'number' && Number.isFinite(targetSize) && targetSize > 0) {
    return targetSize
  }

  return playerCount
}

export function normalizeLobbyRankRoleValue(value: string): CompetitiveTier | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function findRankedRoleOptionByTier(
  options: RankedRoleOptionSnapshot[],
  tier: CompetitiveTier,
): RankedRoleOptionSnapshot | null {
  return options.find(option => option.tier === tier) ?? null
}

export function formatLobbyMinRole(minRole: CompetitiveTier | null, options: RankedRoleOptionSnapshot[]): string {
  if (!minRole) return 'Anyone'
  return findRankedRoleOptionByTier(options, minRole)?.label ?? 'Unranked'
}

export function formatLobbyMaxRole(maxRole: CompetitiveTier | null, options: RankedRoleOptionSnapshot[]): string {
  if (!maxRole) return 'Anyone'
  return findRankedRoleOptionByTier(options, maxRole)?.label ?? 'Unranked'
}

export function buildRankDotStyle(color: string | null): Record<string, string> {
  return color ? { 'background-color': color } : { 'background-color': 'rgba(255,255,255,0.25)' }
}

export function buildRolePillStyle(color: string | null): Record<string, string> {
  if (!color) {
    return {
      'color': 'rgb(229,229,229)',
      'background-color': 'rgba(255,255,255,0.06)',
      'border-color': 'rgba(255,255,255,0.22)',
    }
  }

  const normalized = normalizeHexColor(color)
  if (!normalized) {
    return {
      color,
      'background-color': 'rgba(255,255,255,0.06)',
      'border-color': 'rgba(255,255,255,0.22)',
    }
  }

  return {
    'color': normalized,
    'background-color': `${normalized}1F`,
    'border-color': `${normalized}66`,
  }
}

function normalizeHexColor(color: string): string | null {
  const trimmed = color.trim()
  if (!/^#[0-9A-F]{6}$/i.test(trimmed)) return null
  return trimmed.toUpperCase()
}

export function applyOptimisticLobbyAction(
  lobby: LobbySnapshot | null,
  action: OptimisticLobbyAction | null,
  currentUserId: string | null,
  currentUserDisplayName: string | null,
  currentUserAvatarUrl: string | null,
): LobbySnapshot | null {
  if (!lobby || !action || !currentUserId) return lobby
  if (Date.now() > action.expiresAt || lobby.status !== 'open') return lobby

  const entries = [...lobby.entries]

  const movePlayer = (playerId: string, targetSlot: number): boolean => {
    if (targetSlot < 0 || targetSlot >= entries.length) return false

    const sourceSlot = entries.findIndex(entry => entry?.playerId === playerId)
    if (sourceSlot === targetSlot) return false
    const targetEntry = entries[targetSlot]

    if (sourceSlot < 0) {
      if (targetEntry && targetEntry.playerId !== playerId) return false

      entries[targetSlot] = {
        playerId,
        displayName: typeof currentUserDisplayName === 'string' && currentUserDisplayName.trim().length > 0
          ? currentUserDisplayName
          : 'You',
        avatarUrl: currentUserAvatarUrl || null,
      }
      return true
    }

    const sourceEntry = entries[sourceSlot]
    if (!sourceEntry) return false

    entries[sourceSlot] = targetEntry ?? null
    entries[targetSlot] = sourceEntry
    return true
  }

  const removePlayer = (playerId: string): boolean => {
    const sourceSlot = entries.findIndex(entry => entry?.playerId === playerId)
    if (sourceSlot < 0) return false
    entries[sourceSlot] = null
    return true
  }

  const changed = (() => {
    switch (action.kind) {
      case 'place-self':
        return movePlayer(currentUserId, action.targetSlot)
      case 'remove-self':
        return removePlayer(currentUserId)
      case 'move-player':
        return movePlayer(action.playerId, action.targetSlot)
      case 'remove-player':
        return removePlayer(action.playerId)
      default:
        return false
    }
  })()

  if (!changed) return lobby

  let hasPlayerDiff = false
  for (let i = 0; i < entries.length; i++) {
    const before = lobby.entries[i]?.playerId ?? null
    const after = entries[i]?.playerId ?? null
    if (before !== after) {
      hasPlayerDiff = true
      break
    }
  }
  if (!hasPlayerDiff) return lobby

  return { ...lobby, entries }
}

export function resolvePendingJoinGhostSlot(
  lobby: LobbySnapshot | null,
  currentUserId: string | null,
  pendingJoinActive: boolean,
  joinEligibility: LobbyJoinEligibilitySnapshot | null | undefined,
  preferredSlot: number | null = null,
): number | null {
  if (!lobby || !currentUserId || !pendingJoinActive) return null
  if (!joinEligibility?.canJoin) return null
  if (lobby.entries.some(entry => entry?.playerId === currentUserId)) return null

  const pendingSlot = preferredSlot ?? joinEligibility.pendingSlot
  if (pendingSlot == null || !Number.isInteger(pendingSlot)) return null
  if (pendingSlot < 0 || pendingSlot >= lobby.entries.length) return null
  if (lobby.entries[pendingSlot] != null) return null
  return pendingSlot
}
