import type { TournamentLeaderboardImageData, TournamentOpponentCardData, TournamentOpponentCardPlayer, TournamentResultImageData } from './index.ts'
import { getLeader } from '@civup/game'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import { LEADER_EMOJI_IDS } from '../../constants/leader-emojis.ts'
import { TOURNAMENT_EMOJI_ICONS, type TournamentEmojiIcon } from '../../constants/tournament-emoji-icons.ts'
import { avatarKey, fetchDiscordImageDataUri, loadAvatarDataUris as loadAvatarData } from '../image/avatar.ts'

const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 630
const FONT_ASSET_SPECIFIERS = [
  '@fontsource/inter/files/inter-latin-400-normal.woff2',
  '@fontsource/inter/files/inter-latin-700-normal.woff2',
  '@fontsource/inter/files/inter-latin-900-normal.woff2',
] as const
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

type InlineTextSegment = { type: 'text', value: string } | { type: 'emoji', value: string, icon: TournamentEmojiIcon }
type TournamentBracketPairing = TournamentLeaderboardImageData['pairings'][number] & { projected?: boolean }

interface BracketAdvanceSlot {
  seed: number
  playerId: string | null
  displayName: string
  avatarUrl: string | null
}

let wasmReady: Promise<unknown> | null = null
let fontBuffersReady: Promise<Uint8Array[]> | null = null
let emojiSvgInstance = 0

export async function renderTournamentOpponentsPng(data: TournamentOpponentCardData): Promise<Uint8Array> {
  return renderSvgToPng(await renderTournamentOpponentsSvg(data))
}

export async function renderTournamentLeaderboardPng(data: TournamentLeaderboardImageData): Promise<Uint8Array> {
  return renderSvgToPng(await renderTournamentLeaderboardSvg(data))
}

export async function renderTournamentResultPng(data: TournamentResultImageData): Promise<Uint8Array> {
  return renderSvgToPng(await renderTournamentResultSvg(data))
}

export async function renderTournamentOpponentsSvg(data: TournamentOpponentCardData): Promise<string> {
  const players = collectOpponentPlayers(data)
  const avatarData = await loadAvatarData(players)
  return statsSvgShell(renderTournamentStatsBody(data, avatarData), players)
}

export async function renderTournamentLeaderboardSvg(data: TournamentLeaderboardImageData): Promise<string> {
  if (data.pairings.length > 0) return renderBracketLeaderboardSvg(data)
  const topRows = data.standings.slice(0, 20)
  const players = topRows.flatMap(row => row.playerId ? [{ playerId: row.playerId, displayName: row.displayName, avatarUrl: row.avatarUrl }] : [])
  const avatarData = await loadAvatarData(players)
  return leaderboardSvgShell(getLeaderboardImageHeight(topRows.length), 'STANDINGS', renderStandingRows(topRows, avatarData, 0), players, data.tournamentName)
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

const LEADERBOARD_START_Y = 154
const LEADERBOARD_ROW_HEIGHT = 54
const LEADERBOARD_ROW_STEP = 62
const LEADERBOARD_COLUMN_GAP = 34
const LEADERBOARD_COLUMN_WIDTH = (IMAGE_WIDTH - 128 - LEADERBOARD_COLUMN_GAP) / 2
const STATS_ROW_HEIGHT = 42
const STATS_ROW_STEP = 47

const BRACKET_MATCH_W = 300
const BRACKET_MATCH_H = 96
const BRACKET_SLOT_H = BRACKET_MATCH_H / 2
const BRACKET_MATCH_R = 12
const BRACKET_ROUND_GAP = 40
const BRACKET_MATCH_VERTICAL_GAP = 20
const BRACKET_START_Y = 186
const BRACKET_LEFT_PAD = 120
const BRACKET_BOTTOM_PAD = 64
const BRACKET_ROUND_ORDER = ['quarterfinal', 'semifinal', 'final'] as const

function leaderboardSvgShell(height: number, title: string, body: string, players: AvatarPlayer[], subtitle?: string): string {
  const subtitleText = subtitle?.trim()
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
  ${subtitleText ? `<text x="1136" y="84" text-anchor="end" fill="${COLORS.muted}" font-size="24" font-weight="900" letter-spacing="1">${escapeXml(truncateToWidth(subtitleText, 520, 24, 900))}</text>` : ''}
  <line x1="64" y1="124" x2="1136" y2="124" stroke="${COLORS.border}" stroke-width="2" />
  ${body}
</svg>`
}

function getLeaderboardImageHeight(playerCount: number): number {
  const rowCount = Math.ceil(Math.max(1, playerCount) / 2)
  return Math.max(IMAGE_HEIGHT, LEADERBOARD_START_Y + ((rowCount - 1) * LEADERBOARD_ROW_STEP) + LEADERBOARD_ROW_HEIGHT + 64)
}

function getBracketImageHeight(firstRoundCount: number): number {
  const totalMatchH = BRACKET_MATCH_H + BRACKET_MATCH_VERTICAL_GAP
  return Math.max(IMAGE_HEIGHT, BRACKET_START_Y + (firstRoundCount * totalMatchH) - BRACKET_MATCH_VERTICAL_GAP + BRACKET_BOTTOM_PAD)
}

async function renderBracketLeaderboardSvg(data: TournamentLeaderboardImageData): Promise<string> {
  const pairings = buildDisplayBracketPairings(data.pairings)
  const roundGroups = groupPairingsByRound(pairings)
  const firstRoundCount = roundGroups[0]?.pairings.length ?? 0
  const height = getBracketImageHeight(firstRoundCount)
  const players = collectBracketPlayers(pairings, data.champion)
  const avatarData = await loadAvatarData(players)
  const body = renderBracket(roundGroups, height, data.champion, avatarData)
  return leaderboardSvgShell(height, 'PLAYOFFS', body, players, data.tournamentName)
}

function collectBracketPlayers(pairings: TournamentBracketPairing[], champion: TournamentOpponentCardPlayer | null): AvatarPlayer[] {
  const players: AvatarPlayer[] = []
  for (const pairing of pairings) {
    if (pairing.playerOneId) {
      players.push({ playerId: pairing.playerOneId, displayName: pairing.playerOneDisplayName, avatarUrl: pairing.playerOneAvatarUrl })
    }
    if (pairing.playerTwoId) {
      players.push({ playerId: pairing.playerTwoId, displayName: pairing.playerTwoDisplayName, avatarUrl: pairing.playerTwoAvatarUrl })
    }
  }
  if (champion) players.push(champion)
  return [...new Map(players.map(player => [avatarKey(player), player])).values()]
}

interface BracketRoundGroup {
  round: string
  pairings: TournamentBracketPairing[]
}

function buildDisplayBracketPairings(pairings: TournamentBracketPairing[]): TournamentBracketPairing[] {
  const displayPairings = [...pairings]
  for (const round of BRACKET_ROUND_ORDER) {
    const nextRound = getNextBracketRound(round)
    if (!nextRound || displayPairings.some(pairing => pairing.round === nextRound)) continue

    const sourcePairings = displayPairings.filter(pairing => pairing.round === round)
    if (sourcePairings.length < 2) continue

    displayPairings.push(...projectNextBracketRound(sourcePairings, nextRound))
  }
  return displayPairings
}

function projectNextBracketRound(sourcePairings: TournamentBracketPairing[], nextRound: string): TournamentBracketPairing[] {
  const projected: TournamentBracketPairing[] = []
  let hasKnownWinner = false

  for (let index = 0; index < sourcePairings.length; index += 2) {
    const leftWinner = getBracketPairingWinnerSlot(sourcePairings[index]!)
    const rightSource = sourcePairings[index + 1]
    const rightWinner = rightSource ? getBracketPairingWinnerSlot(rightSource) : null
    if (leftWinner || rightWinner) hasKnownWinner = true

    projected.push({
      round: nextRound,
      seedOne: leftWinner?.seed ?? 0,
      seedTwo: rightWinner?.seed ?? 0,
      playerOneId: leftWinner?.playerId ?? null,
      playerTwoId: rightWinner?.playerId ?? null,
      playerOneDisplayName: leftWinner?.displayName ?? 'TBD',
      playerTwoDisplayName: rightWinner?.displayName ?? 'TBD',
      playerOneAvatarUrl: leftWinner?.avatarUrl ?? null,
      playerTwoAvatarUrl: rightWinner?.avatarUrl ?? null,
      playerOneScore: 0,
      playerTwoScore: 0,
      requiredWins: getBracketRoundRequiredWins(nextRound),
      winnerDisplayName: null,
      projected: true,
    })
  }

  return hasKnownWinner ? projected : []
}

function getBracketPairingWinnerSlot(pairing: TournamentBracketPairing): BracketAdvanceSlot | null {
  if (!pairing.winnerDisplayName) return null
  if (pairing.winnerDisplayName === pairing.playerOneDisplayName) {
    return { seed: pairing.seedOne, playerId: pairing.playerOneId, displayName: pairing.playerOneDisplayName, avatarUrl: pairing.playerOneAvatarUrl }
  }
  if (pairing.winnerDisplayName === pairing.playerTwoDisplayName) {
    return { seed: pairing.seedTwo, playerId: pairing.playerTwoId, displayName: pairing.playerTwoDisplayName, avatarUrl: pairing.playerTwoAvatarUrl }
  }
  return null
}

function getNextBracketRound(round: string): string | null {
  if (round === 'quarterfinal') return 'semifinal'
  if (round === 'semifinal') return 'final'
  return null
}

function getBracketRoundRequiredWins(round: string): number {
  return round === 'final' ? 3 : 2
}

function groupPairingsByRound(pairings: TournamentBracketPairing[]): BracketRoundGroup[] {
  const byRound = new Map<string, TournamentBracketPairing[]>()
  for (const pairing of pairings) {
    const existing = byRound.get(pairing.round) ?? []
    existing.push(pairing)
    byRound.set(pairing.round, existing)
  }
  const groups: BracketRoundGroup[] = []
  for (const round of BRACKET_ROUND_ORDER) {
    const roundPairings = byRound.get(round)
    if (roundPairings) groups.push({ round, pairings: roundPairings })
  }
  for (const [round, roundPairings] of byRound) {
    if (!BRACKET_ROUND_ORDER.includes(round as typeof BRACKET_ROUND_ORDER[number])) {
      groups.push({ round, pairings: roundPairings })
    }
  }
  return groups
}

function renderBracket(
  roundGroups: BracketRoundGroup[],
  imageHeight: number,
  champion: TournamentOpponentCardPlayer | null,
  avatarData: Map<string, string>,
): string {
  if (roundGroups.length === 0) return ''

  const totalRounds = roundGroups.length
  const availableW = IMAGE_WIDTH - BRACKET_LEFT_PAD - 64
  const roundW = Math.min(BRACKET_MATCH_W + BRACKET_ROUND_GAP, availableW / totalRounds)
  const matchW = roundW - BRACKET_ROUND_GAP
  const bracketH = imageHeight - BRACKET_START_Y - BRACKET_BOTTOM_PAD
  let svg = ''

  const matchCenters: number[][] = []

  for (let roundIndex = 0; roundIndex < roundGroups.length; roundIndex++) {
    const group = roundGroups[roundIndex]!
    const roundX = BRACKET_LEFT_PAD + (roundIndex * roundW)
    const roundLabel = formatBracketRoundLabel(group.round)
    svg += `<text x="${roundX + matchW / 2}" y="${BRACKET_START_Y - 18}" text-anchor="middle" fill="${COLORS.muted}" font-size="24" font-weight="900" letter-spacing="2">${escapeXml(roundLabel)}</text>`

    const matchCount = group.pairings.length
    const totalMatchBlockH = matchCount * BRACKET_MATCH_H + (matchCount - 1) * BRACKET_MATCH_VERTICAL_GAP
    const startY = BRACKET_START_Y + (bracketH - totalMatchBlockH) / 2
    const centers: number[] = []

    for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
      const pairing = group.pairings[matchIndex]!
      const matchY = startY + matchIndex * (BRACKET_MATCH_H + BRACKET_MATCH_VERTICAL_GAP)
      centers.push(matchY + BRACKET_MATCH_H / 2)
      svg += renderBracketMatch(pairing, roundX, matchY, matchW, BRACKET_MATCH_R, avatarData)
    }
    matchCenters.push(centers)
  }

  for (let roundIndex = 0; roundIndex < matchCenters.length - 1; roundIndex++) {
    const fromCenters = matchCenters[roundIndex]!
    const toCenters = matchCenters[roundIndex + 1]!
    const fromX = BRACKET_LEFT_PAD + (roundIndex * roundW) + matchW
    const toX = BRACKET_LEFT_PAD + ((roundIndex + 1) * roundW)
    const midX = (fromX + toX) / 2

    for (let i = 0; i < fromCenters.length; i += 2) {
      const topY = fromCenters[i]!
      const bottomY = fromCenters[i + 1]
      const targetIndex = Math.floor(i / 2)
      const targetY = toCenters[targetIndex]
      if (targetY == null) continue

      if (bottomY != null) {
        svg += `<path d="M${fromX + 4},${topY} H${midX} V${targetY} H${toX - 4}" fill="none" stroke="${COLORS.borderSubtle}" stroke-width="2" />`
        svg += `<path d="M${fromX + 4},${bottomY} H${midX} V${targetY}" fill="none" stroke="${COLORS.borderSubtle}" stroke-width="2" />`
      }
      else {
        svg += `<line x1="${fromX + 4}" y1="${topY}" x2="${toX - 4}" y2="${targetY}" stroke="${COLORS.borderSubtle}" stroke-width="2" />`
      }
    }
  }

  if (champion) {
    const lastRoundIndex = roundGroups.length - 1
    const lastX = BRACKET_LEFT_PAD + (lastRoundIndex * roundW)
    const lastCenters = matchCenters[lastRoundIndex]
    const finalCenterY = lastCenters?.[0] ?? BRACKET_START_Y + bracketH / 2
    const trophySize = 58
    const trophyX = lastX + (matchW / 2) - (trophySize / 2)
    const trophyY = Math.max(BRACKET_START_Y + 18, finalCenterY - (BRACKET_MATCH_H / 2) - trophySize - 18)
    svg += renderTrophyIcon(trophyX, trophyY, trophySize)
  }

  return svg
}

function renderTrophyIcon(x: number, y: number, size: number): string {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 256 256" overflow="visible"><g fill="${COLORS.accent}"><path d="M200 48v63.1c0 39.7-31.75 72.6-71.45 72.9A72 72 0 0 1 56 112V48Z" opacity=".24"/><path d="M232 64h-24V48a8 8 0 0 0-8-8H56a8 8 0 0 0-8 8v16H24A16 16 0 0 0 8 80v16a40 40 0 0 0 40 40h3.65A80.13 80.13 0 0 0 120 191.61V216H96a8 8 0 0 0 0 16h64a8 8 0 0 0 0-16h-24v-24.42c31.94-3.23 58.44-25.64 68.08-55.58H208a40 40 0 0 0 40-40V80a16 16 0 0 0-16-16M48 120a24 24 0 0 1-24-24V80h24v32q0 4 .39 8Zm144-8.9c0 35.52-29 64.64-64 64.9a64 64 0 0 1-64-64V56h128ZM232 96a24 24 0 0 1-24 24h-.5a81.81 81.81 0 0 0 .5-8.9V80h24Z"/></g></svg>`
}

function renderBracketMatch(
  pairing: TournamentBracketPairing,
  x: number,
  y: number,
  width: number,
  r: number,
  avatarData: Map<string, string>,
): string {
  const isDecided = pairing.winnerDisplayName != null
  const p1IsWinner = isDecided && pairing.winnerDisplayName === pairing.playerOneDisplayName
  const p2IsWinner = isDecided && pairing.winnerDisplayName === pairing.playerTwoDisplayName
  const showScores = pairing.projected !== true || (pairing.playerOneId != null && pairing.playerTwoId != null)

  let svg = `<rect x="${x}" y="${y}" width="${width}" height="${BRACKET_MATCH_H}" rx="${r}" fill="${COLORS.elevated}" />`
  svg += `<rect x="${x}" y="${y}" width="${width}" height="${BRACKET_MATCH_H}" rx="${r}" fill="none" stroke="${COLORS.borderSubtle}" stroke-width="1.5" />`
  svg += `<line x1="${x}" y1="${y + BRACKET_SLOT_H}" x2="${x + width}" y2="${y + BRACKET_SLOT_H}" stroke="${COLORS.borderSubtle}" stroke-width="1" />`

  svg += renderBracketSlot({
    seed: pairing.seedOne,
    playerId: pairing.playerOneId,
    displayName: pairing.playerOneDisplayName,
    avatarUrl: pairing.playerOneAvatarUrl,
    score: pairing.playerOneScore,
    showScore: showScores,
    isWinner: p1IsWinner,
    isLoser: isDecided && !p1IsWinner,
  }, x, y, width, r, 'top', avatarData)
  svg += renderBracketSlot({
    seed: pairing.seedTwo,
    playerId: pairing.playerTwoId,
    displayName: pairing.playerTwoDisplayName,
    avatarUrl: pairing.playerTwoAvatarUrl,
    score: pairing.playerTwoScore,
    showScore: showScores,
    isWinner: p2IsWinner,
    isLoser: isDecided && !p2IsWinner,
  }, x, y + BRACKET_SLOT_H, width, r, 'bottom', avatarData)

  return svg
}

function renderBracketSlot(
  slot: {
    seed: number
    playerId: string | null
    displayName: string
    avatarUrl: string | null
    score: number
    showScore: boolean
    isWinner: boolean
    isLoser: boolean
  },
  x: number,
  y: number,
  width: number,
  r: number,
  position: 'top' | 'bottom',
  avatarData: Map<string, string>,
): string {
  const isTbd = slot.displayName === 'TBD'
  const textY = y + BRACKET_SLOT_H / 2 + 6
  const scoreY = textY + 3
  const nameColor = isTbd ? COLORS.subtle : slot.isWinner ? COLORS.accent : slot.isLoser ? COLORS.subtle : COLORS.fg
  const seedColor = slot.isWinner ? COLORS.accent : COLORS.subtle
  const scoreColor = slot.isWinner ? COLORS.accent : slot.isLoser ? COLORS.subtle : COLORS.fg
  let svg = ''

  if (slot.isWinner) {
    const hlPath = position === 'top'
      ? `M${x + r},${y} H${x + width - r} A${r},${r} 0 0 1 ${x + width},${y + r} V${y + BRACKET_SLOT_H} H${x} V${y + r} A${r},${r} 0 0 1 ${x + r},${y}`
      : `M${x},${y} H${x + width} V${y + BRACKET_SLOT_H - r} A${r},${r} 0 0 1 ${x + width - r},${y + BRACKET_SLOT_H} H${x + r} A${r},${r} 0 0 1 ${x},${y + BRACKET_SLOT_H - r} Z`
    svg += `<path d="${hlPath}" fill="${COLORS.accentDim}" />`
  }

  if (isTbd) {
    svg += `<text x="${x + 51}" y="${textY}" text-anchor="middle" fill="${COLORS.subtle}" font-size="18" font-weight="700">—</text>`
    svg += `<text x="${x + 76}" y="${textY}" fill="${COLORS.subtle}" font-size="20" font-weight="700" letter-spacing="2">TBD</text>`
  }
  else {
    const player: AvatarPlayer = { playerId: slot.playerId, displayName: slot.displayName, avatarUrl: slot.avatarUrl }
    const avatarSize = 30
    svg += `<text x="${x + 14}" y="${textY}" fill="${seedColor}" font-size="17" font-weight="900">${slot.seed}</text>`
    svg += renderAvatar(player, x + 36, y + 9, avatarSize, avatarClipId(player), avatarData.get(avatarKey(player)), seedColor, false)
    svg += renderInlineText(slot.displayName, x + 76, textY, width - 124, 21, slot.isWinner ? 900 : 700, nameColor)
    if (slot.showScore) svg += `<text x="${x + width - 18}" y="${scoreY}" text-anchor="middle" fill="${scoreColor}" font-size="24" font-weight="900">${slot.score}</text>`
  }

  return svg
}

function formatBracketRoundLabel(round: string): string {
  if (round === 'quarterfinal') return 'QUARTERFINALS'
  if (round === 'semifinal') return 'SEMIFINALS'
  if (round === 'final') return 'FINALS'
  return round.replace(/_/g, ' ').toUpperCase()
}

function renderStandingRows(rows: Array<TournamentOpponentCardPlayer & { eligible?: boolean }>, avatarData: Map<string, string>, rankOffset: number): string {
  if (rows.length === 0) {
    return `<text x="64" y="220" fill="${COLORS.muted}" font-size="34" font-weight="900">No standings yet</text>`
  }

  const rowCountPerColumn = Math.ceil(rows.length / 2)
  return rows.map((row, index) => {
    const rank = rankOffset + index + 1
    const column = index >= rowCountPerColumn ? 1 : 0
    const rowIndex = index % rowCountPerColumn
    const x = 64 + (column * (LEADERBOARD_COLUMN_WIDTH + LEADERBOARD_COLUMN_GAP))
    const y = LEADERBOARD_START_Y + (rowIndex * LEADERBOARD_ROW_STEP)
    return renderStandingStyleRow(row, rank, x, y, LEADERBOARD_COLUMN_WIDTH, rank <= 8 && row.eligible === true, avatarData, index)
  }).join('')
}

function statsSvgShell(body: string, players: AvatarPlayer[]): string {
  return leaderboardSvgShell(IMAGE_HEIGHT, 'STATS', body, players)
}

function renderTournamentStatsBody(data: TournamentOpponentCardData, avatarData: Map<string, string>): string {
  const rightRows = getStatsRightColumnRows(data)
  return `
    ${renderPlayerStatsPanel(data.player, avatarData.get(avatarKey(data.player)))}
    <text x="584" y="168" fill="${COLORS.fg}" font-size="30" font-weight="900">${data.pairing ? 'Playoff match' : 'Recommended opponents'}</text>
    ${rightRows.length > 0
      ? rightRows.slice(0, 8).map((player, index) => renderStandingStyleRow(player, player.rank ?? index + 1, 584, 196 + (index * STATS_ROW_STEP), 552, false, avatarData, index, 'compact')).join('')
      : `<text x="584" y="248" fill="${COLORS.muted}" font-size="28" font-weight="900">No linked opponents available</text>`}
  `
}

function renderPlayerStatsPanel(player: TournamentOpponentCardPlayer, avatarDataUri?: string): string {
  const rank = player.rank ? `#${player.rank}` : '#?'
  return `
    <rect x="64" y="166" width="470" height="152" rx="24" fill="rgba(255,255,255,0.045)" />
    ${renderAvatar(player, 92, 194, 96, avatarClipId(player), avatarDataUri, COLORS.accent, false)}
    ${renderInlineText(player.displayName, 216, 232, 288, 42, 900, COLORS.fg)}
    <text x="218" y="274" fill="${COLORS.muted}" font-size="28" font-weight="800">${player.games} games</text>

    <rect x="64" y="348" width="222" height="162" rx="24" fill="rgba(255,255,255,0.045)" />
    <text x="175" y="431" text-anchor="middle" fill="${COLORS.fg}" font-size="74" font-weight="900">${escapeXml(rank)}</text>
    <text x="175" y="478" text-anchor="middle" fill="${COLORS.muted}" font-size="34" font-weight="900">Rank</text>

    <rect x="312" y="348" width="222" height="162" rx="24" fill="rgba(255,255,255,0.045)" />
    <text x="423" y="431" text-anchor="middle" fill="${COLORS.fg}" font-size="74" font-weight="900">${player.wins}-${player.losses}</text>
    <text x="423" y="478" text-anchor="middle" fill="${COLORS.accent}" font-size="34" font-weight="900">${Math.round(player.winRate * 100)}%</text>
  `
}

function getStatsRightColumnRows(data: TournamentOpponentCardData): TournamentOpponentCardPlayer[] {
  if (!data.pairing) return data.opponents
  const ownId = data.player.playerId
  const rows = [data.pairing.playerOne, data.pairing.playerTwo]
  return rows.filter(player => player.playerId !== ownId)
}

function renderStandingStyleRow(
  row: TournamentOpponentCardPlayer,
  rank: number,
  x: number,
  y: number,
  width: number,
  highlighted: boolean,
  avatarData: Map<string, string>,
  rowIndex: number,
  size: 'regular' | 'compact' = 'regular',
): string {
  const isCompact = size === 'compact'
  const rowHeight = isCompact ? STATS_ROW_HEIGHT : LEADERBOARD_ROW_HEIGHT
  const rankX = isCompact ? 36 : 44
  const rankY = isCompact ? 28 : 36
  const rankFont = isCompact ? 22 : 28
  const avatarX = isCompact ? 66 : 80
  const avatarY = isCompact ? 6 : 8
  const avatarSize = isCompact ? 30 : 38
  const nameX = isCompact ? 108 : 134
  const textY = isCompact ? 28 : 35
  const nameFont = isCompact ? 21 : 26
  const metricOffset = isCompact ? 96 : 112
  const percentOffset = isCompact ? 20 : 24
  const metricFont = isCompact ? 20 : 24
  const nameMaxWidth = width - nameX - metricOffset - (isCompact ? 24 : 72)
  const rankColor = highlighted ? COLORS.accent : COLORS.muted
  const fill = highlighted
    ? 'rgba(200,170,110,0.13)'
    : rowIndex % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.025)'
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${rowHeight}" rx="16" fill="${fill}" />
    <text x="${x + rankX}" y="${y + rankY}" text-anchor="middle" fill="${rankColor}" font-size="${rankFont}" font-weight="900">#${rank}</text>
    ${renderAvatar(row, x + avatarX, y + avatarY, avatarSize, avatarClipId(row), avatarData.get(avatarKey(row)), rankColor, false)}
    ${renderInlineText(row.displayName, x + nameX, y + textY, nameMaxWidth, nameFont, 900, COLORS.fg)}
    <text x="${x + width - metricOffset}" y="${y + textY}" text-anchor="end" fill="${COLORS.fg}" font-size="${metricFont}" font-weight="900">${row.wins}-${row.losses}</text>
    <text x="${x + width - percentOffset}" y="${y + textY}" text-anchor="end" fill="${highlighted ? COLORS.accent : COLORS.muted}" font-size="${metricFont}" font-weight="900">${Math.round(row.winRate * 100)}%</text>
  `
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
      ${renderInlineText(player.displayName, 286, y + 92, 570, 58, 900, COLORS.fg)}
      <text x="288" y="${y + 140}" fill="${COLORS.muted}" font-size="31" font-weight="800">${escapeXml(truncateToWidth(formatLeader(player.civId), 570, 31, 800))}</text>
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

async function loadLeaderIconData(players: readonly { civId: string | null }[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  await Promise.all(players.map(async (player) => {
    if (!player.civId || result.has(player.civId)) return
    const url = getLeaderEmojiUrl(player.civId)
    if (!url) return
    const uri = await fetchDiscordImageDataUri(url).catch(() => null)
    if (uri) result.set(player.civId, uri)
  }))
  return result
}

function getLeaderEmojiUrl(civId: string): string | null {
  const emojiId = LEADER_EMOJI_IDS[civId]
  return emojiId ? `https://cdn.discordapp.com/emojis/${emojiId}.png?size=128&quality=lossless` : null
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
  return `avatar-${id.replace(/[^\w-]/g, '')}`
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

function truncateToWidth(value: string, maxWidth: number, fontSize: number, fontWeight: number): string {
  if (measureTextWidth(value, fontSize, fontWeight) <= maxWidth) return value

  const suffix = '...'
  const suffixWidth = measureTextWidth(suffix, fontSize, fontWeight)
  let result = ''
  for (const segment of splitInlineTextSegments(value)) {
    if (segment.type === 'emoji') {
      if (measureTextWidth(result + segment.value, fontSize, fontWeight) + suffixWidth > maxWidth) break
      result += segment.value
      continue
    }

    let segmentComplete = true
    for (const char of segment.value) {
      if (measureTextWidth(result + char, fontSize, fontWeight) + suffixWidth > maxWidth) {
        segmentComplete = false
        break
      }
      result += char
    }
    if (!segmentComplete) break
  }
  return result.length > 0 ? `${result.trimEnd()}${suffix}` : suffix
}

function renderInlineText(value: string, x: number, y: number, maxWidth: number, fontSize: number, fontWeight: number, fill: string): string {
  const segments = splitInlineTextSegments(truncateToWidth(value, maxWidth, fontSize, fontWeight))
  let currentX = x
  let svg = ''
  let textRun = ''

  const flushText = () => {
    if (!textRun) return
    svg += `<text x="${currentX}" y="${y}" fill="${fill}" font-size="${fontSize}" font-weight="${fontWeight}">${escapeXml(textRun)}</text>`
    currentX += measurePlainTextWidth(textRun, fontSize, fontWeight)
    textRun = ''
  }

  for (const segment of segments) {
    if (segment.type === 'text') {
      textRun += segment.value
      continue
    }
    flushText()
    const size = getEmojiRenderSize(fontSize)
    svg += renderEmojiIcon(segment.icon, currentX, y - (fontSize * 0.84), size)
    currentX += getEmojiAdvance(fontSize)
  }
  flushText()
  return svg
}

function measureTextWidth(value: string, fontSize: number, fontWeight: number): number {
  return splitInlineTextSegments(value).reduce((sum, segment) => (
    sum + (segment.type === 'emoji' ? getEmojiAdvance(fontSize) : measurePlainTextWidth(segment.value, fontSize, fontWeight))
  ), 0)
}

function measurePlainTextWidth(value: string, fontSize: number, fontWeight: number): number {
  const weightFactor = fontWeight >= 800 ? 1.06 : 1
  let width = 0
  for (const char of value) width += getApproxCharWidth(char) * fontSize * weightFactor
  return width
}

function splitInlineTextSegments(value: string): InlineTextSegment[] {
  const emojiEntries = Object.entries(TOURNAMENT_EMOJI_ICONS).sort((left, right) => right[0].length - left[0].length)
  const segments: InlineTextSegment[] = []
  let index = 0
  let textRun = ''

  const flushText = () => {
    if (!textRun) return
    segments.push({ type: 'text', value: textRun })
    textRun = ''
  }

  while (index < value.length) {
    const emoji = emojiEntries.find(([candidate]) => value.startsWith(candidate, index))
    if (emoji) {
      flushText()
      segments.push({ type: 'emoji', value: emoji[0], icon: emoji[1] })
      index += emoji[0].length
      continue
    }

    const codePoint = value.codePointAt(index)
    if (codePoint == null) break
    const char = String.fromCodePoint(codePoint)
    textRun += char
    index += char.length
  }

  flushText()
  return segments
}

function renderEmojiIcon(icon: TournamentEmojiIcon, x: number, y: number, size: number): string {
  const prefix = `tournament-emoji-${emojiSvgInstance++}-`
  const body = prefixSvgIds(icon.body, prefix)
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 ${icon.width} ${icon.height}" overflow="visible">${body}</svg>`
}

function prefixSvgIds(body: string, prefix: string): string {
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!).filter(Boolean)
  let result = body
  for (const id of ids) {
    const escaped = escapeRegExp(id)
    result = result
      .replace(new RegExp(`id="${escaped}"`, 'g'), `id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${prefix}${id})`)
      .replace(new RegExp(`href="#${escaped}"`, 'g'), `href="#${prefix}${id}"`)
      .replace(new RegExp(`xlink:href="#${escaped}"`, 'g'), `xlink:href="#${prefix}${id}"`)
  }
  return result
}

function getEmojiRenderSize(fontSize: number): number {
  return fontSize * 1.04
}

function getEmojiAdvance(fontSize: number): number {
  return fontSize * 1.06
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
