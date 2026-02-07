import { displayRating } from '@civup/rating'
import { Embed } from 'discord-hono'

interface MatchData {
  id: string
  gameMode: string
  status: string
  createdAt: number
  completedAt: number | null
}

interface ParticipantData {
  playerId: string
  team: number | null
  civId: string | null
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

const STATUS_ICONS: Record<string, string> = {
  drafting: '📋',
  active: '🎮',
  completed: '✅',
  cancelled: '❌',
}

export function matchEmbed(match: MatchData, participants: ParticipantData[]): Embed {
  const icon = STATUS_ICONS[match.status] ?? '❓'
  const embed = new Embed()
    .title(`${icon} Match ${match.id}`)
    .color(match.status === 'completed' ? 0x22C55E : match.status === 'cancelled' ? 0xEF4444 : 0x3B82F6)
    .fields(
      { name: 'Mode', value: match.gameMode.toUpperCase(), inline: true },
      { name: 'Status', value: match.status, inline: true },
    )

  // Group by team for team games, or list individually for FFA
  const hasTeams = participants.some(p => p.team !== null)

  if (hasTeams) {
    const teams: Record<number, ParticipantData[]> = {}
    for (const p of participants) {
      const team = p.team ?? 0
      if (!teams[team]) teams[team] = []
      teams[team]!.push(p)
    }

    for (const [teamIdx, teamPlayers] of Object.entries(teams)) {
      const teamLabel = Number(teamIdx) === 0 ? 'Team A' : 'Team B'
      const playerLines = teamPlayers.map(p => formatParticipant(p)).join('\n')
      embed.fields({ name: teamLabel, value: playerLines || 'No players', inline: true })
    }
  }
  else {
    // FFA — sort by placement
    const sorted = [...participants].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99))
    const lines = sorted.map(p => formatParticipant(p)).join('\n')
    embed.fields({ name: 'Players', value: lines || 'No players' })
  }

  if (match.completedAt) {
    embed.timestamp(new Date(match.completedAt).toISOString())
  }
  else {
    embed.timestamp(new Date().toISOString())
  }

  return embed
}

function formatParticipant(p: ParticipantData): string {
  let line = `<@${p.playerId}>`

  if (p.civId) {
    line += ` — ${p.civId}`
  }

  if (p.placement !== null) {
    line = `**#${p.placement}** ${line}`
  }

  if (p.ratingAfterMu !== null && p.ratingAfterSigma !== null
    && p.ratingBeforeMu !== null && p.ratingBeforeSigma !== null) {
    const before = displayRating(p.ratingBeforeMu, p.ratingBeforeSigma)
    const after = displayRating(p.ratingAfterMu, p.ratingAfterSigma)
    const delta = after - before
    const sign = delta >= 0 ? '+' : ''
    line += ` (${sign}${Math.round(delta)})`
  }

  return line
}
