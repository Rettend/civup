import type { DraftSeat, GameMode } from '@civup/game'
import { isTeamMode } from '@civup/game'
import { Button, Components, Embed } from 'discord-hono'

const MODE_COLORS: Record<GameMode, number> = {
  'ffa': 0xF59E0B, // amber
  'duel': 0xEF4444, // red
  '2v2': 0x3B82F6, // blue
  '3v3': 0x8B5CF6, // purple
}

const MODE_LABELS: Record<GameMode, string> = {
  'ffa': 'Free For All',
  'duel': 'Duel (1v1)',
  '2v2': 'Team 2v2',
  '3v3': 'Team 3v3',
}

interface DraftReadyParams {
  mode: GameMode
  matchId: string
  seats: DraftSeat[]
  applicationId: string
}

export function draftReadyEmbed({ mode, matchId, seats }: DraftReadyParams): Embed {
  let playerList: string

  if (isTeamMode(mode)) {
    const teamA = seats.filter(s => s.team === 0)
    const teamB = seats.filter(s => s.team === 1)
    playerList = `**Team A**\n${teamA.map(s => `• <@${s.playerId}>`).join('\n')}\n\n**Team B**\n${teamB.map(s => `• <@${s.playerId}>`).join('\n')}`
  }
  else {
    playerList = seats.map((s, i) => `${i + 1}. <@${s.playerId}>`).join('\n')
  }

  return new Embed()
    .title(`🎮 Match Ready — ${MODE_LABELS[mode]}`)
    .description(`${playerList}\n\n**Match ID:** \`${matchId}\``)
    .color(MODE_COLORS[mode])
    .fields({
      name: 'Status',
      value: '⏳ Waiting for players to join the draft activity...',
      inline: false,
    })
    .footer({ text: 'Join a voice channel and click the activity button' })
    .timestamp(new Date().toISOString())
}

export function draftReadyComponents({ matchId, applicationId: _applicationId }: DraftReadyParams): Components {
  // Activity launcher button — the custom_id includes the matchId so we can
  // look up the room when the user clicks. The actual activity launch uses
  // Discord's embedded app SDK on the frontend.
  return new Components().row(
    new Button(
      'draft-activity',
      ['🎯', 'Open Draft Activity'],
      'Primary',
    ).custom_id(matchId),
  )
}
