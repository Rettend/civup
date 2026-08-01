import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { LeaderboardSnapshotRow } from './snapshot.ts'
import { players as playerRows } from '@civup/db'
import { formatLeaderboardModeLabel } from '@civup/game'
import { buildActivityAdjustedLeaderboard, getLeaderboardMinGames } from '@civup/rating'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import { inArray } from 'drizzle-orm'
import { avatarKey, loadAvatarDataUris } from '../image/avatar.ts'

const IMAGE_WIDTH = 1200
const ROW_LIMIT = 20
const SIDE_PAD = 40
const HEADER_HEIGHT = 112
const TABLE_HEADER_Y = 146
const ROW_START_Y = 166
const ROW_HEIGHT = 50
const ROW_STEP = 56
const BOTTOM_PAD = 40
const COLUMN_GAP = 24
const COLUMN_WIDTH = (IMAGE_WIDTH - (SIDE_PAD * 2) - COLUMN_GAP) / 2
const FONT_ASSET_SPECIFIERS = [
  '@fontsource/inter/files/inter-latin-400-normal.woff2',
  '@fontsource/inter/files/inter-latin-700-normal.woff2',
  '@fontsource/inter/files/inter-latin-900-normal.woff2',
] as const

const COLORS = {
  bg: '#09090b',
  panel: '#151518',
  panelAlt: '#1d1d22',
  border: 'rgba(255,255,255,0.13)',
  borderSubtle: 'rgba(255,255,255,0.07)',
  fg: '#fafafa',
  muted: '#a1a1aa',
  subtle: '#71717a',
  gold: '#f5c542',
  silver: '#d4d4d8',
  bronze: '#c08457',
}

const MODE_ACCENTS: Record<LeaderboardMode, string> = {
  'duel': '#ef4444',
  'duo': '#06b6d4',
  'squad': '#8b5cf6',
  'ffa': '#f59e0b',
  'red-death': '#dc2626',
}

interface AvatarPlayer {
  playerId: string | null
  displayName: string
  avatarUrl: string | null
}

export interface PlayerLeaderboardImageRow extends AvatarPlayer {
  rank: number
  rawRank: number
  inactivityOffset: number
  publicRating: number
  gamesPlayed: number
  wins: number
  winRate: number
}

export interface PlayerLeaderboardImageData {
  mode: LeaderboardMode
  titlePrefix?: string
  rows: PlayerLeaderboardImageRow[]
}

export interface PlayerLeaderboardImageDataOptions {
  titlePrefix?: string
  rowLimit?: number
  now?: number
}

export interface PlayerLeaderboardImageDataInput {
  mode: LeaderboardMode
  rows: readonly LeaderboardSnapshotRow[]
  options?: PlayerLeaderboardImageDataOptions
}

interface RenderPlayerLeaderboardOptions {
  avatarData?: Map<string, string>
}

let wasmReady: Promise<unknown> | null = null
let fontBuffersReady: Promise<Uint8Array[]> | null = null

export async function buildPlayerLeaderboardImageData(
  db: Database,
  mode: LeaderboardMode,
  rows: readonly LeaderboardSnapshotRow[],
  options: PlayerLeaderboardImageDataOptions = {},
): Promise<PlayerLeaderboardImageData> {
  const [data] = await buildPlayerLeaderboardImageDataBatch(db, [{ mode, rows, options }])
  return data ?? { mode, titlePrefix: options.titlePrefix, rows: [] }
}

export async function buildPlayerLeaderboardImageDataBatch(
  db: Database,
  inputs: readonly PlayerLeaderboardImageDataInput[],
): Promise<PlayerLeaderboardImageData[]> {
  const now = Date.now()
  const prepared = inputs.map((input) => {
    const limit = Math.max(0, Math.round(input.options?.rowLimit ?? ROW_LIMIT))
    return {
      input,
      entries: buildActivityAdjustedLeaderboard(input.rows, getLeaderboardMinGames(input.mode), input.options?.now ?? now).slice(0, limit),
    }
  })
  const profiles = await getLeaderboardPlayerProfiles(db, prepared.flatMap(item => item.entries.map(entry => entry.playerId)))

  return prepared.map(({ input, entries }) => ({
    mode: input.mode,
    titlePrefix: input.options?.titlePrefix,
    rows: entries.map((entry) => {
      const profile = profiles.get(entry.playerId)
      return {
        playerId: entry.playerId,
        displayName: profile?.displayName?.trim() || entry.playerId,
        avatarUrl: profile?.avatarUrl ?? null,
        rank: entry.rank,
        rawRank: entry.rawRank,
        inactivityOffset: entry.inactivityOffset,
        publicRating: entry.publicRating,
        gamesPlayed: entry.gamesPlayed,
        wins: entry.wins,
        winRate: entry.winRate,
      }
    }),
  }))
}

export async function renderPlayerLeaderboardPng(data: PlayerLeaderboardImageData, options: RenderPlayerLeaderboardOptions = {}): Promise<Uint8Array> {
  return renderSvgToPng(await renderPlayerLeaderboardSvg(data, options))
}

export async function renderPlayerLeaderboardSvg(data: PlayerLeaderboardImageData, options: RenderPlayerLeaderboardOptions = {}): Promise<string> {
  const avatarData = options.avatarData ?? await loadAvatarDataUris(data.rows)
  const height = getImageHeight(data.rows.length)
  const accent = MODE_ACCENTS[data.mode]
  const title = formatLeaderboardTitle(data.mode, data.titlePrefix)

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}" viewBox="0 0 ${IMAGE_WIDTH} ${height}" font-family="Inter, Arial, sans-serif">
  <defs>
    <linearGradient id="playerLeaderboardBg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${COLORS.panel}" />
      <stop offset="1" stop-color="${COLORS.panelAlt}" />
    </linearGradient>
    <linearGradient id="playerLeaderboardAccent" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.32" />
      <stop offset="1" stop-color="${accent}" stop-opacity="0" />
    </linearGradient>
    ${buildAvatarClipDefs(data.rows)}
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${height}" fill="url(#playerLeaderboardBg)" />
  <rect x="0" y="0" width="${IMAGE_WIDTH}" height="${HEADER_HEIGHT}" fill="url(#playerLeaderboardAccent)" />
  <text x="${SIDE_PAD}" y="76" fill="${COLORS.fg}" font-size="50" font-weight="900" letter-spacing="0.8">${escapeXml(title)}</text>
  <text x="${IMAGE_WIDTH - SIDE_PAD}" y="96" text-anchor="end" fill="${COLORS.muted}" font-size="15" font-weight="700">↓N = activity placement adjustment</text>
  ${renderTableHeader(data.rows.length)}
  ${data.rows.length > 0 ? renderRows(data.rows, avatarData, accent) : renderEmptyState()}
</svg>`
}

async function getLeaderboardPlayerProfiles(db: Database, playerIds: readonly string[]): Promise<Map<string, { displayName: string, avatarUrl: string | null }>> {
  const ids = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({ id: playerRows.id, displayName: playerRows.displayName, avatarUrl: playerRows.avatarUrl })
    .from(playerRows)
    .where(inArray(playerRows.id, ids))
  return new Map(rows.map(row => [row.id, { displayName: row.displayName, avatarUrl: row.avatarUrl }]))
}

function renderTableHeader(rowCount: number): string {
  const columns = rowCount > Math.ceil(rowCount / 2) ? [0, 1] : [0]
  return columns.map((column) => {
    const x = SIDE_PAD + (column * (COLUMN_WIDTH + COLUMN_GAP))
    const positions = getColumnTextPositions(x)
    return `
      <text x="${positions.nameX}" y="${TABLE_HEADER_Y}" fill="${COLORS.subtle}" font-size="15" font-weight="900" letter-spacing="1.4">PLAYER</text>
      <text x="${positions.ratingX}" y="${TABLE_HEADER_Y}" text-anchor="end" fill="${COLORS.subtle}" font-size="15" font-weight="900" letter-spacing="1.4">ELO</text>
      <text x="${positions.gamesX}" y="${TABLE_HEADER_Y}" text-anchor="end" fill="${COLORS.subtle}" font-size="15" font-weight="900" letter-spacing="1.4">GAMES</text>
      <text x="${positions.winRateX}" y="${TABLE_HEADER_Y}" text-anchor="end" fill="${COLORS.subtle}" font-size="15" font-weight="900" letter-spacing="1.4">WIN%</text>
    `
  }).join('')
}

function renderRows(rows: readonly PlayerLeaderboardImageRow[], avatarData: Map<string, string>, accent: string): string {
  const rowCountPerColumn = Math.ceil(rows.length / 2)
  return rows.map((row, index) => {
    const column = index >= rowCountPerColumn ? 1 : 0
    const rowIndex = index % rowCountPerColumn
    const x = SIDE_PAD + (column * (COLUMN_WIDTH + COLUMN_GAP))
    const y = ROW_START_Y + (rowIndex * ROW_STEP)
    const positions = getColumnTextPositions(x)
    const rankColor = getRankColor(row.rank, accent)
    const rowFill = row.rank <= 3
      ? `${rankColor}22`
      : index % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.025)'
    const name = stripUnsupportedEmoji(row.displayName)
    return `
      <rect x="${x}" y="${y}" width="${COLUMN_WIDTH}" height="${ROW_HEIGHT}" rx="15" fill="${rowFill}" />
      <rect x="${x}" y="${y}" width="${COLUMN_WIDTH}" height="${ROW_HEIGHT}" rx="15" fill="none" stroke="${row.rank <= 3 ? rankColor : COLORS.borderSubtle}" stroke-width="1" />
      <text x="${x + (row.inactivityOffset > 0 ? 28 : 36)}" y="${y + 33}" text-anchor="middle" fill="${row.rank <= 3 ? rankColor : COLORS.muted}" font-size="23" font-weight="900">#${row.rank}</text>
      ${row.inactivityOffset > 0 ? `<text x="${x + 52}" y="${y + 19}" text-anchor="middle" fill="${COLORS.muted}" font-size="13" font-weight="900">↓${row.inactivityOffset}</text>` : ''}
      ${renderAvatar(row, x + 68, y + 7, 36, avatarClipId(row), avatarData.get(avatarKey(row)))}
      ${renderText(name, positions.nameX, y + 33, positions.nameMaxWidth, 22, 900, COLORS.fg)}
      <text x="${positions.ratingX}" y="${y + 33}" text-anchor="end" fill="${COLORS.fg}" font-size="22" font-weight="900">${Math.round(row.publicRating)}</text>
      <text x="${positions.gamesX}" y="${y + 33}" text-anchor="end" fill="${COLORS.fg}" font-size="20" font-weight="800">${row.wins}/${row.gamesPlayed}</text>
      <text x="${positions.winRateX}" y="${y + 33}" text-anchor="end" fill="${COLORS.muted}" font-size="20" font-weight="900">${Math.round(row.winRate * 100)}%</text>
    `
  }).join('')
}

function renderEmptyState(): string {
  return `<text x="${SIDE_PAD}" y="236" fill="${COLORS.muted}" font-size="32" font-weight="900">No players with enough games to rank yet.</text>`
}

function getImageHeight(rowCount: number): number {
  if (rowCount === 0) return 360
  const rowsPerColumn = Math.ceil(rowCount / 2)
  return Math.max(rowCount <= 2 ? 360 : 630, ROW_START_Y + ((rowsPerColumn - 1) * ROW_STEP) + ROW_HEIGHT + BOTTOM_PAD)
}

function getColumnTextPositions(columnX: number): { nameX: number, ratingX: number, gamesX: number, winRateX: number, nameMaxWidth: number } {
  const nameX = columnX + 116
  const ratingX = columnX + COLUMN_WIDTH - 174
  const gamesX = columnX + COLUMN_WIDTH - 84
  const winRateX = columnX + COLUMN_WIDTH - 16
  return {
    nameX,
    ratingX,
    gamesX,
    winRateX,
    nameMaxWidth: Math.max(80, Math.min(200, ratingX - nameX - 24)),
  }
}

function getRankColor(rank: number, accent: string): string {
  if (rank === 1) return COLORS.gold
  if (rank === 2) return COLORS.silver
  if (rank === 3) return COLORS.bronze
  return accent
}

function renderAvatar(player: AvatarPlayer, x: number, y: number, size: number, clipId: string, avatarDataUri: string | undefined): string {
  const center = size / 2
  const initials = getInitials(stripUnsupportedEmoji(player.displayName))
  return `
    <circle cx="${x + center}" cy="${y + center}" r="${center}" fill="${COLORS.bg}" />
    ${avatarDataUri ? `<image href="${avatarDataUri}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice" />` : ''}
    ${avatarDataUri ? '' : `<text x="${x + center}" y="${y + center + (size * 0.13)}" text-anchor="middle" fill="${COLORS.muted}" font-size="${Math.round(size * 0.34)}" font-weight="900">${escapeXml(initials)}</text>`}
  `
}

function renderText(value: string, x: number, y: number, maxWidth: number, fontSize: number, fontWeight: number, fill: string): string {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${fontSize}" font-weight="${fontWeight}">${escapeXml(truncateToWidth(value, maxWidth, fontSize, fontWeight))}</text>`
}

function buildAvatarClipDefs(players: readonly AvatarPlayer[]): string {
  return [...new Set(players.map(avatarClipId))]
    .map(id => `<clipPath id="${id}" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5" /></clipPath>`)
    .join('')
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

function avatarClipId(player: AvatarPlayer): string {
  const id = avatarKey(player) || player.displayName || 'player'
  return `player-avatar-${id.replace(/[^\w-]/g, '')}`
}

function formatLeaderboardTitle(mode: LeaderboardMode, titlePrefix?: string): string {
  const baseTitle = `${formatLeaderboardModeLabel(mode, mode)} Leaderboard`
  return titlePrefix ? `${titlePrefix} ${baseTitle}` : baseTitle
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2) || '?').toUpperCase()
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
