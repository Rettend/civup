import type { DraftCancelReason, DraftSeat, GameMode, QueueEntry } from '@civup/game'
import { getLeader } from '@civup/game'
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
}

interface ModerationContext {
  actorId: string
  reason?: string | null
}

export type LobbyStage = 'open' | 'drafting' | 'draft-complete' | 'reported' | 'cancelled' | 'scrubbed'

const MODE_LABELS: Record<GameMode, string> = {
  '1v1': '1v1',
  '2v2': '2v2',
  '3v3': '3v3',
  'ffa': 'FFA',
}

const STAGE_LABELS: Record<LobbyStage, string> = {
  'open': 'LOBBY OPEN',
  'drafting': 'DRAFT READY',
  'draft-complete': 'DRAFT COMPLETE',
  'reported': 'RESULT REPORTED',
  'cancelled': 'DRAFT CANCELLED',
  'scrubbed': 'MATCH SCRUBBED',
}

const STAGE_COLORS: Record<LobbyStage, number> = {
  'open': 0x2563EB,
  'drafting': 0x0EA5A4,
  'draft-complete': 0xD97706,
  'reported': 0x475569,
  'cancelled': 0x6B7280,
  'scrubbed': 0xA8B1BD,
}

export function lobbyOpenEmbed(mode: GameMode, entries: (QueueEntry | null)[], targetSize: number): Embed {
  const embed = baseLobbyEmbed(mode, 'open')

  if (mode === '1v1') {
    const p1 = entries[0]?.playerId
    const p2 = entries[1]?.playerId
    return embed.fields(
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
    )
  }

  if (mode === '2v2' || mode === '3v3') {
    const teamSize = targetSize / 2
    const teamALines = Array.from({ length: teamSize }, (_, i) => {
      const playerId = entries[i]?.playerId
      return `${i + 1}. ${playerId ? `<@${playerId}>` : '`[empty]`'}`
    }).join('\n')
    const teamBLines = Array.from({ length: teamSize }, (_, i) => {
      const playerId = entries[teamSize + i]?.playerId
      return `${i + 1}. ${playerId ? `<@${playerId}>` : '`[empty]`'}`
    }).join('\n')

    return embed.fields(
      { name: 'Team A', value: teamALines, inline: true },
      { name: 'Team B', value: teamBLines, inline: true },
    )
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

  return embed.fields(
    { name: 'Slots', value: firstColumn, inline: true },
    { name: 'Slots', value: secondColumn || '\u200B', inline: true },
  )
}

export function lobbyDraftingEmbed(mode: GameMode, seats: DraftSeat[]): Embed {
  const embed = baseLobbyEmbed(mode, 'drafting')
  const hasTeams = seats.some(seat => seat.team != null)

  if (hasTeams) {
    const teamA = seats.filter(seat => seat.team === 0)
    const teamB = seats.filter(seat => seat.team === 1)
    return embed.fields(
      {
        name: 'Team A',
        value: teamA.map((seat, i) => `${i + 1}. <@${seat.playerId}>`).join('\n') || '`[empty]`',
        inline: true,
      },
      {
        name: 'Team B',
        value: teamB.map((seat, i) => `${i + 1}. <@${seat.playerId}>`).join('\n') || '`[empty]`',
        inline: true,
      },
    )
  }

  const playerLines = seats.map((seat, i) => `${i + 1}. <@${seat.playerId}>`).join('\n')
  return embed.fields({ name: 'Slots', value: playerLines || '`[empty]`', inline: false })
}

export function lobbyDraftCompleteEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
): Embed {
  return lobbyDraftCompleteLeaderEmbed(mode, participants)
}

export function lobbyCancelledEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  reason: DraftCancelReason,
  moderation?: ModerationContext,
): Embed {
  const stage: 'cancelled' | 'scrubbed' = reason === 'cancel' ? 'cancelled' : 'scrubbed'
  return lobbyDraftCompleteLeaderEmbed(mode, participants, stage, moderation)
}

export function lobbyResultEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  moderation?: ModerationContext,
): Embed {
  return lobbyReportedEmbed(mode, participants, moderation)
}

export function lobbyComponents(mode: GameMode): Components {
  const label = 'Join'
  return new Components().row(
    new Button('lfg-join', label, 'Primary').custom_id(mode),
  )
}

function baseLobbyEmbed(mode: GameMode, stage: LobbyStage): Embed {
  return new Embed()
    .title(`${STAGE_LABELS[stage]}  -  ${MODE_LABELS[mode]}`)
    .color(STAGE_COLORS[stage])
}

function lobbyDraftCompleteLeaderEmbed(
  mode: GameMode,
  participants: LobbyParticipant[],
  stage: Extract<LobbyStage, 'draft-complete' | 'cancelled' | 'scrubbed'> = 'draft-complete',
  moderation?: ModerationContext,
): Embed {
  const embed = baseLobbyEmbed(mode, stage)
  const hasTeams = participants.some(participant => participant.team != null)
  const moderationField = buildModerationField(moderation)

  if (hasTeams) {
    const teamA = participants.filter(participant => participant.team === 0)
    const teamB = participants.filter(participant => participant.team === 1)

    const teamFields = [
      {
        name: 'Team A',
        value: teamA.map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId)}`).join('\n') || '`[empty]`',
        inline: true,
      },
      {
        name: 'Team B',
        value: teamB.map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId)}`).join('\n') || '`[empty]`',
        inline: true,
      },
    ]
    return moderationField ? embed.fields(moderationField, ...teamFields) : embed.fields(...teamFields)
  }

  const lines = participants
    .map((participant, index) => `${index + 1}. <@${participant.playerId}> - ${formatLeaderName(participant.civId)}`)
    .join('\n')

  const playerField = { name: 'Players', value: lines || '`[empty]`', inline: false }
  return moderationField ? embed.fields(moderationField, playerField) : embed.fields(playerField)
}

function lobbyReportedEmbed(mode: GameMode, participants: LobbyParticipant[], moderation?: ModerationContext): Embed {
  const embed = baseLobbyEmbed(mode, 'reported')
  const usesTeamRows = mode === '2v2' || mode === '3v3'
  const description = usesTeamRows
    ? formatReportedTeamRows(participants)
    : formatReportedFlatRows(participants)
  const leaderboardUpdate = formatLeaderboardUpdate(participants)
  const moderationField = buildModerationField(moderation)

  embed.description(description || '`[empty]`')

  if (!leaderboardUpdate) {
    if (!moderationField) return embed
    return embed.fields(moderationField)
  }

  const leaderboardField = { name: 'Leaderboard', value: leaderboardUpdate, inline: false }
  return moderationField ? embed.fields(moderationField, leaderboardField) : embed.fields(leaderboardField)
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
  if (team === 0) return 'Team A'
  if (team === 1) return 'Team B'
  return `Team ${team + 1}`
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
      if (gain <= 0) return null

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

function formatLeaderName(civId: string | null): string {
  if (!civId) return '`[pending]`'
  try {
    const name = getLeader(civId).name
    const emoji = leaderEmojiMention(civId)
    return emoji ? `${emoji} ${name}` : name
  }
  catch {
    return civId
  }
}

function buildModerationField(moderation?: ModerationContext): { name: string, value: string, inline: false } | null {
  if (!moderation) return null
  const reason = moderation.reason?.trim() || 'No reason.'
  return {
    name: 'Note',
    value: `<@${moderation.actorId}> - ${reason}`,
    inline: false,
  }
}
