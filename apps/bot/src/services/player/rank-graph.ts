import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { RankedRoleConfig } from '../ranked/roles.ts'
import { playerRatingEvents, playerRatings, players as playerRows } from '@civup/db'
import { formatLeaderboardModeLabel } from '@civup/game'
import { displayRating, getLeaderboardMinGames, RANKED_ROLE_MIN_EFFECTIVE_GAMES, roleRating } from '@civup/rating'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import { and, desc, eq } from 'drizzle-orm'
import { avatarKey, loadAvatarDataUris } from '../image/avatar.ts'
import { getConfiguredRankedRoleLabel, getRankedRoleConfig } from '../ranked/roles.ts'

export const RANK_GRAPH_SCOPES = ['overall', 'duel', 'duo', 'squad', 'ffa'] as const
export type RankGraphScope = typeof RANK_GRAPH_SCOPES[number]

export interface RankGraphPoint {
  x: number
  rating: number
}

export interface RankGraphPlayer {
  playerId: string
  displayName: string
  avatarUrl: string | null
  points: RankGraphPoint[]
  currentRating: number | null
  games: number
}

export interface RankGraphBand {
  tier: CompetitiveTier
  label: string
  color: string
  cutoffScore: number | null
}

export interface RankGraphImageData {
  scope: RankGraphScope
  gameLimit: number
  player: RankGraphPlayer
  bands: RankGraphBand[]
}

interface RankGraphBandSegment {
  index: number
  label: string
  color: string
  cutoffScore: number | null
  y: number
  bottom: number
  height: number
}

interface RankGraphEventRow {
  matchId: string
  ratingBeforeMu: number
  ratingBeforeSigma: number
  ratingAfterMu: number
  ratingAfterSigma: number
  matchCreatedAt: number
}

interface RankGraphScoreRow {
  playerId: string
  score: number
  lastPlayedAt: number | null
  qualified: boolean
}

interface RankGraphTierThreshold {
  tier: CompetitiveTier
  earnPercent: number
  minimumCountWhenUnlocked: number
}

const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 630
const SIDE_PAD = 52
const HEADER_HEIGHT = 100
const CHART_X = 84
const CHART_Y = 120
const CHART_W = 1050
const CHART_H = 456
const CHART_BOTTOM = CHART_Y + CHART_H
const FONT_ASSET_SPECIFIERS = [
  '@fontsource/inter/files/inter-latin-400-normal.woff2',
  '@fontsource/inter/files/inter-latin-700-normal.woff2',
  '@fontsource/inter/files/inter-latin-900-normal.woff2',
] as const

const COLORS = {
  bg: '#09090b',
  panel: '#151518',
  panelAlt: '#1f1f24',
  border: 'rgba(255,255,255,0.18)',
  borderSubtle: 'rgba(255,255,255,0.08)',
  grid: 'rgba(255,255,255,0.10)',
  fg: '#fafafa',
  muted: '#a1a1aa',
  subtle: '#71717a',
  accent: '#c8aa6e',
  accentDim: 'rgba(200,170,110,0.14)',
}

const BAND_FALLBACK_COLORS = ['#f5c542', '#d4d4d8', '#c08457', '#22c55e', '#71717a', '#52525b'] as const
const MODE_RANK_GRAPH_BAND_MIN_GAMES = 10
const RANK_GRAPH_EARN_CUMULATIVE_PERCENT_ANCHORS = [0.05, 0.20, 0.40, 0.90] as const

let wasmReady: Promise<unknown> | null = null
let fontBuffersReady: Promise<Uint8Array[]> | null = null

export function parseRankGraphScope(value: string | null | undefined): RankGraphScope | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  return RANK_GRAPH_SCOPES.includes(normalized as RankGraphScope) ? normalized as RankGraphScope : null
}

export async function buildRankGraphImageData(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  options: {
    scope?: RankGraphScope
    gameLimit: number
  },
): Promise<RankGraphImageData> {
  const scope = options.scope ?? 'overall'
  const gameLimit = normalizeGameLimit(options.gameLimit)
  const [profile, eventRows, bands] = await Promise.all([
    loadPlayerProfile(db, playerId),
    loadRankGraphEvents(db, playerId, scope, gameLimit),
    loadRankGraphBands(db, kv, guildId, scope),
  ])
  const points = buildRankGraphPoints(eventRows, scope)

  return {
    scope,
    gameLimit,
    bands,
    player: {
      playerId,
      displayName: profile?.displayName?.trim() || shortPlayerLabel(playerId),
      avatarUrl: profile?.avatarUrl ?? null,
      points,
      currentRating: points.at(-1)?.rating ?? null,
      games: Math.max(0, points.length - 1),
    },
  }
}

export async function renderRankGraphPng(data: RankGraphImageData): Promise<Uint8Array> {
  return renderSvgToPng(await renderRankGraphSvg(data))
}

export async function renderRankGraphSvg(data: RankGraphImageData): Promise<string> {
  const scale = buildRatingScale(data)
  const bandSegments = buildRankBandSegments(data.bands, scale)
  const xMax = Math.max(1, data.player.games)
  const xTicks = buildGameTicks(xMax)
  const title = 'Rank History'
  const subtitle = formatRankGraphSubtitle(data.scope)
  const subtitleX = SIDE_PAD + measurePlainTextWidth(title, 52, 900) + 24
  const hasGraph = data.player.points.length > 0
  const player = data.player
  const avatarData = await loadAvatarDataUris([player])
  const avatarDataUri = avatarData.get(avatarKey(player))

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" font-family="Inter, Arial, sans-serif">
  <defs>
    <filter id="rankGraphGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.5" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    ${renderRankBandClipDefs(bandSegments)}
    <clipPath id="rankGraphClip"><rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="22" /></clipPath>
    <clipPath id="rankGraphPlayerAvatar" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5" /></clipPath>
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="${COLORS.panel}" />
  <text x="${SIDE_PAD}" y="68" fill="${COLORS.fg}" font-size="52" font-weight="900" letter-spacing="1">${escapeXml(title)}</text>
  <text x="${subtitleX}" y="66" fill="${COLORS.muted}" font-size="19" font-weight="900" letter-spacing="1.6">${escapeXml(subtitle)}</text>
  ${renderPlayerIdentity(player, avatarDataUri)}
  <rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="22" fill="rgba(0,0,0,0.24)" />
  <g clip-path="url(#rankGraphClip)">
    ${renderRankBands(bandSegments)}
    ${hasGraph ? renderGraphArea(data.player.points, scale, xMax, bandSegments) : ''}
    ${renderXGridLines(xTicks, xMax)}
    ${hasGraph ? renderSeriesLine(data.player.points, scale, xMax, bandSegments) : ''}
  </g>
  <rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="22" fill="none" stroke="${COLORS.border}" stroke-width="2.5" />
  ${renderBandAxisLabels(bandSegments, scale)}
  ${renderXAxisLabels(xTicks, xMax)}
  ${hasGraph ? '' : renderEmptyState()}
</svg>`
}

async function loadRankGraphEvents(
  db: Database,
  playerId: string,
  scope: RankGraphScope,
  gameLimit: number,
): Promise<RankGraphEventRow[]> {
  const ratingScope = toRatingEventScope(scope)
  const rows = await db
    .select({
      matchId: playerRatingEvents.matchId,
      ratingBeforeMu: playerRatingEvents.ratingBeforeMu,
      ratingBeforeSigma: playerRatingEvents.ratingBeforeSigma,
      ratingAfterMu: playerRatingEvents.ratingAfterMu,
      ratingAfterSigma: playerRatingEvents.ratingAfterSigma,
      matchCreatedAt: playerRatingEvents.matchCreatedAt,
    })
    .from(playerRatingEvents)
    .where(and(
      eq(playerRatingEvents.playerId, playerId),
      eq(playerRatingEvents.mode, ratingScope),
    ))
    .orderBy(desc(playerRatingEvents.matchCreatedAt), desc(playerRatingEvents.matchId))
    .limit(gameLimit)

  return rows.reverse()
}

async function loadPlayerProfile(db: Database, playerId: string): Promise<{ displayName: string, avatarUrl: string | null } | null> {
  const [row] = await db
    .select({ displayName: playerRows.displayName, avatarUrl: playerRows.avatarUrl })
    .from(playerRows)
    .where(eq(playerRows.id, playerId))
    .limit(1)
  return row ?? null
}

async function loadRankGraphBands(db: Database, kv: KVNamespace, guildId: string, scope: RankGraphScope): Promise<RankGraphBand[]> {
  const [config, scores] = await Promise.all([
    getRankedRoleConfig(kv, guildId),
    scope === 'overall' ? loadOverallRankGraphScores(db) : loadModeRankGraphScores(db, scope),
  ])
  return buildRankGraphBands(config, scores)
}

async function loadModeRankGraphScores(db: Database, scope: Exclude<RankGraphScope, 'overall'>): Promise<RankGraphScoreRow[]> {
  const rows = await db
    .select({
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
      lastPlayedAt: playerRatings.lastPlayedAt,
    })
    .from(playerRatings)
    .where(eq(playerRatings.mode, scope))

  const leaderboardMinGames = getLeaderboardMinGames(scope)
  return rows
    .filter(row => row.gamesPlayed >= leaderboardMinGames)
    .map(row => ({
      playerId: row.playerId,
      score: displayRating(row.mu, row.sigma),
      lastPlayedAt: row.lastPlayedAt ?? null,
      qualified: row.gamesPlayed >= MODE_RANK_GRAPH_BAND_MIN_GAMES,
    }))
    .sort(compareRankGraphScoreRows)
}

async function loadOverallRankGraphScores(db: Database): Promise<RankGraphScoreRow[]> {
  const rows = await db
    .select({
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      effectiveGames: playerRatings.effectiveGames,
      lastPlayedAt: playerRatings.lastPlayedAt,
    })
    .from(playerRatings)
    .where(eq(playerRatings.mode, 'global'))

  return rows
    .filter(row => row.effectiveGames >= RANKED_ROLE_MIN_EFFECTIVE_GAMES)
    .map(row => ({
      playerId: row.playerId,
      score: roleRating(row.mu, row.sigma),
      lastPlayedAt: row.lastPlayedAt ?? null,
      qualified: true,
    }))
    .sort(compareRankGraphScoreRows)
}

function buildRankGraphBands(config: RankedRoleConfig, sortedScores: readonly RankGraphScoreRow[]): RankGraphBand[] {
  const cutoffByTier = buildRankGraphCutoffs(config, sortedScores)
  return config.tiers.map((_tier, index) => {
    const tier = `tier${index + 1}` as CompetitiveTier
    const fallback = index === config.tiers.length - 1
    return {
      tier,
      label: getConfiguredRankedRoleLabel(config, tier) ?? shortTierLabel(tier),
      color: getTierColor(config, tier, index),
      cutoffScore: fallback ? null : cutoffByTier.get(tier) ?? null,
    }
  })
}

function buildRankGraphCutoffs(config: RankedRoleConfig, sortedScores: readonly RankGraphScoreRow[]): Map<CompetitiveTier, number> {
  const cutoffByTier = new Map<CompetitiveTier, number>()
  const rankedCount = sortedScores.length
  let start = 0

  for (const threshold of buildRankGraphTierThresholds(config)) {
    let size = Math.round(rankedCount * threshold.earnPercent)
    if (threshold.minimumCountWhenUnlocked > 0) size = Math.max(threshold.minimumCountWhenUnlocked, size)
    size = Math.max(0, Math.min(size, rankedCount - start))

    const cutoff = findLastQualifiedScore(sortedScores, start, size)
    if (cutoff != null) cutoffByTier.set(threshold.tier, cutoff)
    start += size
  }

  return cutoffByTier
}

function findLastQualifiedScore(sortedScores: readonly RankGraphScoreRow[], start: number, size: number): number | null {
  for (let offset = size - 1; offset >= 0; offset--) {
    const row = sortedScores[start + offset]
    if (row?.qualified) return row.score
  }
  return null
}

function buildRankGraphTierThresholds(config: RankedRoleConfig): RankGraphTierThreshold[] {
  const prestigeTierCount = Math.max(0, config.tiers.length - 1)
  if (prestigeTierCount <= 0) return []

  let previousEarnPercent = 0
  return Array.from({ length: prestigeTierCount }, (_value, index) => {
    const progress = prestigeTierCount <= 1 ? 1 : index / (prestigeTierCount - 1)
    const cumulativeEarnPercent = interpolatePositiveAnchors(RANK_GRAPH_EARN_CUMULATIVE_PERCENT_ANCHORS, progress)
    const threshold: RankGraphTierThreshold = {
      tier: `tier${index + 1}` as CompetitiveTier,
      earnPercent: Math.max(0, cumulativeEarnPercent - previousEarnPercent),
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

function compareRankGraphScoreRows(left: RankGraphScoreRow, right: RankGraphScoreRow): number {
  if (right.score !== left.score) return right.score - left.score
  if ((right.lastPlayedAt ?? 0) !== (left.lastPlayedAt ?? 0)) return (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0)
  return left.playerId.localeCompare(right.playerId)
}

function buildRankGraphPoints(rows: readonly RankGraphEventRow[], scope: RankGraphScope): RankGraphPoint[] {
  const [first] = rows
  if (!first) return []

  const score = scope === 'overall' ? roleRating : displayRating
  const points: RankGraphPoint[] = [{
    x: 0,
    rating: Math.round(score(first.ratingBeforeMu, first.ratingBeforeSigma)),
  }]

  rows.forEach((row, index) => {
    points.push({
      x: index + 1,
      rating: Math.round(score(row.ratingAfterMu, row.ratingAfterSigma)),
    })
  })

  return points
}

function buildRankBandSegments(bands: readonly RankGraphBand[], scale: RatingScale): RankGraphBandSegment[] {
  const rankedBands = bands.length > 0 ? bands : [{ tier: 'tier1', label: '', color: COLORS.accent, cutoffScore: null }]
  let upper = scale.max
  const segments: RankGraphBandSegment[] = []

  for (let index = 0; index < rankedBands.length; index++) {
    const band = rankedBands[index]!
    const lower = band.cutoffScore == null ? scale.min : band.cutoffScore
    const boundedUpper = Math.max(scale.min, Math.min(scale.max, upper))
    const boundedLower = Math.max(scale.min, Math.min(scale.max, lower))
    if (boundedUpper > boundedLower) {
      const y = ratingToY(boundedUpper, scale)
      const bottom = ratingToY(boundedLower, scale)
      const height = Math.max(1, bottom - y)
      const color = normalizeSvgColor(band.color, BAND_FALLBACK_COLORS[index % BAND_FALLBACK_COLORS.length] ?? COLORS.accent)
      segments.push({
        index,
        label: band.label,
        color,
        cutoffScore: band.cutoffScore,
        y,
        bottom,
        height,
      })
    }
    upper = lower
  }

  return segments
}

function renderRankBandClipDefs(segments: readonly RankGraphBandSegment[]): string {
  return segments.map((segment) => {
    const y = Math.max(CHART_Y, segment.y - 0.5)
    const bottom = Math.min(CHART_BOTTOM, segment.bottom + 0.5)
    return `<clipPath id="${rankBandClipId(segment)}" clipPathUnits="userSpaceOnUse"><rect x="${CHART_X}" y="${y}" width="${CHART_W}" height="${Math.max(1, bottom - y)}" /></clipPath>`
  }).join('')
}

function renderRankBands(segments: readonly RankGraphBandSegment[]): string {
  return segments.map(segment => `
    <rect x="${CHART_X}" y="${segment.y}" width="${CHART_W}" height="${segment.height}" fill="${segment.color}" opacity="0.025" />
    <line x1="${CHART_X}" y1="${segment.y}" x2="${CHART_X + CHART_W}" y2="${segment.y}" stroke="${COLORS.grid}" stroke-width="1" />
    ${segment.label && segment.height >= 30 ? `<text x="${CHART_X + CHART_W - 18}" y="${Math.min(segment.bottom - 13, segment.y + 29)}" text-anchor="end" fill="${segment.color}" opacity="0.72" font-size="18" font-weight="900" letter-spacing="1.2">${escapeXml(formatBandLabel(segment.label))}</text>` : ''}
  `).join('')
}

function renderPlayerIdentity(player: RankGraphPlayer, avatarDataUri: string | undefined): string {
  const avatarSize = 46
  const avatarX = IMAGE_WIDTH - SIDE_PAD - avatarSize
  const avatarY = 24
  const nameX = avatarX - 14
  const name = truncateToWidth(stripUnsupportedEmoji(player.displayName), 360, 22, 900)
  const ratingLabel = player.currentRating != null ? `${player.currentRating} ELO` : 'UNRATED'
  const center = avatarSize / 2
  const initials = getInitials(stripUnsupportedEmoji(player.displayName))
  return `
    <circle cx="${avatarX + center}" cy="${avatarY + center}" r="${center}" fill="${COLORS.bg}" />
    ${avatarDataUri ? `<image href="${avatarDataUri}" x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" clip-path="url(#rankGraphPlayerAvatar)" preserveAspectRatio="xMidYMid slice" />` : ''}
    ${avatarDataUri ? '' : `<text x="${avatarX + center}" y="${avatarY + center + (avatarSize * 0.13)}" text-anchor="middle" fill="${COLORS.muted}" font-size="${Math.round(avatarSize * 0.36)}" font-weight="900">${escapeXml(initials)}</text>`}
    <text x="${nameX}" y="${avatarY + 18}" text-anchor="end" fill="${COLORS.fg}" font-size="22" font-weight="900">${escapeXml(name)}</text>
    <text x="${nameX}" y="${avatarY + 42}" text-anchor="end" fill="${COLORS.muted}" font-size="17" font-weight="900" letter-spacing="1.1">${ratingLabel}</text>
  `
}

function renderXGridLines(ticks: readonly number[], xMax: number): string {
  return ticks.map((tick) => {
    if (tick === 0 || tick === xMax) return ''
    const x = xToChart(tick, xMax)
    return `<line x1="${x}" y1="${CHART_Y}" x2="${x}" y2="${CHART_BOTTOM}" stroke="${COLORS.grid}" stroke-width="1" />`
  }).join('')
}

function renderGraphArea(points: readonly RankGraphPoint[], scale: RatingScale, xMax: number, segments: readonly RankGraphBandSegment[]): string {
  const chartPoints = points.map(point => ({ x: xToChart(point.x, xMax), y: ratingToY(point.rating, scale) }))
  const first = chartPoints[0]
  const last = chartPoints.at(-1)
  if (!first || !last) return ''

  const linePoints = chartPoints.map(point => `${point.x},${point.y}`).join(' ')
  const reversePoints = [...chartPoints].reverse().map(point => `${point.x},${point.y}`).join(' ')
  const topPath = `M${first.x},${CHART_Y} H${last.x} L${reversePoints} Z`
  const bottomPath = `M${linePoints} L${last.x},${CHART_BOTTOM} H${first.x} Z`

  return segments.map(segment => `
    <g clip-path="url(#${rankBandClipId(segment)})">
      <path d="${topPath}" fill="${segment.color}" opacity="0.018" />
      <path d="${bottomPath}" fill="${segment.color}" opacity="0.13" />
    </g>
  `).join('')
}

function renderSeriesLine(pointsInput: readonly RankGraphPoint[], scale: RatingScale, xMax: number, segments: readonly RankGraphBandSegment[]): string {
  const points = pointsInput
    .map(point => `${xToChart(point.x, xMax)},${ratingToY(point.rating, scale)}`)
    .join(' ')

  return segments.map(segment => `
    <g clip-path="url(#${rankBandClipId(segment)})">
      <polyline points="${points}" fill="none" stroke="${segment.color}" stroke-opacity="0.16" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" filter="url(#rankGraphGlow)" />
      <polyline points="${points}" fill="none" stroke="${segment.color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    </g>
  `).join('')
}

function rankBandClipId(segment: RankGraphBandSegment): string {
  return `rankGraphBandClip${segment.index}`
}

function renderBandAxisLabels(segments: readonly RankGraphBandSegment[], scale: RatingScale): string {
  const labels: string[] = []
  for (const segment of segments) {
    if (segment.cutoffScore == null) continue
    const y = ratingToY(segment.cutoffScore, scale) + 5
    if (y < CHART_Y + 10 || y > CHART_BOTTOM - 5) continue
    labels.push(`<text x="${CHART_X - 14}" y="${y}" text-anchor="end" fill="${segment.color}" opacity="0.9" font-size="16" font-weight="900">${Math.round(segment.cutoffScore)}</text>`)
  }
  return labels.join('')
}

function renderXAxisLabels(xTicks: readonly number[], xMax: number): string {
  return xTicks.map((tick) => {
    const x = xToChart(tick, xMax)
    return `<text x="${x}" y="${CHART_BOTTOM + 34}" text-anchor="middle" fill="${COLORS.subtle}" font-size="15" font-weight="900">${tick}</text>`
  }).join('')
}

function renderEmptyState(): string {
  return `<text x="${CHART_X + 34}" y="${CHART_Y + 72}" fill="${COLORS.muted}" font-size="30" font-weight="900">No ranked games in this view.</text>`
}

interface RatingScale {
  min: number
  max: number
}

function buildRatingScale(data: RankGraphImageData): RatingScale {
  const values = [
    ...data.player.points.map(point => point.rating),
    ...data.bands.flatMap(band => band.cutoffScore == null ? [] : [band.cutoffScore]),
  ].filter(value => Number.isFinite(value))

  if (values.length === 0) return { min: 800, max: 1200 }

  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const spread = Math.max(80, maxValue - minValue)
  const pad = Math.max(45, spread * 0.16)
  const min = Math.floor((minValue - pad) / 50) * 50
  const max = Math.ceil((maxValue + pad) / 50) * 50
  return min === max ? { min: min - 100, max: max + 100 } : { min, max }
}

function buildGameTicks(xMax: number): number[] {
  if (xMax <= 5) {
    const ticks: number[] = []
    for (let value = 0; value <= xMax; value++) ticks.push(value)
    return ticks
  }
  const step = pickGameTickStep(xMax)
  const ticks: number[] = [0]
  for (let value = step; value < xMax; value += step) ticks.push(value)
  const lastInteriorTick = ticks.at(-1)
  if (lastInteriorTick != null && lastInteriorTick > 0 && xMax - lastInteriorTick < step * 0.6) ticks.pop()
  ticks.push(xMax)
  return ticks
}

function pickGameTickStep(xMax: number): number {
  const desired = getGameTickDensity(xMax)
  let bestStep = 1
  let bestScore = Number.POSITIVE_INFINITY

  for (const step of buildGameTickStepCandidates(xMax)) {
    const labels = buildGameTickLabelsForStep(xMax, step)
    const count = labels.length
    const countPenalty = count < desired.min
      ? (desired.min - count) * 8
      : count > desired.max
        ? (count - desired.max) * 5
        : Math.abs(count - desired.target)
    const divisorBonus = xMax % step === 0 ? -1.6 : 0
    const niceBonus = isPreferredGameTickStep(step) ? -1 : 0
    const crowdPenalty = hasCrowdedEndTick(xMax, step) ? 3 : 0
    const score = countPenalty + divisorBonus + niceBonus + crowdPenalty
    if (score < bestScore || (score === bestScore && step > bestStep)) {
      bestScore = score
      bestStep = step
    }
  }

  return bestStep
}

function getGameTickDensity(xMax: number): { min: number, max: number, target: number } {
  if (xMax <= 15) return { min: 4, max: 6, target: 5 }
  if (xMax <= 60) return { min: 5, max: 8, target: 6 }
  if (xMax <= 120) return { min: 5, max: 8, target: 6 }
  return { min: 6, max: 11, target: 10 }
}

function buildGameTickStepCandidates(xMax: number): number[] {
  const candidates = new Set<number>()
  const bases = [1, 2, 3, 4, 5, 10, 15, 20, 25, 50]
  for (let multiplier = 1; multiplier <= xMax; multiplier *= 10) {
    for (const base of bases) {
      const step = base * multiplier
      if (step >= 1 && step <= xMax) candidates.add(step)
    }
  }
  for (let step = 1; step <= xMax; step++) {
    if (xMax % step === 0) candidates.add(step)
  }
  return [...candidates].sort((a, b) => a - b)
}

function buildGameTickLabelsForStep(xMax: number, step: number): number[] {
  const labels: number[] = [0]
  for (let value = step; value < xMax; value += step) labels.push(value)
  if (hasCrowdedEndTick(xMax, step)) labels.pop()
  labels.push(xMax)
  return labels
}

function hasCrowdedEndTick(xMax: number, step: number): boolean {
  const remainder = xMax % step
  return remainder > 0 && remainder < step * 0.6
}

function isPreferredGameTickStep(step: number): boolean {
  let normalized = step
  while (normalized >= 10 && normalized % 10 === 0) normalized /= 10
  return normalized === 1 || normalized === 2 || normalized === 5
}

function ratingToY(rating: number, scale: RatingScale): number {
  const ratio = (scale.max - rating) / Math.max(1, scale.max - scale.min)
  return CHART_Y + (Math.max(0, Math.min(1, ratio)) * CHART_H)
}

function xToChart(x: number, xMax: number): number {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, xMax)))
  return CHART_X + (ratio * CHART_W)
}

function formatRankGraphSubtitle(scope: RankGraphScope): string {
  return scope === 'overall' ? 'OVERALL' : formatLeaderboardModeLabel(scope, scope).toUpperCase()
}

function toRatingEventScope(scope: RankGraphScope): LeaderboardMode | 'global' {
  return scope === 'overall' ? 'global' : scope
}

function normalizeGameLimit(value: number): number {
  if (!Number.isFinite(value)) return 20
  return Math.max(1, Math.min(200, Math.round(value)))
}

function getTierColor(config: RankedRoleConfig, tier: CompetitiveTier, fallbackIndex: number): string {
  const index = getTierIndex(tier)
  const configured = index == null ? null : config.tiers[index]?.color
  return normalizeSvgColor(configured, BAND_FALLBACK_COLORS[fallbackIndex % BAND_FALLBACK_COLORS.length] ?? COLORS.accent)
}

function getTierIndex(tier: CompetitiveTier): number | null {
  const match = /^tier(\d+)$/i.exec(tier.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 1 ? Math.round(value) - 1 : null
}

function shortTierLabel(tier: CompetitiveTier): string {
  const index = getTierIndex(tier)
  return index == null ? tier.toUpperCase() : `R${index + 1}`
}

function formatBandLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return ''
  const roleMatch = /^role\s+(\d+)$/i.exec(trimmed)
  if (roleMatch) return `R${roleMatch[1]}`
  return trimmed.toUpperCase()
}

function shortPlayerLabel(playerId: string): string {
  return `Player ${playerId.slice(-4) || '?'}`
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2) || '?').toUpperCase()
}

function normalizeSvgColor(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? ''
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback
}

async function renderSvgToPng(svg: string): Promise<Uint8Array> {
  await ensureResvgReady()
  const fontBuffers = await ensureFontBuffersReady()
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: IMAGE_WIDTH },
    font: fontBuffers.length > 0
      ? { fontBuffers, defaultFontFamily: 'Inter', sansSerifFamily: 'Inter' }
      : { loadSystemFonts: true, defaultFontFamily: 'Arial', sansSerifFamily: 'Arial' },
  }).render().asPng()
}

async function ensureResvgReady(): Promise<unknown> {
  wasmReady ??= initializeResvgWasm()
  return wasmReady
}

async function initializeResvgWasm(): Promise<unknown> {
  try {
    return await initWasm(await resolveWasmInput(resvgWasm))
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('Already initialized')) return null
    throw error
  }
}

async function ensureFontBuffersReady(): Promise<Uint8Array[]> {
  fontBuffersReady ??= Promise.all(FONT_ASSET_SPECIFIERS.map(resolveFontAssetBytes))
    .then(values => values.filter((value): value is Uint8Array => value != null && value.length > 0))
  return fontBuffersReady
}

async function resolveFontAssetBytes(specifier: typeof FONT_ASSET_SPECIFIERS[number]): Promise<Uint8Array | null> {
  if (getBunFileApi()) return resolveAssetBytes(resolveImportAsset(specifier))

  const bundled = await resolveBundledFontAsset(specifier).catch(() => null)
  return resolveAssetBytes(bundled ?? resolveImportAsset(specifier))
}

async function resolveBundledFontAsset(specifier: typeof FONT_ASSET_SPECIFIERS[number]): Promise<string | URL | ArrayBuffer | Uint8Array> {
  switch (specifier) {
    case '@fontsource/inter/files/inter-latin-400-normal.woff2':
      return (await import('@fontsource/inter/files/inter-latin-400-normal.woff2')).default
    case '@fontsource/inter/files/inter-latin-700-normal.woff2':
      return (await import('@fontsource/inter/files/inter-latin-700-normal.woff2')).default
    case '@fontsource/inter/files/inter-latin-900-normal.woff2':
      return (await import('@fontsource/inter/files/inter-latin-900-normal.woff2')).default
  }
}

function resolveImportAsset(specifier: string): string | URL {
  const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string }
  if (typeof meta.resolve !== 'function') return specifier

  try {
    const resolved = meta.resolve(specifier)
    return /^(https?:|file:)/.test(resolved) ? new URL(resolved) : resolved
  }
  catch {
    return specifier
  }
}

async function resolveWasmInput(input: string | URL | WebAssembly.Module | ArrayBuffer): Promise<string | URL | WebAssembly.Module | ArrayBuffer> {
  if (typeof input !== 'string') return input
  if (/^(https?:|file:)/.test(input)) return input

  const bun = getBunFileApi()
  if (bun) return bun.file(input).arrayBuffer()
  return input
}

async function resolveAssetBytes(input: string | URL | ArrayBuffer | Uint8Array): Promise<Uint8Array | null> {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)

  const bun = getBunFileApi()
  if (bun) {
    try {
      return new Uint8Array(await bun.file(input).arrayBuffer())
    }
    catch {
      return null
    }
  }

  try {
    const response = await fetch(input)
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  }
  catch {
    return null
  }
}

function getBunFileApi(): { file: (path: string | URL) => { arrayBuffer: () => Promise<ArrayBuffer> } } | null {
  return (globalThis as typeof globalThis & { Bun?: { file: (path: string | URL) => { arrayBuffer: () => Promise<ArrayBuffer> } } }).Bun ?? null
}

function truncateToWidth(value: string, maxWidth: number, fontSize: number, fontWeight: number): string {
  if (measurePlainTextWidth(value, fontSize, fontWeight) <= maxWidth) return value

  const suffix = '...'
  const suffixWidth = measurePlainTextWidth(suffix, fontSize, fontWeight)
  let result = ''
  for (const char of value) {
    if (measurePlainTextWidth(result + char, fontSize, fontWeight) + suffixWidth > maxWidth) break
    result += char
  }
  return result.length > 0 ? `${result.trimEnd()}${suffix}` : suffix
}

function measurePlainTextWidth(value: string, fontSize: number, fontWeight: number): number {
  const weightFactor = fontWeight >= 800 ? 1.06 : 1
  let width = 0
  for (const char of value) width += getApproxCharWidth(char) * fontSize * weightFactor
  return width
}

function getApproxCharWidth(char: string): number {
  if (char === ' ') return 0.28
  if (/^[ilI1|!.,'`:;]$/.test(char)) return 0.28
  if (/^[mw@#%&]$/i.test(char)) return 0.88
  if (/^[A-Z]$/.test(char)) return 0.68
  if (/^\d$/.test(char)) return 0.56
  if (/^[a-z]$/.test(char)) return 0.53
  return 0.62
}

function stripUnsupportedEmoji(value: string): string {
  return value
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim() || value
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
