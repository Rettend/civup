import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { DiscordFilePayload } from './index.ts'
import { formatLeaderboardModeLabel } from '@civup/game'
import { buildLeaderboard, getLeaderboardMinGames } from '@civup/rating'
import { listPlayerIdentitiesById } from '../player/profile.ts'
import { escapeXml, initialsForDisplayName, renderSvgToPng, sanitizeAvatarRenderUrl, truncateText } from './image.ts'

interface LeaderboardRatingRow {
  playerId: string
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
}

const WIDTH = 1440
const HEIGHT = 1180

const MODE_META: Record<LeaderboardMode, { accent: string, accentSoft: string, embedColor: number }> = {
  'duel': { accent: '#ef4444', accentSoft: 'rgba(239, 68, 68, 0.22)', embedColor: 0xEF4444 },
  'duo': { accent: '#0ac8b9', accentSoft: 'rgba(10, 200, 185, 0.22)', embedColor: 0x0AC8B9 },
  'squad': { accent: '#8b5cf6', accentSoft: 'rgba(139, 92, 246, 0.22)', embedColor: 0x8B5CF6 },
  'ffa': { accent: '#c8aa6e', accentSoft: 'rgba(200, 170, 110, 0.22)', embedColor: 0xC8AA6E },
  'red-death': { accent: '#e84057', accentSoft: 'rgba(232, 64, 87, 0.22)', embedColor: 0xE84057 },
}

export async function buildLeaderboardImageCard(options: {
  db: Database
  mode: LeaderboardMode
  rows: readonly LeaderboardRatingRow[]
  titlePrefix?: string
}): Promise<{ embed: Record<string, unknown>, file: DiscordFilePayload }> {
  const entries = buildLeaderboard([...options.rows], getLeaderboardMinGames(options.mode)).slice(0, 25)
  const identities = await listPlayerIdentitiesById(options.db, entries.map(entry => entry.playerId))
  const title = formatLeaderboardTitle(options.mode, options.titlePrefix)
  const svg = buildLeaderboardSvg({
    title,
    mode: options.mode,
    entries: entries.map((entry, index) => {
      const identity = identities.get(entry.playerId)
      return {
        rank: index + 1,
        playerId: entry.playerId,
        displayName: identity?.displayName ?? entry.playerId,
        avatarUrl: sanitizeAvatarRenderUrl(identity?.avatarUrl ?? null),
        rating: Math.round(entry.displayRating),
        wins: entry.wins,
        gamesPlayed: entry.gamesPlayed,
        winPct: Math.round(entry.winRate * 100),
      }
    }),
  })
  const png = await renderSvgToPng(svg)
  const filename = `leaderboard-${options.mode}.png`

  return {
    embed: {
      title,
      color: MODE_META[options.mode].embedColor,
      image: { url: `attachment://${filename}` },
    },
    file: {
      filename,
      contentType: 'image/png',
      data: png,
    },
  }
}

function buildLeaderboardSvg(options: {
  title: string
  mode: LeaderboardMode
  entries: Array<{
    rank: number
    playerId: string
    displayName: string
    avatarUrl: string | null
    rating: number
    wins: number
    gamesPlayed: number
    winPct: number
  }>
}): string {
  const modeMeta = MODE_META[options.mode]
  const subtitle = `${options.entries.length > 0 ? 'Top 25 players' : 'No ranked players yet'} • ${getLeaderboardMinGames(options.mode)} games minimum`
  const cardWidth = 640
  const cardHeight = 58
  const cardGap = 10
  const rowsPerColumn = 13

  const cards = options.entries.length === 0
    ? `<text x="80" y="320" fill="#d4d4d8" font-size="28">No players with enough games to rank yet.</text>`
    : options.entries.map((entry, index) => {
        const column = Math.floor(index / rowsPerColumn)
        const row = index % rowsPerColumn
        const x = 80 + (column * 672)
        const y = 180 + (row * (cardHeight + cardGap))
        return renderLeaderboardRow(entry, x, y, cardWidth, cardHeight)
      }).join('')

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none">
  <defs>
    <linearGradient id="bg-gradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#09090b" />
      <stop offset="100%" stop-color="#111216" />
    </linearGradient>
    <radialGradient id="accent-glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1200 100) rotate(90) scale(360 540)">
      <stop offset="0%" stop-color="${modeMeta.accentSoft}" />
      <stop offset="100%" stop-color="rgba(0,0,0,0)" />
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg-gradient)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#accent-glow)" />
  <rect x="80" y="58" width="180" height="34" rx="17" fill="${modeMeta.accentSoft}" stroke="${modeMeta.accent}" />
  <text x="104" y="80" fill="${modeMeta.accent}" font-size="16" font-weight="700" letter-spacing="0.12em">LEADERBOARD</text>
  <text x="80" y="132" fill="#fafafa" font-size="44" font-weight="700">${escapeXml(options.title)}</text>
  <text x="80" y="164" fill="#a1a1aa" font-size="20">${escapeXml(subtitle)}</text>
  <rect x="64" y="180" width="1312" height="948" rx="34" fill="#161619" stroke="rgba(255,255,255,0.08)" />
  ${cards}
</svg>`.trim()
}

function renderLeaderboardRow(
  entry: {
    rank: number
    displayName: string
    avatarUrl: string | null
    rating: number
    wins: number
    gamesPlayed: number
    winPct: number
  },
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const accent = entry.rank === 1
    ? '#c8aa6e'
    : entry.rank === 2
      ? '#94a3b8'
      : entry.rank === 3
        ? '#fb7185'
        : '#27272a'
  const name = truncateText(entry.displayName, 22)
  const avatar = renderAvatar(entry.displayName, entry.avatarUrl, 78, 12, 34, `leaderboard-${entry.rank}`)

  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="${height}" rx="22" fill="#1f1f23" stroke="rgba(255,255,255,0.08)" />
      <rect x="16" y="14" width="${width - 32}" height="3" rx="1.5" fill="${accent}" opacity="0.9" />
      <rect x="18" y="18" width="44" height="24" rx="12" fill="rgba(255,255,255,0.06)" />
      <text x="40" y="34" fill="#fafafa" font-size="15" font-weight="700" text-anchor="middle">#${entry.rank}</text>
      ${avatar}
      <text x="124" y="30" fill="#fafafa" font-size="19" font-weight="700">${escapeXml(name)}</text>
      <text x="124" y="48" fill="#a1a1aa" font-size="13">${entry.wins}/${entry.gamesPlayed} wins • ${entry.winPct}%</text>
      <text x="${width - 18}" y="38" fill="#fafafa" font-size="24" font-weight="700" text-anchor="end">${entry.rating}</text>
    </g>
  `.trim()
}

function renderAvatar(displayName: string, avatarUrl: string | null, x: number, y: number, size: number, key: string): string {
  const clipId = `leaderboard-avatar-${key}`
  const initials = escapeXml(initialsForDisplayName(displayName))
  const image = avatarUrl
    ? `<image href="${escapeXml(avatarUrl)}" x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`
    : ''

  return `
    <g transform="translate(${x} ${y})">
      <defs>
        <clipPath id="${clipId}">
          <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" />
        </clipPath>
      </defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#09090b" stroke="rgba(200,170,110,0.55)" stroke-width="2" />
      ${image}
      ${avatarUrl ? '' : `<text x="${size / 2}" y="${(size / 2) + 6}" fill="#fafafa" font-size="14" font-weight="700" text-anchor="middle">${initials}</text>`}
    </g>
  `.trim()
}

function formatLeaderboardTitle(mode: LeaderboardMode, titlePrefix?: string): string {
  const baseTitle = `${formatLeaderboardModeLabel(mode, mode)} Leaderboard`
  return titlePrefix ? `${titlePrefix} ${baseTitle}` : baseTitle
}
