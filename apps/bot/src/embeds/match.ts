import type { DraftCancelReason, DraftSeat, GameMode, LeaderDataVersion, QueueEntry, ResolvedMapVoteResult } from '@civup/game'
import { formatMapVoteResultLabel, formatModeLabel, getLeader, hasBetaLeaderData, isTeamMode, teamSize as modeTeamSize, normalizeAvailableLeaderDataVersion } from '@civup/game'
import { resolvePublicRating } from '@civup/rating'
import { Button, Components, Embed } from 'discord-hono'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'
import { formatPublicRatingChange, formatUnrankedResultMarker } from './rating-change.ts'

interface LobbyParticipant {
  playerId: string
  team: number | null
  civId: string | null
  placement?: number | null
  ratingBeforeMu?: number | null
  ratingBeforeSigma?: number | null
  ratingAfterMu?: number | null
  ratingAfterSigma?: number | null
  publicRatingBefore?: number | null
  publicRatingAfter?: number | null
  leaderboardBeforeRank?: number | null
  leaderboardAfterRank?: number | null
  leaderboardEligibleCount?: number | null
}

interface ModerationContext {
  actorId?: string | null
  actorLabel?: string | null
  reason?: string | null
}

interface ReporterContext {
  userId: string
  displayName?: string | null
  avatarUrl?: string | null
}

export type LobbyStage = 'open' | 'closed' | 'drafting' | 'draft-complete' | 'reported' | 'cancelled' | 'scrubbed' | 'timeout'

interface LobbyModeDisplayOptions {
  redDeath?: boolean
  civBlitz?: boolean
  targetSize?: number
}

const STAGE_LABELS: Record<LobbyStage, string> = {
  'open': 'LOBBY OPEN',
  'closed': 'LOBBY CLOSED',
  'drafting': 'DRAFTING',
  'draft-complete': 'DRAFT COMPLETE',
  'reported': 'RESULT REPORTED',
  'cancelled': 'DRAFT CANCELLED',
  'scrubbed': 'MATCH SCRUBBED',
  'timeout': 'LOBBY TIMEOUT',
}

const STAGE_COLORS: Record<LobbyStage, number> = {
  'open': 0x2563EB,
  'closed': 0x8B5CF6,
  'drafting': 0x0EA5A4,
  'draft-complete': 0xD97706,
  'reported': 0x475569,
  'cancelled': 0x6B7280,
  'scrubbed': 0xA8B1BD,
  'timeout': 0x6B7280,
}

export function lobbyOpenEmbed(
  mode: GameMode,
  entries: (QueueEntry | null)[],
  targetSize: number,
  minRoleId?: string | null,
  maxRoleId?: string | null,
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
  options: { reservedSlotLabels?: (string | null)[], closed?: boolean, civBlitz?: boolean } = {},
): Embed {
  const reservedSlotLabels = options.reservedSlotLabels ?? []
  const embed = baseLobbyEmbed(mode, options.closed ? 'closed' : 'open', leaderDataVersion, { redDeath, civBlitz: options.civBlitz, targetSize })
  const rankFields = [
    minRoleId ? { name: 'Min Rank', value: `<@&${minRoleId}>`, inline: true } : null,
    maxRoleId ? { name: 'Max Rank', value: `<@&${maxRoleId}>`, inline: true } : null,
  ].flatMap(field => field ? [field] : [])

  while (rankFields.length > 0 && rankFields.length % 3 !== 0) rankFields.push(blankInlineField())
  const infoFields = rankFields

  if (mode === '1v1') {
    const p1 = entries[0]?.playerId
    const p2 = entries[1]?.playerId
    const fields = [
      {
        name: 'Team A',
        value: `1. ${formatOpenSlot(p1, reservedSlotLabels[0])}`,
        inline: true,
      },
      {
        name: 'Team B',
        value: `1. ${formatOpenSlot(p2, reservedSlotLabels[1])}`,
        inline: true,
      },
    ]
    return infoFields.length > 0 ? embed.fields(...infoFields, ...fields) : embed.fields(...fields)
  }

  if (isTeamMode(mode)) {
    const teamSize = modeTeamSize(mode, targetSize) ?? 1
    const totalTeams = Math.max(1, Math.floor(targetSize / teamSize))
    const fields = layoutTeamFields(Array.from({ length: totalTeams }, (_, teamIndex) => {
      const teamLines = Array.from({ length: teamSize }, (_, index) => {
        const slotIndex = (teamIndex * teamSize) + index
        const playerId = entries[slotIndex]?.playerId
        return `${index + 1}. ${formatOpenSlot(playerId, reservedSlotLabels[slotIndex])}`
      }).join('\n')

      return {
        name: `Team ${String.fromCharCode(65 + teamIndex)}`,
        value: teamLines,
        inline: true,
      }
    }))
    return infoFields.length > 0 ? embed.fields(...infoFields, ...fields) : embed.fields(...fields)
  }

  const half = Math.ceil(targetSize / 2)
  const firstColumn = Array.from({ length: half }, (_, i) => {
    const playerId = entries[i]?.playerId
    return `${i + 1}. ${formatOpenSlot(playerId, reservedSlotLabels[i])}`
  }).join('\n')
  const secondColumn = Array.from({ length: targetSize - half }, (_, i) => {
    const seat = half + i
    const playerId = entries[seat]?.playerId
    return `${seat + 1}. ${formatOpenSlot(playerId, reservedSlotLabels[seat])}`
  }).join('\n')

  const fields = [
    { name: 'Slots', value: firstColumn, inline: true },
    { name: 'Slots', value: secondColumn || '\u200B', inline: true },
  ]
  return infoFields.length > 0 ? embed.fields(...infoFields, ...fields) : embed.fields(...fields)
}

function formatOpenSlot(playerId: string | null | undefined, reservedLabel?: string | null): string {
  if (playerId) return `<@${playerId}>`
  const label = reservedLabel?.trim()
  return label ? escapeDiscordFieldText(label) : '`[empty]`'
}

function escapeDiscordFieldText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\u02CB')
    .slice(0, 80)
}

export function lobbyDraftingEmbed(mode: GameMode, seats: DraftSeat[], leaderDataVersion?: LeaderDataVersion | null, redDeath = false, civBlitz = false): Embed {
  const embed = baseLobbyEmbed(mode, 'drafting', leaderDataVersion, { redDeath, civBlitz, targetSize: seats.length })
  const hasTeams = seats.some(seat => seat.team != null)

  if (hasTeams) {
    const teamIndexes = Array.from(new Set(seats.flatMap(seat => seat.team == null ? [] : [seat.team]))).sort((a, b) => a - b)
    return embed.fields(...layoutTeamFields(teamIndexes.map(teamIndex => ({
      name: `Team ${String.fromCharCode(65 + teamIndex)}`,
      value: seats.filter(seat => seat.team === teamIndex).map((seat, i) => `${i + 1}. <@${seat.playerId}>`).join('\n') || '`[empty]`',
      inline: true,
    }))))
  }

  const playerLines = seats.map((seat, i) => `${i + 1}. <@${seat.playerId}>`).join('\n')
  return embed.fields({ name: 'Slots', value: playerLines || '`[empty]`', inline: false })
}

export function lobbyDraftCompleteEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  mapVoteResult?: ResolvedMapVoteResult | null,
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
  civBlitz = false,
): Embed {
  return lobbyDraftCompleteLeaderEmbed(mode, participants, 'draft-complete', undefined, mapVoteResult, leaderDataVersion, redDeath, participants.length, undefined, undefined, civBlitz)
}

export function lobbyCancelledEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  reason: DraftCancelReason,
  moderation?: ModerationContext,
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
  footerUser?: ReporterContext | null,
  civBlitz = false,
): Embed {
  const stage: 'cancelled' | 'scrubbed' = reason === 'cancel' ? 'cancelled' : 'scrubbed'
  return lobbyDraftCompleteLeaderEmbed(
    mode,
    participants,
    stage,
    moderation,
    undefined,
    stage === 'scrubbed' ? undefined : leaderDataVersion,
    redDeath,
    participants.length,
    footerUser,
    leaderDataVersion,
    civBlitz,
  )
}

export function lobbyTimeoutEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
  civBlitz = false,
): Embed {
  return lobbyDraftCompleteLeaderEmbed(mode, participants, 'timeout', undefined, undefined, leaderDataVersion, redDeath, participants.length, undefined, undefined, civBlitz)
}

export function lobbyResultEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  moderation?: ModerationContext,
  options: { rankedRoleLines?: string[], reporter?: ReporterContext | null, mapVoteResult?: ResolvedMapVoteResult | null, leaderDataVersion?: LeaderDataVersion | null, civBlitz?: boolean, unranked?: boolean } = {},
  redDeath = false,
): Embed {
  return lobbyReportedEmbed(mode, participants, moderation, options, redDeath, participants.length, options.civBlitz === true)
}

export function lobbyComponents(mode: GameMode, lobbyId: string): Components {
  const label = 'Join'
  return new Components().row(
    new Button('match-join', label, 'Primary').custom_id(`${mode}:${lobbyId}`),
    new Button('match-browse', 'Browse', 'Secondary'),
  )
}

function baseLobbyEmbed(
  mode: GameMode,
  stage: LobbyStage,
  leaderDataVersion?: LeaderDataVersion | null,
  options: LobbyModeDisplayOptions = {},
): Embed {
  const embed = new Embed()
    .title(`${STAGE_LABELS[stage]}  -  ${formatModeLabel(mode, mode, { redDeath: options.redDeath, civBlitz: options.civBlitz, targetSize: options.targetSize })}`)
    .color(STAGE_COLORS[stage])

  const footerText = formatLeaderDataVersionFooter(leaderDataVersion, options.redDeath)
  return footerText ? embed.footer({ text: footerText }) : embed
}

function lobbyDraftCompleteLeaderEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  stage: Extract<LobbyStage, 'draft-complete' | 'cancelled' | 'scrubbed' | 'timeout'> = 'draft-complete',
  moderation?: ModerationContext,
  mapVoteResult?: ResolvedMapVoteResult | null,
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
  targetSize?: number,
  footerUser?: ReporterContext | null,
  leaderNameDataVersion?: LeaderDataVersion | null,
  civBlitz = false,
): Embed {
  const embed = baseLobbyEmbed(mode, stage, leaderDataVersion, { redDeath, civBlitz, targetSize })
  const resolvedLeaderDataVersion = leaderNameDataVersion ?? leaderDataVersion
  const hasTeams = participants.some(participant => participant.team != null)
  const moderationField = buildModerationField(moderation)
  const mapField = buildMapField(mapVoteResult)
  const userFooter = buildReporterFooter(footerUser)
  if (userFooter) embed.footer(userFooter)

  if (hasTeams) {
    const teamIndexes = Array.from(new Set(participants.flatMap(participant => participant.team == null ? [] : [participant.team]))).sort((a, b) => a - b)
    const teamFields = layoutTeamFields(teamIndexes.map((teamIndex) => {
      const teamParticipants = participants.filter(participant => participant.team === teamIndex)
      return {
        name: `Team ${String.fromCharCode(65 + teamIndex)}`,
        value: teamParticipants.map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId, resolvedLeaderDataVersion)}`).join('\n') || '`[empty]`',
        inline: true,
      }
    }))
    const fields = [mapField, moderationField, ...teamFields].filter((field): field is Exclude<typeof field, null> => field !== null)
    return embed.fields(...fields)
  }

  const lines = participants
    .map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId, resolvedLeaderDataVersion)}`)
    .join('\n')

  const playerField = { name: 'Players', value: lines || '`[empty]`', inline: false }
  const fields = [mapField, moderationField, playerField].filter((field): field is Exclude<typeof field, null> => field !== null)
  return embed.fields(...fields)
}

function buildMapField(mapVoteResult?: ResolvedMapVoteResult | null): { name: string, value: string, inline: false } | null {
  if (!mapVoteResult) return null
  return {
    name: 'Map',
    value: formatMapVoteResultLabel(mapVoteResult.mapType, mapVoteResult.mapScript) || '`[unknown]`',
    inline: false,
  }
}

const LEADERBOARD_UPDATE_TRACKED_PERCENT = 0.10
const LEADERBOARD_UPDATE_MIN_POSITIONS = 3

function lobbyReportedEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  moderation?: ModerationContext,
  options: { rankedRoleLines?: string[], reporter?: ReporterContext | null, mapVoteResult?: ResolvedMapVoteResult | null, leaderDataVersion?: LeaderDataVersion | null, unranked?: boolean } = {},
  redDeath = false,
  targetSize?: number,
  civBlitz = false,
): Embed {
  const embed = baseLobbyEmbed(mode, 'reported', options.leaderDataVersion, { redDeath, civBlitz, targetSize })
  const usesTeamRows = isTeamMode(mode) || participants.some(participant => participant.team != null)
  const description = usesTeamRows
    ? formatReportedTeamRows(participants, options.leaderDataVersion, options.unranked === true)
    : formatReportedFlatRows(participants, options.leaderDataVersion, options.unranked === true)
  const leaderboardUpdate = formatLeaderboardUpdate(participants)
  const rankedRoleUpdate = formatRankedRoleUpdate(options.rankedRoleLines)
  const moderationField = buildModerationField(moderation)
  const reporterFooter = buildReporterFooter(options.reporter)
  const mapField = buildMapField(options.mapVoteResult)

  embed.description(description || '`[empty]`')
  if (reporterFooter) embed.footer(reporterFooter)

  const fields = [
    mapField,
    moderationField,
    leaderboardUpdate ? { name: 'Leaderboard', value: leaderboardUpdate, inline: false } : null,
    rankedRoleUpdate ? { name: 'Ranked Roles', value: rankedRoleUpdate, inline: false } : null,
  ].filter((field): field is { name: string, value: string, inline: false } => field !== null)

  return fields.length > 0 ? embed.fields(...fields) : embed
}

function formatLeaderDataVersionFooter(leaderDataVersion?: LeaderDataVersion | null, redDeath = false): string | null {
  if (redDeath) return null
  if (!leaderDataVersion) return null
  if (!hasBetaLeaderData) return null
  return normalizeAvailableLeaderDataVersion(leaderDataVersion) === 'beta' ? 'BBG Beta' : 'BBG Live'
}

function formatReportedTeamRows(participants: LobbyParticipant[], leaderDataVersion?: LeaderDataVersion | null, unranked = false): string {
  const byTeam = new Map<number, LobbyParticipant[]>()

  for (const participant of participants) {
    if (participant.team == null) continue
    const teamParticipants = byTeam.get(participant.team) ?? []
    teamParticipants.push(participant)
    byTeam.set(participant.team, teamParticipants)
  }

  if (byTeam.size === 0) return ''

  const teams = [...byTeam.entries()]
    .map(([team, teamParticipants]) => ({
      team,
      placement: getTeamPlacement(teamParticipants),
      participants: [...teamParticipants].sort((a, b) => a.playerId.localeCompare(b.playerId)),
    }))
    .sort((a, b) => {
      const placementOrder = (a.placement ?? 99) - (b.placement ?? 99)
      if (placementOrder !== 0) return placementOrder
      return a.team - b.team
    })

  const lines: string[] = []

  teams.forEach((teamEntry, index) => {
    lines.push(`${formatPlacementCode(teamEntry.placement)} **${formatTeamName(teamEntry.team)}**`)

    for (const participant of teamEntry.participants) {
      lines.push(`\u00A0\u00A0\u00A0${formatReportedPlayerDetails(participant, leaderDataVersion, unranked)}`)
    }

    if (index < teams.length - 1) lines.push('')
  })

  return lines.join('\n')
}

function formatReportedFlatRows(participants: LobbyParticipant[], leaderDataVersion?: LeaderDataVersion | null, unranked = false): string {
  const ordered = [...participants].sort((a, b) => {
    const placementOrder = (a.placement ?? 99) - (b.placement ?? 99)
    if (placementOrder !== 0) return placementOrder
    return a.playerId.localeCompare(b.playerId)
  })

  return ordered
    .map((participant) => {
      return `${formatPlacementCode(participant.placement)} ${formatReportedPlayerDetails(participant, leaderDataVersion, unranked)}`
    })
    .join('\n')
}

function getTeamPlacement(participants: LobbyParticipant[]): number | null {
  let placement: number | null = null

  for (const participant of participants) {
    if (participant.placement == null) continue
    placement = placement == null ? participant.placement : Math.min(placement, participant.placement)
  }

  return placement
}

function formatTeamName(team: number): string {
  return `Team ${String.fromCharCode(65 + team)}`
}

function formatPlacementCode(placement: number | null | undefined): string {
  if (placement == null) return '`#? `'
  return `\`${`#${placement}`.padEnd(3, ' ')}\``
}

function formatReportedPlayerDetails(participant: LobbyParticipant, leaderDataVersion?: LeaderDataVersion | null, unranked = false): string {
  const rating = formatReportedRating(participant, unranked)
  return `${rating} <@${participant.playerId}> - ${formatLeaderName(participant.civId, leaderDataVersion)}`
}

function formatReportedRating(participant: LobbyParticipant, unranked = false): string {
  if (unranked) return formatUnrankedResultMarker(participant.placement)

  if (
    participant.ratingBeforeMu == null
    || participant.ratingBeforeSigma == null
    || participant.ratingAfterMu == null
    || participant.ratingAfterSigma == null
  ) {
    return '`   ?` ❔ `(   ?)`'
  }

  const before = resolvePublicRating(participant.publicRatingBefore, participant.ratingBeforeMu)
  const after = resolvePublicRating(participant.publicRatingAfter, participant.ratingAfterMu)

  return formatPublicRatingChange(before, after)
}

function formatLeaderboardUpdate(participants: LobbyParticipant[]): string | null {
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
          playerId: participant.playerId,
          before,
          after,
          gain: Number.MAX_SAFE_INTEGER,
        }
      }

      const gain = before - after
      if (gain <= 0 || trackedMaxRank < 1 || after > trackedMaxRank) return null

      return {
        playerId: participant.playerId,
        before,
        after,
        gain,
      }
    })
    .filter((entry): entry is { playerId: string, before: number | null, after: number, gain: number } => entry !== null)
    .sort((a, b) => (b.gain - a.gain) || (a.after - b.after))

  if (movers.length === 0) return null

  return movers
    .slice(0, 3)
    .map((move) => {
      if (move.before == null) return `🆕 <@${move.playerId}> entered at ${formatPlacementCode(move.after)}`
      return `⬆️ <@${move.playerId}> ${formatPlacementCode(move.before)} -> ${formatPlacementCode(move.after)}`
    })
    .join('\n')
}

function formatRankedRoleUpdate(lines: string[] | undefined): string | null {
  if (!lines || lines.length === 0) return null
  return lines.join('\n')
}

function buildReporterFooter(reporter?: ReporterContext | null): { text: string, icon_url?: string } | null {
  if (!reporter?.userId) return null

  const displayName = reporter.displayName?.trim() || null
  if (!displayName) return null
  const avatarUrl = reporter.avatarUrl?.trim() || undefined

  return {
    text: displayName,
    icon_url: avatarUrl,
  }
}

function formatLeaderName(civId: string | null, leaderDataVersion?: LeaderDataVersion | null): string {
  if (!civId) return '`[empty]`'
  try {
    const name = getLeader(civId, leaderDataVersion ?? 'live').name
    const emoji = leaderEmojiMention(civId)
    return emoji ? `${emoji} ${name}` : name
  }
  catch {
    return civId
  }
}

function layoutTeamFields(fields: TeamField[]): TeamField[] {
  if (fields.length !== 4) return fields

  return [
    fields[0]!,
    fields[1]!,
    blankInlineField(),
    fields[2]!,
    fields[3]!,
    blankInlineField(),
  ]
}

function blankInlineField(): TeamField {
  return { name: '\u200B', value: '\u200B', inline: true }
}

function buildModerationField(moderation?: ModerationContext): { name: string, value: string, inline: false } | null {
  if (!moderation) return null
  const reason = moderation.reason?.trim() || 'No reason.'
  const actor = moderation.actorId?.trim()
    ? `<@${moderation.actorId}>`
    : moderation.actorLabel?.trim() || 'System'
  return {
    name: 'Note',
    value: `${actor} - ${reason}`,
    inline: false,
  }
}

interface TeamField { name: string, value: string, inline: true }
