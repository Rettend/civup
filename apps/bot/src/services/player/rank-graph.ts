import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import type { RankedRoleConfig } from '../ranked/roles.ts'
import { playerRatingEvents, players as playerRows } from '@civup/db'
import { formatLeaderboardModeLabel } from '@civup/game'
import { displayRating, roleRating } from '@civup/rating'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { previewRankedRoles, summarizeRankedPreview } from '../ranked/role-sync.ts'
import { getConfiguredRankedRoleLabel } from '../ranked/roles.ts'

export const RANK_GRAPH_SCOPES = ['overall', 'duel', 'duo', 'squad', 'ffa'] as const
export type RankGraphScope = typeof RANK_GRAPH_SCOPES[number]

export interface RankGraphPoint {
  x: number
  rating: number
}

export interface RankGraphSeries {
  playerId: string
  displayName: string
  color: string
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
  series: RankGraphSeries[]
  bands: RankGraphBand[]
}

interface RankGraphEventRow {
  matchId: string
  ratingBeforeMu: number
  ratingBeforeSigma: number
  ratingAfterMu: number
  ratingAfterSigma: number
  matchCreatedAt: number
}

const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 630
const SIDE_PAD = 52
const TOP_PAD = 42
const CHART_X = 84
const CHART_Y = 122
const CHART_W = 1050
const CHART_H = 420
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
  border: 'rgba(255,255,255,0.15)',
  borderSubtle: 'rgba(255,255,255,0.08)',
  grid: 'rgba(255,255,255,0.10)',
  fg: '#fafafa',
  muted: '#a1a1aa',
  subtle: '#71717a',
  accent: '#c8aa6e',
}

const SERIES_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa'] as const
const BAND_FALLBACK_COLORS = ['#f5c542', '#d4d4d8', '#c08457', '#22c55e', '#71717a', '#52525b'] as const

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
  playerIds: readonly string[],
  options: {
    scope?: RankGraphScope
    gameLimit: number
  },
): Promise<RankGraphImageData> {
  const scope = options.scope ?? 'overall'
  const gameLimit = normalizeGameLimit(options.gameLimit)
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const [profiles, eventRowsByPlayerId, bands] = await Promise.all([
    loadPlayerProfiles(db, uniquePlayerIds),
    loadRankGraphEvents(db, uniquePlayerIds, scope, gameLimit),
    loadRankGraphBands(db, kv, guildId, scope),
  ])

  return {
    scope,
    gameLimit,
    bands,
    series: uniquePlayerIds.map((playerId, index) => {
      const points = buildRankGraphPoints(eventRowsByPlayerId.get(playerId) ?? [], scope)
      return {
        playerId,
        displayName: profiles.get(playerId)?.displayName?.trim() || shortPlayerLabel(playerId),
        color: SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0],
        points,
        currentRating: points.at(-1)?.rating ?? null,
        games: Math.max(0, points.length - 1),
      }
    }),
  }
}

export async function renderRankGraphPng(data: RankGraphImageData): Promise<Uint8Array> {
  return renderSvgToPng(await renderRankGraphSvg(data))
}

export async function renderRankGraphSvg(data: RankGraphImageData): Promise<string> {
  const scale = buildRatingScale(data)
  const ticks = buildRatingTicks(scale.min, scale.max)
  const xMax = Math.max(1, data.gameLimit)
  const activeSeries = data.series.filter(series => series.points.length > 0)
  const title = formatRankGraphTitle(data.scope)

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" font-family="Inter, Arial, sans-serif">
  <defs>
    <linearGradient id="rankGraphBg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${COLORS.panel}" />
      <stop offset="1" stop-color="${COLORS.panelAlt}" />
    </linearGradient>
    <filter id="rankGraphGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    <clipPath id="rankGraphClip"><rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="22" /></clipPath>
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#rankGraphBg)" />
  <circle cx="1115" cy="54" r="180" fill="${COLORS.accent}" opacity="0.08" />
  <text x="${SIDE_PAD}" y="${TOP_PAD + 35}" fill="${COLORS.fg}" font-size="46" font-weight="900" letter-spacing="1.1">${escapeXml(title)}</text>
  <text x="${IMAGE_WIDTH - SIDE_PAD}" y="${TOP_PAD + 31}" text-anchor="end" fill="${COLORS.muted}" font-size="20" font-weight="900" letter-spacing="1.7">LAST ${data.gameLimit} GAMES</text>
  <rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="22" fill="rgba(0,0,0,0.24)" />
  <g clip-path="url(#rankGraphClip)">
    ${renderRankBands(data.bands, scale)}
    ${renderGridLines(ticks, scale)}
    ${activeSeries.map(series => renderSeriesLine(series, scale, xMax)).join('')}
  </g>
  <rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="22" fill="none" stroke="${COLORS.border}" stroke-width="2" />
  ${renderAxisLabels(ticks, scale, xMax)}
  ${activeSeries.length > 0 ? renderLegend(activeSeries) : renderEmptyState()}
</svg>`
}

async function loadRankGraphEvents(
  db: Database,
  playerIds: readonly string[],
  scope: RankGraphScope,
  gameLimit: number,
): Promise<Map<string, RankGraphEventRow[]>> {
  const byPlayerId = new Map<string, RankGraphEventRow[]>()
  const ratingScope = toRatingEventScope(scope)
  await Promise.all(playerIds.map(async (playerId) => {
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

    byPlayerId.set(playerId, rows.reverse())
  }))
  return byPlayerId
}

async function loadPlayerProfiles(db: Database, playerIds: readonly string[]): Promise<Map<string, { displayName: string }>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  if (uniquePlayerIds.length === 0) return new Map()

  const rows = await db
    .select({ id: playerRows.id, displayName: playerRows.displayName })
    .from(playerRows)
    .where(inArray(playerRows.id, uniquePlayerIds))
  return new Map(rows.map(row => [row.id, { displayName: row.displayName }]))
}

async function loadRankGraphBands(db: Database, kv: KVNamespace, guildId: string, scope: RankGraphScope): Promise<RankGraphBand[]> {
  if (scope === 'overall') return loadOverallRankGraphBands(db, kv, guildId)

  const summary = await summarizeRankedPreview({ db, kv, guildId, mode: scope })
  const modeSummary = summary.modes.find(mode => mode.mode === scope)
  if (!modeSummary) return []

  return modeSummary.tiers.map((tier, index) => ({
    tier: tier.tier,
    label: getConfiguredRankedRoleLabel(summary.config, tier.tier) ?? shortTierLabel(tier.tier),
    color: getTierColor(summary.config, tier.tier, index),
    cutoffScore: tier.isFallback ? null : tier.cutoffScore,
  }))
}

async function loadOverallRankGraphBands(db: Database, kv: KVNamespace, guildId: string): Promise<RankGraphBand[]> {
  const preview = await previewRankedRoles({ db, kv, guildId, includePlayerIdentities: false })
  const cutoffByTier = new Map<CompetitiveTier, number>()

  for (const player of preview.playerPreviews) {
    if (!player.managed || player.globalScore == null) continue
    const tier = player.assignment.tier
    const current = cutoffByTier.get(tier)
    if (current == null || player.globalScore < current) cutoffByTier.set(tier, player.globalScore)
  }

  return preview.config.tiers.map((_tier, index) => {
    const tier = `tier${index + 1}` as CompetitiveTier
    const fallback = index === preview.config.tiers.length - 1
    return {
      tier,
      label: getConfiguredRankedRoleLabel(preview.config, tier) ?? shortTierLabel(tier),
      color: getTierColor(preview.config, tier, index),
      cutoffScore: fallback ? null : cutoffByTier.get(tier) ?? null,
    }
  })
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

function renderRankBands(bands: readonly RankGraphBand[], scale: RatingScale): string {
  const rankedBands = bands.length > 0 ? bands : [{ tier: 'tier1', label: '', color: COLORS.accent, cutoffScore: null }]
  let upper = scale.max
  let svg = ''

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
      svg += `
        <rect x="${CHART_X}" y="${y}" width="${CHART_W}" height="${height}" fill="${color}" opacity="0.105" />
        <rect x="${CHART_X}" y="${y}" width="${CHART_W}" height="${height}" fill="none" stroke="${color}" stroke-opacity="0.32" stroke-width="1.2" />
        ${band.label ? `<text x="${CHART_X + CHART_W - 18}" y="${Math.min(bottom - 13, y + 29)}" text-anchor="end" fill="${color}" opacity="0.74" font-size="16" font-weight="900" letter-spacing="1.2">${escapeXml(formatBandLabel(band.label))}</text>` : ''}
      `
    }
    upper = lower
  }

  return svg
}

function renderGridLines(ticks: readonly number[], scale: RatingScale): string {
  return ticks.map((tick) => {
    const y = ratingToY(tick, scale)
    return `<line x1="${CHART_X}" y1="${y}" x2="${CHART_X + CHART_W}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1" />`
  }).join('')
}

function renderSeriesLine(series: RankGraphSeries, scale: RatingScale, xMax: number): string {
  const points = series.points
    .map(point => `${xToChart(point.x, xMax)},${ratingToY(point.rating, scale)}`)
    .join(' ')
  const last = series.points.at(-1)
  const lastPoint = last ? { x: xToChart(last.x, xMax), y: ratingToY(last.rating, scale) } : null

  return `
    <polyline points="${points}" fill="none" stroke="${series.color}" stroke-opacity="0.24" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" filter="url(#rankGraphGlow)" />
    <polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" />
    ${lastPoint ? `<circle cx="${lastPoint.x}" cy="${lastPoint.y}" r="7" fill="${COLORS.bg}" stroke="${series.color}" stroke-width="4" />` : ''}
  `
}

function renderAxisLabels(ticks: readonly number[], scale: RatingScale, xMax: number): string {
  const yLabels = ticks.map((tick) => {
    const y = ratingToY(tick, scale) + 5
    return `<text x="${CHART_X - 14}" y="${y}" text-anchor="end" fill="${COLORS.subtle}" font-size="16" font-weight="900">${tick}</text>`
  }).join('')

  return `
    ${yLabels}
    <text x="${CHART_X}" y="${CHART_BOTTOM + 34}" text-anchor="middle" fill="${COLORS.subtle}" font-size="15" font-weight="900">0</text>
    <text x="${xToChart(xMax, xMax)}" y="${CHART_BOTTOM + 34}" text-anchor="middle" fill="${COLORS.subtle}" font-size="15" font-weight="900">${xMax}</text>
  `
}

function renderLegend(series: readonly RankGraphSeries[]): string {
  const rows = series.slice(0, 6)
  const columnWidth = 360
  const startX = SIDE_PAD
  const startY = 584

  return rows.map((item, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const x = startX + (column * columnWidth)
    const y = startY + (row * 30)
    const label = truncateToWidth(stripUnsupportedEmoji(item.displayName), 220, 19, 900)
    const rating = item.currentRating == null ? '' : `${item.currentRating}`
    return `
      <circle cx="${x}" cy="${y - 6}" r="6" fill="${item.color}" />
      <text x="${x + 16}" y="${y}" fill="${COLORS.fg}" font-size="19" font-weight="900">${escapeXml(label)}</text>
      <text x="${x + 278}" y="${y}" text-anchor="end" fill="${COLORS.muted}" font-size="18" font-weight="900">${rating}</text>
    `
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
    ...data.series.flatMap(series => series.points.map(point => point.rating)),
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

function buildRatingTicks(min: number, max: number): number[] {
  const spread = Math.max(1, max - min)
  const rawStep = spread / 4
  const step = rawStep <= 50 ? 50 : rawStep <= 100 ? 100 : rawStep <= 200 ? 200 : 250
  const first = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let value = first; value <= max; value += step) ticks.push(value)
  return ticks.length > 0 ? ticks : [min, max]
}

function ratingToY(rating: number, scale: RatingScale): number {
  const ratio = (scale.max - rating) / Math.max(1, scale.max - scale.min)
  return CHART_Y + (Math.max(0, Math.min(1, ratio)) * CHART_H)
}

function xToChart(x: number, xMax: number): number {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, xMax)))
  return CHART_X + (ratio * CHART_W)
}

function formatRankGraphTitle(scope: RankGraphScope): string {
  if (scope === 'overall') return 'Rank History'
  return `${formatLeaderboardModeLabel(scope, scope)} History`
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
  return truncateToWidth(trimmed.toUpperCase(), 92, 16, 900)
}

function shortPlayerLabel(playerId: string): string {
  return `Player ${playerId.slice(-4) || '?'}`
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
