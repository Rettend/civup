import type { DraftCancelReason, DraftSeat, GameMode, LeaderDataVersion, QueueEntry } from '@civup/game'
import { formatModeLabel, getLeader, isTeamMode, teamSize as modeTeamSize } from '@civup/game'
import { displayRating } from '@civup/rating'
import { Button, Components, Embed } from 'discord-hono'
import { leaderEmojiMention } from '../constants/leader-emojis.ts'

interface LobbyParticipant {
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
}

interface ModerationContext {
  actorId?: string | null
  actorLabel?: string | null
  reason?: string | null
}

export type LobbyStage = 'open' | 'drafting' | 'draft-complete' | 'reported' | 'cancelled' | 'scrubbed' | 'timeout'

const STAGE_LABELS: Record<LobbyStage, string> = {
  'open': 'LOBBY OPEN',
  'drafting': 'DRAFTING',
  'draft-complete': 'DRAFT COMPLETE',
  'reported': 'RESULT REPORTED',
  'cancelled': 'DRAFT CANCELLED',
  'scrubbed': 'MATCH SCRUBBED',
  'timeout': 'LOBBY TIMEOUT',
}

const STAGE_COLORS: Record<LobbyStage, number> = {
  'open': 0x2563EB,
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
): Embed {
  const embed = baseLobbyEmbed(mode, 'open', leaderDataVersion, redDeath)
  const rankFields = [
    minRoleId ? { name: 'Min Rank', value: `<@&${minRoleId}>`, inline: true } : null,
    maxRoleId ? { name: 'Max Rank', value: `<@&${maxRoleId}>`, inline: true } : null,
  ].flatMap(field => field ? [field] : [])

  while (rankFields.length > 0 && rankFields.length % 3 !== 0) rankFields.push(blankInlineField())

  if (mode === '1v1') {
    const p1 = entries[0]?.playerId
    const p2 = entries[1]?.playerId
    const fields = [
      {
        name: 'Team A',
        value: `1. ${p1 ? `<@${p1}>` : '`[empty]`'}`,
        inline: true,
      },
      {
        name: 'Team B',
        value: `1. ${p2 ? `<@${p2}>` : '`[empty]`'}`,
        inline: true,
      },
    ]
    return rankFields.length > 0 ? embed.fields(...rankFields, ...fields) : embed.fields(...fields)
  }

  if (isTeamMode(mode)) {
    const teamSize = modeTeamSize(mode) ?? 1
    const totalTeams = Math.max(1, Math.floor(targetSize / teamSize))
    const fields = layoutTeamFields(Array.from({ length: totalTeams }, (_, teamIndex) => {
      const teamLines = Array.from({ length: teamSize }, (_, index) => {
        const playerId = entries[(teamIndex * teamSize) + index]?.playerId
        return `${index + 1}. ${playerId ? `<@${playerId}>` : '`[empty]`'}`
      }).join('\n')

      return {
        name: `Team ${String.fromCharCode(65 + teamIndex)}`,
        value: teamLines,
        inline: true,
      }
    }))
    return rankFields.length > 0 ? embed.fields(...rankFields, ...fields) : embed.fields(...fields)
  }

  const half = Math.ceil(targetSize / 2)
  const firstColumn = Array.from({ length: half }, (_, i) => {
    const playerId = entries[i]?.playerId
    return `${i + 1}. ${playerId ? `<@${playerId}>` : '`[empty]`'}`
  }).join('\n')
  const secondColumn = Array.from({ length: targetSize - half }, (_, i) => {
    const seat = half + i
    const playerId = entries[seat]?.playerId
    return `${seat + 1}. ${playerId ? `<@${playerId}>` : '`[empty]`'}`
  }).join('\n')

  const fields = [
    { name: 'Slots', value: firstColumn, inline: true },
    { name: 'Slots', value: secondColumn || '\u200B', inline: true },
  ]
  return rankFields.length > 0 ? embed.fields(...rankFields, ...fields) : embed.fields(...fields)
}

export function lobbyDraftingEmbed(mode: GameMode, seats: DraftSeat[], leaderDataVersion?: LeaderDataVersion | null, redDeath = false): Embed {
  const embed = baseLobbyEmbed(mode, 'drafting', leaderDataVersion, redDeath)
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
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
): Embed {
  return lobbyDraftCompleteLeaderEmbed(mode, participants, 'draft-complete', undefined, leaderDataVersion, redDeath)
}

export function lobbyCancelledEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  reason: DraftCancelReason,
  moderation?: ModerationContext,
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
): Embed {
  const stage: 'cancelled' | 'scrubbed' = reason === 'cancel' ? 'cancelled' : 'scrubbed'
  return lobbyDraftCompleteLeaderEmbed(
    mode,
    participants,
    stage,
    moderation,
    stage === 'scrubbed' ? undefined : leaderDataVersion,
    redDeath,
  )
}

export function lobbyTimeoutEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
): Embed {
  return lobbyDraftCompleteLeaderEmbed(mode, participants, 'timeout', undefined, leaderDataVersion, redDeath)
}

export function lobbyResultEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  moderation?: ModerationContext,
  options: { rankedRoleLines?: string[] } = {},
  redDeath = false,
): Embed {
  return lobbyReportedEmbed(mode, participants, moderation, options, redDeath)
}

export function lobbyComponents(mode: GameMode, lobbyId?: string): Components {
  const label = 'Join'
  return new Components().row(
    new Button('match-join', label, 'Primary').custom_id(lobbyId ? `${mode}:${lobbyId}` : mode),
  )
}

function baseLobbyEmbed(mode: GameMode, stage: LobbyStage, leaderDataVersion?: LeaderDataVersion | null, redDeath = false): Embed {
  const embed = new Embed()
    .title(`${STAGE_LABELS[stage]}  -  ${formatModeLabel(mode, mode, { redDeath }).toUpperCase()}`)
    .color(STAGE_COLORS[stage])

  const footerText = formatLeaderDataVersionFooter(leaderDataVersion, redDeath)
  return footerText ? embed.footer({ text: footerText }) : embed
}

function lobbyDraftCompleteLeaderEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  stage: Extract<LobbyStage, 'draft-complete' | 'cancelled' | 'scrubbed' | 'timeout'> = 'draft-complete',
  moderation?: ModerationContext,
  leaderDataVersion?: LeaderDataVersion | null,
  redDeath = false,
): Embed {
  const embed = baseLobbyEmbed(mode, stage, leaderDataVersion, redDeath)
  const hasTeams = participants.some(participant => participant.team != null)
  const moderationField = buildModerationField(moderation)

  if (hasTeams) {
    const teamIndexes = Array.from(new Set(participants.flatMap(participant => participant.team == null ? [] : [participant.team]))).sort((a, b) => a - b)
    const teamFields = layoutTeamFields(teamIndexes.map((teamIndex) => {
      const teamParticipants = participants.filter(participant => participant.team === teamIndex)
      return {
        name: `Team ${String.fromCharCode(65 + teamIndex)}`,
        value: teamParticipants.map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId)}`).join('\n') || '`[empty]`',
        inline: true,
      }
    }))
    return moderationField ? embed.fields(moderationField, ...teamFields) : embed.fields(...teamFields)
  }

  const lines = participants
    .map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId)}`)
    .join('\n')

  const playerField = { name: 'Players', value: lines || '`[empty]`', inline: false }
  return moderationField ? embed.fields(moderationField, playerField) : embed.fields(playerField)
}

const LEADERBOARD_UPDATE_TRACKED_PERCENT = 0.10
const LEADERBOARD_UPDATE_MIN_POSITIONS = 3

function lobbyReportedEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  moderation?: ModerationContext,
  options: { rankedRoleLines?: string[] } = {},
  redDeath = false,
): Embed {
  const embed = baseLobbyEmbed(mode, 'reported', undefined, redDeath)
  const usesTeamRows = isTeamMode(mode)
  const description = usesTeamRows
    ? formatReportedTeamRows(participants)
    : formatReportedFlatRows(participants)
  const leaderboardUpdate = formatLeaderboardUpdate(participants)
  const rankedRoleUpdate = formatRankedRoleUpdate(options.rankedRoleLines)
  const moderationField = buildModerationField(moderation)

  embed.description(description || '`[empty]`')

  const fields = [
    moderationField,
    leaderboardUpdate ? { name: 'Leaderboard', value: leaderboardUpdate, inline: false } : null,
    rankedRoleUpdate ? { name: 'Rank Roles', value: rankedRoleUpdate, inline: false } : null,
  ].filter((field): field is { name: string, value: string, inline: false } => field !== null)

  return fields.length > 0 ? embed.fields(...fields) : embed
}

function formatLeaderDataVersionFooter(leaderDataVersion?: LeaderDataVersion | null, redDeath = false): string | null {
  if (redDeath) return null
  if (!leaderDataVersion) return null
  return leaderDataVersion === 'beta' ? 'BBG Beta' : 'BBG Live'
}

function formatReportedTeamRows(participants: LobbyParticipant[]): string {
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
      lines.push(`\u00A0\u00A0\u00A0${formatReportedPlayerDetails(participant)}`)
    }

    if (index < teams.length - 1) lines.push('')
  })

  return lines.join('\n')
}

function formatReportedFlatRows(participants: LobbyParticipant[]): string {
  const ordered = [...participants].sort((a, b) => {
    const placementOrder = (a.placement ?? 99) - (b.placement ?? 99)
    if (placementOrder !== 0) return placementOrder
    return a.playerId.localeCompare(b.playerId)
  })

  return ordered
    .map((participant) => {
      return `${formatPlacementCode(participant.placement)} ${formatReportedPlayerDetails(participant)}`
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

function formatReportedPlayerDetails(participant: LobbyParticipant): string {
  const rating = formatReportedRating(participant)
  return `${rating} <@${participant.playerId}> - ${formatLeaderName(participant.civId)}`
}

function formatReportedRating(participant: LobbyParticipant): string {
  if (
    participant.ratingBeforeMu == null
    || participant.ratingBeforeSigma == null
    || participant.ratingAfterMu == null
    || participant.ratingAfterSigma == null
  ) {
    return '`   ?` ❔ `(   ?)`'
  }

  const before = displayRating(participant.ratingBeforeMu, participant.ratingBeforeSigma)
  const after = displayRating(participant.ratingAfterMu, participant.ratingAfterSigma)
  const delta = Math.round(after - before)
  const deltaText = `${delta >= 0 ? '+' : ''}${delta}`.padStart(3, ' ')
  const trendEmoji = delta >= 0 ? '📈' : '📉'
  const updatedElo = `(${String(Math.round(after)).padStart(4, ' ')})`

  return `\`${deltaText}\` ${trendEmoji} \`${updatedElo}\``
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

function formatLeaderName(civId: string | null): string {
  if (!civId) return '`[empty]`'
  try {
    const name = getLeader(civId).name
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
