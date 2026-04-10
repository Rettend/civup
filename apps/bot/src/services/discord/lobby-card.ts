import type { Database } from '@civup/db'
import type { GameMode, LeaderDataVersion } from '@civup/game'
import { formatModeLabel, getLeader, isTeamMode, teamSize as getModeTeamSize } from '@civup/game'
import { displayRating } from '@civup/rating'
import type { DiscordMessagePayload } from './index.ts'
import { listPlayerIdentitiesById } from '../player/profile.ts'
import { escapeXml, initialsForDisplayName, renderSvgToPng, sanitizeAvatarRenderUrl, truncateText } from './image.ts'

type LobbyImageStage = 'draft-complete' | 'reported' | 'cancelled' | 'scrubbed' | 'timeout'

interface ModerationContext {
  actorId?: string | null
  actorLabel?: string | null
  reason?: string | null
}

export interface LobbyImageParticipant {
  playerId: string
  team: number | null
  civId: string | null
  placement?: number | null
  ratingBeforeMu?: number | null
  ratingBeforeSigma?: number | null
  ratingAfterMu?: number | null
  ratingAfterSigma?: number | null
  leaderboardBeforeRank?: number | null
  leaderboardAfterRank?: number | null
  leaderboardEligibleCount?: number | null
  displayName?: string | null
  avatarUrl?: string | null
}

interface ResolvedLobbyImageParticipant extends LobbyImageParticipant {
  displayName: string
  avatarUrl: string | null
}

interface TeamGroup {
  index: number
  placement: number | null
  participants: ResolvedLobbyImageParticipant[]
}

interface SidebarPanel {
  title: string
  lines: string[]
  accent: string
}

const WIDTH = 1440
const HEIGHT = 900
const HEADER_X = 60
const HEADER_Y = 54
const CONTENT_X = 60
const CONTENT_Y = 170
const CONTENT_HEIGHT = 670
const CONTENT_GAP = 24

const LEADERBOARD_UPDATE_TRACKED_PERCENT = 0.10
const LEADERBOARD_UPDATE_MIN_POSITIONS = 3

const STAGE_META: Record<LobbyImageStage, { label: string, accent: string, accentSoft: string, embedColor: number }> = {
  'draft-complete': {
    label: 'DRAFT COMPLETE',
    accent: '#c8aa6e',
    accentSoft: 'rgba(200, 170, 110, 0.22)',
    embedColor: 0xC8AA6E,
  },
  'reported': {
    label: 'RESULT REPORTED',
    accent: '#38bdf8',
    accentSoft: 'rgba(56, 189, 248, 0.22)',
    embedColor: 0x38BDF8,
  },
  'cancelled': {
    label: 'DRAFT CANCELLED',
    accent: '#e84057',
    accentSoft: 'rgba(232, 64, 87, 0.22)',
    embedColor: 0xE84057,
  },
  'scrubbed': {
    label: 'MATCH SCRUBBED',
    accent: '#e84057',
    accentSoft: 'rgba(232, 64, 87, 0.22)',
    embedColor: 0xE84057,
  },
  'timeout': {
    label: 'LOBBY TIMEOUT',
    accent: '#e84057',
    accentSoft: 'rgba(232, 64, 87, 0.22)',
    embedColor: 0xE84057,
  },
}

export async function buildLobbyImageMessage(options: {
  db?: Database
  mode: GameMode
  stage: LobbyImageStage
  participants: readonly LobbyImageParticipant[]
  moderation?: ModerationContext
  rankedRoleLines?: readonly string[]
  leaderDataVersion?: LeaderDataVersion | null
  redDeath?: boolean
  targetSize?: number
}): Promise<DiscordMessagePayload> {
  const playerIds = new Set(options.participants.map(participant => participant.playerId))
  if (options.moderation?.actorId) playerIds.add(options.moderation.actorId)

  const playerIdentities = options.db
    ? await listPlayerIdentitiesById(options.db, [...playerIds])
    : new Map()

  const participants = options.participants.map((participant) => {
    const player = playerIdentities.get(participant.playerId)
    return {
      ...participant,
      displayName: participant.displayName?.trim() || player?.displayName || participant.playerId,
      avatarUrl: sanitizeAvatarRenderUrl(participant.avatarUrl ?? player?.avatarUrl ?? null),
    } satisfies ResolvedLobbyImageParticipant
  })

  const svg = buildLobbyImageSvg({
    mode: options.mode,
    stage: options.stage,
    participants,
    moderation: options.moderation,
    playerIdentities,
    rankedRoleLines: options.rankedRoleLines ?? [],
    leaderDataVersion: options.leaderDataVersion ?? null,
    redDeath: options.redDeath ?? false,
    targetSize: options.targetSize,
  })
  const png = await renderSvgToPng(svg)
  const filename = `match-${options.stage}.png`
  const stageMeta = STAGE_META[options.stage]
  const title = `${stageMeta.label}  -  ${formatModeLabel(options.mode, options.mode, { redDeath: options.redDeath, targetSize: options.targetSize ?? options.participants.length })}`

  return {
    content: null,
    embeds: [{
      title,
      color: stageMeta.embedColor,
      image: { url: `attachment://${filename}` },
    }],
    files: [{
      filename,
      contentType: 'image/png',
      data: png,
    }],
    allowed_mentions: { parse: [] },
  }
}

function buildLobbyImageSvg(options: {
  mode: GameMode
  stage: LobbyImageStage
  participants: readonly ResolvedLobbyImageParticipant[]
  moderation?: ModerationContext
  playerIdentities: Map<string, { displayName: string, avatarUrl: string | null }>
  rankedRoleLines: readonly string[]
  leaderDataVersion: LeaderDataVersion | null
  redDeath: boolean
  targetSize?: number
}): string {
  const stageMeta = STAGE_META[options.stage]
  const modeLabel = formatModeLabel(options.mode, options.mode, {
    redDeath: options.redDeath,
    targetSize: options.targetSize ?? options.participants.length,
  })
  const sidebarPanels = buildSidebarPanels(options)
  const hasSidebar = sidebarPanels.length > 0
  const mainWidth = hasSidebar ? 920 : 1320
  const mainInnerWidth = mainWidth - 48
  const sidebarWidth = hasSidebar ? WIDTH - (CONTENT_X * 2) - mainWidth - CONTENT_GAP : 0

  const groups = buildTeamGroups(options.mode, options.participants)
  const mainContent = `<g transform="translate(24 24)">${groups.length > 0
    ? renderTeamGroups(groups, mainInnerWidth, options.stage)
    : renderFlatRoster(options.participants, mainInnerWidth, options.stage)}</g>`

  const sidebar = hasSidebar
    ? renderSidebar(sidebarPanels, CONTENT_X + mainWidth + CONTENT_GAP, CONTENT_Y, sidebarWidth)
    : ''

  const footerBadge = formatFooterBadge(options.leaderDataVersion, options.redDeath)

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none">
  <defs>
    <linearGradient id="bg-gradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#09090b" />
      <stop offset="100%" stop-color="#111216" />
    </linearGradient>
    <radialGradient id="accent-glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1180 120) rotate(90) scale(340 520)">
      <stop offset="0%" stop-color="${stageMeta.accentSoft}" />
      <stop offset="100%" stop-color="rgba(0,0,0,0)" />
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg-gradient)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#accent-glow)" />
  <rect x="${HEADER_X}" y="${HEADER_Y}" width="210" height="34" rx="17" fill="${stageMeta.accentSoft}" stroke="${stageMeta.accent}" />
  <text x="${HEADER_X + 24}" y="${HEADER_Y + 22}" fill="${stageMeta.accent}" font-size="16" font-weight="700" letter-spacing="0.12em">${escapeXml(stageMeta.label)}</text>
  <text x="${HEADER_X}" y="${HEADER_Y + 84}" fill="#fafafa" font-size="44" font-weight="700">${escapeXml(modeLabel)}</text>
  <text x="${HEADER_X}" y="${HEADER_Y + 120}" fill="#a1a1aa" font-size="20">${escapeXml(buildSubtitle(options.stage, options.participants.length))}</text>
  ${footerBadge ? `<rect x="${WIDTH - 250}" y="${HEADER_Y}" width="190" height="34" rx="17" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)" /><text x="${WIDTH - 226}" y="${HEADER_Y + 22}" fill="#fafafa" font-size="16" font-weight="600">${escapeXml(footerBadge)}</text>` : ''}
  ${renderPanel(CONTENT_X, CONTENT_Y, mainWidth, CONTENT_HEIGHT, '#161619', 'rgba(255,255,255,0.08)', mainContent)}
  ${sidebar}
</svg>`.trim()
}

function buildSubtitle(stage: LobbyImageStage, participantCount: number): string {
  if (stage === 'reported') return `${participantCount} players resolved and archived permanently.`
  if (stage === 'draft-complete') return `${participantCount} players locked in with final leaders.`
  if (stage === 'timeout') return 'Lobby closed after inactivity.'
  if (stage === 'scrubbed') return 'This match was removed from the record.'
  return 'This draft was closed before reporting.'
}

function renderTeamGroups(groups: readonly TeamGroup[], panelWidth: number, stage: LobbyImageStage): string {
  const orderedGroups = stage === 'reported'
    ? [...groups].sort((left, right) => {
        const placementDiff = (left.placement ?? 99) - (right.placement ?? 99)
        if (placementDiff !== 0) return placementDiff
        return left.index - right.index
      })
    : [...groups]
  const isFourUp = groups.length === 4
  const columns = isFourUp ? 2 : groups.length === 2 ? 2 : 1
  const cardWidth = columns === 2 ? Math.floor((panelWidth - 24) / 2) : panelWidth
  const cardHeight = isFourUp ? 290 : 610
  const gap = isFourUp ? 32 : 24

  return orderedGroups.map((group, index) => {
    const column = columns > 0 ? index % columns : 0
    const row = columns > 0 ? Math.floor(index / columns) : 0
    const x = 0 + (column * (cardWidth + gap))
    const y = 0 + (row * (cardHeight + gap))
    return renderTeamGroupCard(group, x, y, cardWidth, cardHeight, stage)
  }).join('')
}

function renderTeamGroupCard(group: TeamGroup, x: number, y: number, width: number, height: number, stage: LobbyImageStage): string {
  const badge = stage === 'reported' && group.placement != null
    ? `<rect x="${width - 96}" y="24" width="72" height="32" rx="16" fill="rgba(56,189,248,0.16)" stroke="rgba(56,189,248,0.5)" /><text x="${width - 60}" y="45" fill="#7dd3fc" font-size="18" font-weight="700" text-anchor="middle">#${group.placement}</text>`
    : ''
  const rows = group.participants.map((participant, index) => renderParticipantCard(
    participant,
    20,
    72 + (index * 118),
    width - 40,
    96,
    `${group.index}-${index}`,
    { showPlacement: false, rankLabel: stage === 'reported' ? formatRatingDelta(participant) : null },
  )).join('')

  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="${height}" rx="26" fill="#18181b" stroke="rgba(255,255,255,0.08)" />
      <rect x="20" y="18" width="160" height="4" rx="2" fill="rgba(200,170,110,0.8)" />
      <text x="24" y="48" fill="#fafafa" font-size="28" font-weight="700">${escapeXml(formatTeamName(group.index))}</text>
      ${badge}
      ${rows}
    </g>
  `.trim()
}

function renderFlatRoster(participants: readonly ResolvedLobbyImageParticipant[], panelWidth: number, stage: LobbyImageStage): string {
  if (participants.length === 0) {
    return `<text x="36" y="88" fill="#a1a1aa" font-size="22">No players available.</text>`
  }

  const orderedParticipants = stage === 'reported'
    ? [...participants].sort((left, right) => {
        const placementDiff = (left.placement ?? 99) - (right.placement ?? 99)
        if (placementDiff !== 0) return placementDiff
        return left.displayName.localeCompare(right.displayName)
      })
    : [...participants]

  const columns = orderedParticipants.length > 4 ? 2 : 1
  const columnGap = 22
  const cardWidth = columns === 2 ? Math.floor((panelWidth - columnGap) / 2) : panelWidth
  const rowsPerColumn = Math.ceil(orderedParticipants.length / columns)

  return orderedParticipants.map((participant, index) => {
    const column = Math.floor(index / rowsPerColumn)
    const row = index % rowsPerColumn
    const x = column * (cardWidth + columnGap)
    const y = row * 104
    const placementLabel = stage === 'reported'
      ? formatPlacementBadge(participant.placement)
      : `${index + 1}`

    return renderParticipantCard(participant, x, y, cardWidth, 88, `flat-${index}`, {
      showPlacement: true,
      placementLabel,
      rankLabel: stage === 'reported' ? formatRatingDelta(participant) : null,
    })
  }).join('')
}

function renderParticipantCard(
  participant: ResolvedLobbyImageParticipant,
  x: number,
  y: number,
  width: number,
  height: number,
  key: string,
  options: {
    showPlacement: boolean
    placementLabel?: string
    rankLabel?: string | null
  },
): string {
  const name = truncateText(participant.displayName, 22)
  const leaderName = participant.civId ? truncateText(formatLeaderName(participant.civId), 32) : ''
  const rowAccent = participant.placement === 1 ? '#c8aa6e' : '#27272a'
  const avatarX = options.showPlacement ? 66 : 18
  const avatar = renderAvatar(participant.displayName, participant.avatarUrl, avatarX, 18, 52, key)
  const placementChip = options.showPlacement
    ? `<rect x="16" y="14" width="42" height="28" rx="14" fill="rgba(255,255,255,0.06)" /><text x="37" y="33" fill="#fafafa" font-size="16" font-weight="700" text-anchor="middle">${escapeXml(options.placementLabel ?? '')}</text>`
    : ''
  const leftTextX = options.showPlacement ? 130 : 88
  const rightLabel = options.rankLabel ? truncateText(options.rankLabel, 14) : null

  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="${height}" rx="22" fill="#1f1f23" stroke="rgba(255,255,255,0.08)" />
      <rect x="16" y="14" width="${Math.max(120, width - 32)}" height="3" rx="1.5" fill="${rowAccent}" opacity="0.85" />
      ${placementChip}
      ${avatar}
      <text x="${leftTextX}" y="38" fill="#fafafa" font-size="24" font-weight="700">${escapeXml(name)}</text>
      ${leaderName ? `<text x="${leftTextX}" y="66" fill="#a1a1aa" font-size="18">${escapeXml(leaderName)}</text>` : ''}
      ${rightLabel ? `<text x="${width - 18}" y="40" fill="#d4d4d8" font-size="18" font-weight="600" text-anchor="end">${escapeXml(rightLabel)}</text>` : ''}
    </g>
  `.trim()
}

function renderAvatar(displayName: string, avatarUrl: string | null, x: number, y: number, size: number, key: string): string {
  const clipId = `avatar-clip-${key}`
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
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#09090b" stroke="rgba(200,170,110,0.6)" stroke-width="2" />
      ${image}
      ${avatarUrl ? '' : `<text x="${size / 2}" y="${(size / 2) + 7}" fill="#fafafa" font-size="18" font-weight="700" text-anchor="middle">${initials}</text>`}
    </g>
  `.trim()
}

function renderSidebar(panels: readonly SidebarPanel[], x: number, y: number, width: number): string {
  const panelHeight = Math.floor((CONTENT_HEIGHT - ((panels.length - 1) * 18)) / panels.length)
  return panels.map((panel, index) => renderPanel(
    x,
    y + (index * (panelHeight + 18)),
    width,
    panelHeight,
    '#161619',
    'rgba(255,255,255,0.08)',
    `
      <rect x="22" y="20" width="120" height="4" rx="2" fill="${panel.accent}" />
      <text x="22" y="52" fill="#fafafa" font-size="26" font-weight="700">${escapeXml(panel.title)}</text>
      ${panel.lines.map((line, lineIndex) => `<text x="22" y="${92 + (lineIndex * 28)}" fill="#d4d4d8" font-size="18">${escapeXml(line)}</text>`).join('')}
    `,
  )).join('')
}

function renderPanel(x: number, y: number, width: number, height: number, fill: string, stroke: string, inner: string): string {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="${height}" rx="30" fill="${fill}" stroke="${stroke}" />
      ${inner}
    </g>
  `.trim()
}

function buildTeamGroups(mode: GameMode, participants: readonly ResolvedLobbyImageParticipant[]): TeamGroup[] {
  const explicitTeams = new Map<number, ResolvedLobbyImageParticipant[]>()
  for (const participant of participants) {
    if (participant.team == null) continue
    const bucket = explicitTeams.get(participant.team) ?? []
    bucket.push(participant)
    explicitTeams.set(participant.team, bucket)
  }

  if (explicitTeams.size > 0) {
    return [...explicitTeams.entries()]
      .map(([index, groupParticipants]) => ({
        index,
        placement: getTeamPlacement(groupParticipants),
        participants: [...groupParticipants],
      }))
      .sort((left, right) => left.index - right.index)
  }

  const size = isTeamMode(mode) || mode === '1v1' ? getModeTeamSize(mode) ?? 1 : null
  if (!size) return []

  const groups: TeamGroup[] = []
  for (let index = 0; index < participants.length; index += size) {
    const groupParticipants = participants.slice(index, index + size)
    groups.push({
      index: Math.floor(index / size),
      placement: getTeamPlacement(groupParticipants),
      participants: groupParticipants,
    })
  }
  return groups
}

function getTeamPlacement(participants: readonly { placement?: number | null }[]): number | null {
  let placement: number | null = null
  for (const participant of participants) {
    if (participant.placement == null) continue
    placement = placement == null ? participant.placement : Math.min(placement, participant.placement)
  }
  return placement
}

function buildSidebarPanels(options: {
  stage: LobbyImageStage
  participants: readonly ResolvedLobbyImageParticipant[]
  moderation?: ModerationContext
  playerIdentities: Map<string, { displayName: string, avatarUrl: string | null }>
  rankedRoleLines: readonly string[]
}): SidebarPanel[] {
  const panels: SidebarPanel[] = []
  const moderationLines = formatModerationLines(options.moderation, options.playerIdentities)
  const leaderboardLines = options.stage === 'reported'
    ? formatLeaderboardUpdateLines(options.participants)
    : []
  const rankedRoleLines = options.rankedRoleLines.flatMap(line => wrapText(line, 34, 3))

  if (moderationLines.length > 0) {
    panels.push({
      title: 'Note',
      lines: moderationLines,
      accent: '#e84057',
    })
  }
  if (leaderboardLines.length > 0) {
    panels.push({
      title: 'Leaderboard',
      lines: leaderboardLines,
      accent: '#38bdf8',
    })
  }
  if (rankedRoleLines.length > 0) {
    panels.push({
      title: 'Ranked Roles',
      lines: rankedRoleLines,
      accent: '#c8aa6e',
    })
  }

  return panels.slice(0, 3)
}

function formatModerationLines(
  moderation: ModerationContext | undefined,
  playerIdentities: Map<string, { displayName: string, avatarUrl: string | null }>,
): string[] {
  if (!moderation) return []
  const actor = moderation.actorId?.trim()
    ? playerIdentities.get(moderation.actorId)?.displayName ?? moderation.actorLabel?.trim() ?? moderation.actorId
    : moderation.actorLabel?.trim() || 'System'
  const reason = moderation.reason?.trim() || 'No reason.'
  return wrapText(`${actor}: ${reason}`, 34, 5)
}

function formatLeaderboardUpdateLines(participants: readonly ResolvedLobbyImageParticipant[]): string[] {
  const eligibleCount = participants.find(participant => (participant.leaderboardEligibleCount ?? 0) > 0)?.leaderboardEligibleCount ?? 0
  const trackedMaxRank = eligibleCount > 0
    ? Math.max(LEADERBOARD_UPDATE_MIN_POSITIONS, Math.round(eligibleCount * LEADERBOARD_UPDATE_TRACKED_PERCENT))
    : 0

  const movers = participants
    .map((participant) => {
      const after = participant.leaderboardAfterRank ?? null
      if (after == null) return null

      const before = participant.leaderboardBeforeRank ?? null
      if (before == null) {
        return {
          participant,
          before,
          after,
          gain: Number.MAX_SAFE_INTEGER,
        }
      }

      const gain = before - after
      if (gain <= 0 || trackedMaxRank < 1 || after > trackedMaxRank) return null

      return { participant, before, after, gain }
    })
    .filter((entry): entry is { participant: ResolvedLobbyImageParticipant, before: number | null, after: number, gain: number } => entry !== null)
    .sort((left, right) => (right.gain - left.gain) || (left.after - right.after))

  return movers
    .slice(0, 3)
    .flatMap((move) => {
      const text = move.before == null
        ? `NEW ${move.participant.displayName} entered at ${formatPlacementBadge(move.after)}`
        : `UP ${move.participant.displayName} ${formatPlacementBadge(move.before)} -> ${formatPlacementBadge(move.after)}`
      return wrapText(text, 34, 2)
    })
}

function formatFooterBadge(leaderDataVersion: LeaderDataVersion | null, redDeath: boolean): string | null {
  if (redDeath || !leaderDataVersion) return null
  return leaderDataVersion === 'beta' ? 'BBG Beta' : 'BBG Live'
}

function formatPlacementBadge(placement: number | null | undefined): string {
  return placement == null ? '#?' : `#${placement}`
}

function formatRatingDelta(participant: LobbyImageParticipant): string | null {
  if (
    participant.ratingBeforeMu == null
    || participant.ratingBeforeSigma == null
    || participant.ratingAfterMu == null
    || participant.ratingAfterSigma == null
  ) {
    return null
  }

  const before = displayRating(participant.ratingBeforeMu, participant.ratingBeforeSigma)
  const after = displayRating(participant.ratingAfterMu, participant.ratingAfterSigma)
  const delta = Math.round(after - before)
  const roundedAfter = Math.round(after)
  return `${delta >= 0 ? '+' : ''}${delta} -> ${roundedAfter}`
}

function formatLeaderName(civId: string): string {
  try {
    return getLeader(civId).name
  }
  catch {
    return civId
  }
}

function formatTeamName(index: number): string {
  return `Team ${String.fromCharCode(65 + index)}`
}

function wrapText(text: string, maxLength: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxLength) {
      current = next
      continue
    }

    if (current) lines.push(current)
    current = word
    if (lines.length === maxLines - 1) break
  }

  if (lines.length < maxLines && current) lines.push(current)
  if (lines.length === 0) return [truncateText(text, maxLength)]

  const consumed = lines.join(' ')
  if (consumed.length < text.trim().length) {
    const lastIndex = Math.max(0, lines.length - 1)
    lines[lastIndex] = truncateText(lines[lastIndex]!, maxLength)
    if (!lines[lastIndex]!.endsWith('…')) lines[lastIndex] = truncateText(`${lines[lastIndex]}…`, maxLength)
  }

  return lines.slice(0, maxLines)
}
