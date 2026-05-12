import type { TournamentLeaderboardImageData, TournamentOpponentCardData, TournamentOpponentCardPlayer, TournamentResultImageData } from './index.ts'
import { getLeader } from '@civup/game'
import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff2'
import interBold from '@fontsource/inter/files/inter-latin-700-normal.woff2'
import interBlack from '@fontsource/inter/files/inter-latin-900-normal.woff2'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import { LEADER_EMOJI_IDS } from '../../constants/leader-emojis.ts'

const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 630
const COLORS = {
  bg: '#09090b',
  panel: '#161619',
  elevated: '#1f1f24',
  elevatedSoft: '#24242a',
  border: 'rgba(255,255,255,0.14)',
  borderSubtle: 'rgba(255,255,255,0.08)',
  fg: '#fafafa',
  muted: '#a1a1aa',
  subtle: '#71717a',
  accent: '#c8aa6e',
  accentDim: 'rgba(200,170,110,0.14)',
  win: '#0ac8b9',
  loss: '#ef4444',
}

interface AvatarPlayer {
  playerId: string | null
  displayName: string
  avatarUrl: string | null
}

let wasmReady: Promise<unknown> | null = null
let fontBuffersReady: Promise<Uint8Array[]> | null = null

export async function renderTournamentOpponentsPng(data: TournamentOpponentCardData): Promise<Uint8Array> {
  return renderSvgToPng(await renderTournamentOpponentsSvg(data))
}

export async function renderTournamentLeaderboardPng(data: TournamentLeaderboardImageData): Promise<Uint8Array> {
  return renderSvgToPng(await renderTournamentLeaderboardSvg(data))
}

export async function renderTournamentLeaderboardPngPages(data: TournamentLeaderboardImageData, pageCount = 3): Promise<Uint8Array[]> {
  const pages = splitLeaderboardPages(data, pageCount)
  const images: Uint8Array[] = []
  for (const page of pages) {
    images.push(await renderSvgToPng(await renderTournamentLeaderboardSvgPage(page.data, page.rankOffset, page.title)))
  }
  return images
}

export async function renderTournamentResultPng(data: TournamentResultImageData): Promise<Uint8Array> {
  return renderSvgToPng(await renderTournamentResultSvg(data))
}

export async function renderTournamentOpponentsSvg(data: TournamentOpponentCardData): Promise<string> {
  const players = collectOpponentPlayers(data)
  const avatarData = await loadAvatarData(players)
  return svgShell(
    data.tournamentName,
    data.pairing ? data.pairing.round.replace(/_/g, ' ').toUpperCase() : 'OPPONENTS',
    `${renderHeaderRule()}
    ${data.pairing ? renderTopCutOpponentCard(data, avatarData) : renderQualifierOpponentCard(data, avatarData)}`,
    players,
  )
}

export async function renderTournamentLeaderboardSvg(data: TournamentLeaderboardImageData): Promise<string> {
  return renderTournamentLeaderboardSvgPage(data, 0, 'STANDINGS')
}

async function renderTournamentLeaderboardSvgPage(data: TournamentLeaderboardImageData, rankOffset: number, title: string): Promise<string> {
  const players = data.standings.flatMap(row => row.playerId ? [{ playerId: row.playerId, displayName: row.displayName, avatarUrl: row.avatarUrl }] : [])
  const avatarData = await loadAvatarData(players)
  return leaderboardSvgShell(getLeaderboardImageHeight(data.standings.length), title, renderStandingRows(data, avatarData, rankOffset), players)
}

export async function renderTournamentResultSvg(data: TournamentResultImageData): Promise<string> {
  const players = data.players
  const avatarData = await loadAvatarData(players)
  const leaderIconData = await loadLeaderIconData(players)
  return resultSvgShell(data, renderResultRows(data, avatarData, leaderIconData), players)
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

function svgShell(title: string, kicker: string, body: string, players: AvatarPlayer[]): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" font-family="Inter, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#09090b" />
      <stop offset="1" stop-color="#17171b" />
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="0%" r="72%">
      <stop offset="0" stop-color="rgba(200,170,110,0.22)" />
      <stop offset="1" stop-color="rgba(200,170,110,0)" />
    </radialGradient>
    ${buildAvatarClipDefs(players)}
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#bg)" />
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#glow)" />
  <rect x="36" y="36" width="1128" height="558" rx="30" fill="${COLORS.panel}" stroke="${COLORS.border}" />
  <circle cx="82" cy="86" r="18" fill="${COLORS.accentDim}" stroke="${COLORS.accent}" />
  <text x="114" y="94" fill="${COLORS.fg}" font-size="28" font-weight="900">${escapeXml(title)}</text>
  <text x="76" y="124" fill="${COLORS.muted}" font-size="15" font-weight="800" letter-spacing="3">${escapeXml(kicker)}</text>
  ${body}
</svg>`
}

function renderHeaderRule(): string {
  return `<line x1="76" y1="142" x2="1124" y2="142" stroke="${COLORS.borderSubtle}" />`
}

function renderQualifierOpponentCard(data: TournamentOpponentCardData, avatarData: Map<string, string>): string {
  return `
    ${renderPlayerCard(data.player, 76, 172, 392, 332, 'YOU', avatarData.get(avatarKey(data.player)))}
    <rect x="504" y="172" width="620" height="332" rx="24" fill="${COLORS.elevated}" stroke="${COLORS.borderSubtle}" />
    <text x="540" y="220" fill="${COLORS.fg}" font-size="25" font-weight="900">Recommended opponents</text>
    <text x="540" y="247" fill="${COLORS.muted}" font-size="15" font-weight="700">Prioritizes close records and fewer rematches.</text>
    ${data.opponents.length > 0
      ? data.opponents.slice(0, 4).map((player, index) => renderOpponentRow(player, index, avatarData.get(avatarKey(player)))).join('')
      : `<text x="540" y="342" fill="${COLORS.muted}" font-size="24" font-weight="800">No linked opponents available</text>`}
  `
}

function renderTopCutOpponentCard(data: TournamentOpponentCardData, avatarData: Map<string, string>): string {
  const pairing = data.pairing
  if (!pairing) return renderQualifierOpponentCard(data, avatarData)
  return `
    ${renderPlayerCard(pairing.playerOne, 76, 186, 420, 318, `SEED ${pairing.seedOne}`, avatarData.get(avatarKey(pairing.playerOne)))}
    <circle cx="600" cy="332" r="45" fill="${COLORS.accentDim}" stroke="${COLORS.accent}" />
    <text x="600" y="344" text-anchor="middle" fill="${COLORS.accent}" font-size="31" font-weight="900">VS</text>
    ${renderPlayerCard(pairing.playerTwo, 704, 186, 420, 318, `SEED ${pairing.seedTwo}`, avatarData.get(avatarKey(pairing.playerTwo)))}
  `
}

function renderPlayerCard(player: TournamentOpponentCardPlayer, x: number, y: number, width: number, height: number, tag: string, avatarDataUri?: string): string {
  const avatarId = avatarClipId(player)
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="${COLORS.elevated}" stroke="${COLORS.borderSubtle}" />
    <rect x="${x + 28}" y="${y + 26}" width="116" height="32" rx="16" fill="${COLORS.accentDim}" />
    <text x="${x + 86}" y="${y + 48}" text-anchor="middle" fill="${COLORS.accent}" font-size="14" font-weight="900" letter-spacing="1.6">${escapeXml(tag)}</text>
    ${renderAvatar(player, x + 32, y + 86, 96, avatarId, avatarDataUri)}
    <text x="${x + 152}" y="${y + 124}" fill="${COLORS.fg}" font-size="30" font-weight="900">${escapeXml(truncate(player.displayName, 17))}</text>
    <text x="${x + 152}" y="${y + 154}" fill="${COLORS.muted}" font-size="17" font-weight="700">${escapeXml(formatSeed(player.seed))}</text>
    ${renderMetric(x + 32, y + 228, 'WINS', String(player.wins))}
    ${renderMetric(x + 150, y + 228, 'LOSSES', String(player.losses))}
    ${renderMetric(x + 268, y + 228, 'WIN %', `${Math.round(player.winRate * 100)}%`)}
  `
}

function renderOpponentRow(player: TournamentOpponentCardPlayer, index: number, avatarDataUri?: string): string {
  const y = 300 + (index * 58)
  const note = player.note ?? `${player.games} games`
  const avatarId = avatarClipId(player)
  return `
    <rect x="540" y="${y - 35}" width="548" height="48" rx="17" fill="rgba(255,255,255,0.04)" stroke="${COLORS.borderSubtle}" />
    ${renderAvatar(player, 556, y - 27, 32, avatarId, avatarDataUri)}
    <text x="604" y="${y - 8}" fill="${COLORS.fg}" font-size="18" font-weight="900">${escapeXml(truncate(player.displayName, 22))}</text>
    <text x="604" y="${y + 10}" fill="${COLORS.muted}" font-size="12" font-weight="700">${escapeXml(note)}</text>
    <text x="1010" y="${y - 6}" text-anchor="end" fill="${COLORS.fg}" font-size="18" font-weight="900">${player.wins}-${player.losses}</text>
    <text x="1066" y="${y - 6}" text-anchor="end" fill="${COLORS.accent}" font-size="17" font-weight="900">${Math.round(player.winRate * 100)}%</text>
  `
}

function renderMetric(x: number, y: number, label: string, value: string): string {
  return `
    <rect x="${x}" y="${y}" width="94" height="64" rx="18" fill="rgba(255,255,255,0.04)" stroke="${COLORS.borderSubtle}" />
    <text x="${x + 47}" y="${y + 25}" text-anchor="middle" fill="${COLORS.muted}" font-size="12" font-weight="900" letter-spacing="1.1">${label}</text>
    <text x="${x + 47}" y="${y + 51}" text-anchor="middle" fill="${COLORS.fg}" font-size="24" font-weight="900">${value}</text>
  `
}

const LEADERBOARD_START_Y = 154
const LEADERBOARD_ROW_HEIGHT = 54
const LEADERBOARD_ROW_STEP = 62
const LEADERBOARD_COLUMN_GAP = 34
const LEADERBOARD_COLUMN_WIDTH = (IMAGE_WIDTH - 128 - LEADERBOARD_COLUMN_GAP) / 2

function splitLeaderboardPages(data: TournamentLeaderboardImageData, pageCount: number): Array<{ data: TournamentLeaderboardImageData, rankOffset: number, title: string }> {
  if (data.standings.length === 0) return [{ data, rankOffset: 0, title: 'STANDINGS' }]

  const normalizedPageCount = Math.max(1, Math.floor(pageCount))
  const pageSize = Math.ceil(data.standings.length / normalizedPageCount)
  const pages: Array<{ data: TournamentLeaderboardImageData, rankOffset: number, title: string }> = []
  for (let offset = 0; offset < data.standings.length; offset += pageSize) {
    const pageStandings = data.standings.slice(offset, offset + pageSize)
    pages.push({
      data: { ...data, standings: pageStandings },
      rankOffset: offset,
      title: `STANDINGS ${offset + 1}-${offset + pageStandings.length}`,
    })
  }
  return pages
}

function leaderboardSvgShell(height: number, title: string, body: string, players: AvatarPlayer[]): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}" viewBox="0 0 ${IMAGE_WIDTH} ${height}" font-family="Inter, Arial, sans-serif">
  <defs>
    <linearGradient id="leaderboardBg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${COLORS.panel}" />
      <stop offset="1" stop-color="${COLORS.elevated}" />
    </linearGradient>
    ${buildAvatarClipDefs(players)}
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${height}" fill="url(#leaderboardBg)" />
  <text x="64" y="88" fill="${COLORS.fg}" font-size="52" font-weight="900" letter-spacing="1">${escapeXml(title)}</text>
  <line x1="64" y1="124" x2="1136" y2="124" stroke="${COLORS.border}" stroke-width="2" />
  ${body}
</svg>`
}

function getLeaderboardImageHeight(playerCount: number): number {
  const rowCount = Math.ceil(Math.max(1, playerCount) / 2)
  return Math.max(IMAGE_HEIGHT, LEADERBOARD_START_Y + ((rowCount - 1) * LEADERBOARD_ROW_STEP) + LEADERBOARD_ROW_HEIGHT + 64)
}

function renderStandingRows(data: TournamentLeaderboardImageData, avatarData: Map<string, string>, rankOffset: number): string {
  if (data.standings.length === 0) {
    return `<text x="64" y="220" fill="${COLORS.muted}" font-size="34" font-weight="900">No standings yet</text>`
  }

  return data.standings.map((row, index) => {
    const rank = rankOffset + index + 1
    const column = index % 2
    const rowIndex = Math.floor(index / 2)
    const x = 64 + (column * (LEADERBOARD_COLUMN_WIDTH + LEADERBOARD_COLUMN_GAP))
    const y = LEADERBOARD_START_Y + (rowIndex * LEADERBOARD_ROW_STEP)
    const player = { playerId: row.playerId, displayName: row.displayName, avatarUrl: row.avatarUrl }
    const topCutEligible = rank <= 8 && row.eligible
    const rankColor = topCutEligible ? COLORS.accent : COLORS.muted
    const fill = topCutEligible
      ? 'rgba(200,170,110,0.13)'
      : rowIndex % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.025)'
    return `
      <rect x="${x}" y="${y}" width="${LEADERBOARD_COLUMN_WIDTH}" height="${LEADERBOARD_ROW_HEIGHT}" rx="16" fill="${fill}" />
      <text x="${x + 44}" y="${y + 36}" text-anchor="middle" fill="${rankColor}" font-size="28" font-weight="900">#${rank}</text>
      ${renderAvatar(player, x + 80, y + 8, 38, avatarClipId(player), avatarData.get(avatarKey(player)), rankColor, false)}
      <text x="${x + 134}" y="${y + 35}" fill="${COLORS.fg}" font-size="26" font-weight="900">${escapeXml(truncate(row.displayName, 15))}</text>
      <text x="${x + LEADERBOARD_COLUMN_WIDTH - 112}" y="${y + 35}" text-anchor="end" fill="${COLORS.fg}" font-size="24" font-weight="900">${row.wins}-${row.losses}</text>
      <text x="${x + LEADERBOARD_COLUMN_WIDTH - 24}" y="${y + 35}" text-anchor="end" fill="${topCutEligible ? COLORS.accent : COLORS.muted}" font-size="24" font-weight="900">${Math.round(row.winRate * 100)}%</text>
    `
  }).join('')
}

function resultSvgShell(data: TournamentResultImageData, body: string, players: AvatarPlayer[]): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" font-family="Inter, Arial, sans-serif">
  <defs>
    <linearGradient id="resultBg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${COLORS.panel}" />
      <stop offset="1" stop-color="${COLORS.elevated}" />
    </linearGradient>
    <linearGradient id="winGlow" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0.55" stop-color="rgba(10,200,185,0)" />
      <stop offset="1" stop-color="rgba(10,200,185,0.14)" />
    </linearGradient>
    <linearGradient id="lossGlow" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0.55" stop-color="rgba(239,68,68,0)" />
      <stop offset="1" stop-color="rgba(239,68,68,0.12)" />
    </linearGradient>
    ${buildAvatarClipDefs(players)}
  </defs>
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#resultBg)" />
  <text x="64" y="88" fill="${COLORS.fg}" font-size="52" font-weight="900" letter-spacing="1">RESULT REPORTED</text>
  <text x="1136" y="84" text-anchor="end" fill="${COLORS.accent}" font-size="38" font-weight="900">${escapeXml(formatStageTitle(data.stage))}</text>
  <line x1="64" y1="124" x2="1136" y2="124" stroke="${COLORS.border}" stroke-width="2" />
  ${body}
</svg>`
}

function renderResultRows(data: TournamentResultImageData, avatarData: Map<string, string>, leaderIconData: Map<string, string>): string {
  const ordered = [...data.players].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99))
  const rowX = 64
  const rowW = 1102
  const rowH = 178
  const chevron = 30
  return ordered.map((player, index) => {
    const y = index === 0 ? 166 : 386
    const isWinner = player.placement === 1
    const label = isWinner ? 'WIN' : 'LOSS'
    const color = isWinner ? COLORS.win : COLORS.loss
    const avatarId = avatarClipId(player)
    const leaderIcon = player.civId ? leaderIconData.get(player.civId) : null
    const rowPath = chevronRect(rowX, y, rowW, rowH, chevron)
    return `
      <path d="${rowPath}" fill="${isWinner ? 'rgba(10,200,185,0.06)' : 'rgba(239,68,68,0.05)'}" />
      <path d="${rowPath}" fill="url(#${isWinner ? 'winGlow' : 'lossGlow'})" />
      <rect x="${rowX}" y="${y}" width="5" height="${rowH}" fill="${color}" />
      ${renderAvatar(player, 96, y + 30, 118, avatarId, avatarData.get(avatarKey(player)), color)}
      <circle cx="210" cy="${y + 134}" r="42" fill="${COLORS.panel}" stroke="${COLORS.borderSubtle}" stroke-width="2" />
      ${leaderIcon ? `<image href="${leaderIcon}" x="170" y="${y + 94}" width="80" height="80" preserveAspectRatio="xMidYMid meet" />` : `<text x="210" y="${y + 148}" text-anchor="middle" fill="${COLORS.accent}" font-size="31" font-weight="900">${escapeXml(getLeaderInitials(player.civId))}</text>`}
      <text x="286" y="${y + 92}" fill="${COLORS.fg}" font-size="58" font-weight="900">${escapeXml(truncate(player.displayName, 16))}</text>
      <text x="288" y="${y + 140}" fill="${COLORS.muted}" font-size="31" font-weight="800">${escapeXml(formatLeader(player.civId))}</text>
      <text x="1018" y="${y + 100}" text-anchor="middle" fill="${COLORS.fg}" font-size="88" font-weight="900">#${player.placement ?? '?'}</text>
      <text x="1018" y="${y + 148}" text-anchor="middle" fill="${color}" font-size="38" font-weight="900" letter-spacing="2">${label}</text>
    `
  }).join('')
}

function chevronRect(x: number, y: number, w: number, h: number, d: number): string {
  return `M${x},${y} H${x + w - d} L${x + w},${y + h / 2} L${x + w - d},${y + h} H${x} Z`
}

function renderAvatar(player: AvatarPlayer, x: number, y: number, size: number, clipId: string, avatarDataUri?: string, strokeColor?: string, showStroke = true): string {
  const center = size / 2
  const stroke = strokeColor ?? COLORS.accent
  const initials = getInitials(player.displayName)
  return `
    <circle cx="${x + center}" cy="${y + center}" r="${center}" fill="${COLORS.bg}" />
    ${avatarDataUri ? `<image href="${avatarDataUri}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice" />` : ''}
    ${avatarDataUri ? '' : `<text x="${x + center}" y="${y + center + (size * 0.13)}" text-anchor="middle" fill="${stroke}" font-size="${Math.round(size * 0.34)}" font-weight="900">${escapeXml(initials)}</text>`}
    ${showStroke ? `<circle cx="${x + center}" cy="${y + center}" r="${center + 1}" fill="none" stroke="${stroke}" stroke-width="3" />` : ''}
  `
}

function collectOpponentPlayers(data: TournamentOpponentCardData): AvatarPlayer[] {
  const players: AvatarPlayer[] = [data.player, ...data.opponents]
  if (data.pairing) players.push(data.pairing.playerOne, data.pairing.playerTwo)
  return players
}

function buildAvatarClipDefs(players: AvatarPlayer[]): string {
  return [...new Map(players.map(player => [avatarClipId(player), player])).keys()]
    .map(id => `<clipPath id="${id}" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5" /></clipPath>`)
    .join('')
}

async function loadAvatarData(players: readonly AvatarPlayer[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  await Promise.all(players.map(async (player) => {
    const key = avatarKey(player)
    if (!key || !player.avatarUrl || result.has(key)) return
    const uri = await fetchAvatarDataUri(player.avatarUrl).catch(() => null)
    if (uri) result.set(key, uri)
  }))
  return result
}

async function loadLeaderIconData(players: readonly { civId: string | null }[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  await Promise.all(players.map(async (player) => {
    if (!player.civId || result.has(player.civId)) return
    const url = getLeaderEmojiUrl(player.civId)
    if (!url) return
    const uri = await fetchAvatarDataUri(url).catch(() => null)
    if (uri) result.set(player.civId, uri)
  }))
  return result
}

function getLeaderEmojiUrl(civId: string): string | null {
  const emojiId = LEADER_EMOJI_IDS[civId]
  return emojiId ? `https://cdn.discordapp.com/emojis/${emojiId}.png?size=128&quality=lossless` : null
}

async function fetchAvatarDataUri(url: string): Promise<string | null> {
  const response = await fetch(normalizeAvatarImageUrl(url))
  if (!response.ok) return null
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > 512_000) return null
  return `data:${contentType};base64,${base64Encode(bytes)}`
}

function normalizeAvatarImageUrl(url: string): string {
  return url.replace(/\.gif($|\?)/, '.png$1')
}

async function ensureResvgReady(): Promise<unknown> {
  wasmReady ??= initWasm(await resolveWasmInput(resvgWasm))
  return wasmReady
}

async function ensureFontBuffersReady(): Promise<Uint8Array[]> {
  fontBuffersReady ??= Promise.all([interRegular, interBold, interBlack].map(resolveAssetBytes))
    .then(values => values.filter((value): value is Uint8Array => value != null && value.length > 0))
  return fontBuffersReady
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
  return `avatar-${id.replace(/[^\w-]/g, '')}`
}

function avatarKey(player: AvatarPlayer): string {
  return player.playerId ?? player.displayName
}

function formatSeed(seed: number | null): string {
  return seed ? `Seed #${seed}` : 'Unseeded'
}

function formatLeader(civId: string | null): string {
  if (!civId) return 'Leader unknown'
  try {
    const leader = getLeader(civId)
    return leader.name
  }
  catch {
    return civId
  }
}

function getLeaderInitials(civId: string | null): string {
  if (!civId) return '?'
  try {
    return getInitials(getLeader(civId).name)
  }
  catch {
    return '?'
  }
}

function formatStageTitle(stage: string): string {
  const normalized = stage.replace(/_/g, ' ')
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)).toUpperCase()
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}...`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}
