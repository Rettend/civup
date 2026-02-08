import type { GameMode, QueueState } from '@civup/game'
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

export function lfgEmbed(queue: QueueState): Embed {
  const playerList = queue.entries.length > 0
    ? queue.entries.map((e, i) => `${i + 1}. <@${e.playerId}>`).join('\n')
    : '*Empty — be the first to join!*'

  return new Embed()
    .title(`${MODE_LABELS[queue.mode]} — LFG Queue`)
    .description(playerList)
    .color(MODE_COLORS[queue.mode])
    .fields(
      {
        name: 'Players',
        value: `${queue.entries.length} / ${queue.targetSize}`,
        inline: true,
      },
      {
        name: 'Status',
        value: queue.entries.length >= queue.targetSize ? '🟢 Ready!' : '🟡 Waiting...',
        inline: true,
      },
    )
    .footer({ text: 'Use /lfg join to queue up' })
    .timestamp(new Date().toISOString())
}

export function lfgComponents(mode: GameMode): Components {
  return new Components().row(
    new Button('lfg-join', ['🎮', 'Join'], 'Success').custom_id(mode),
    new Button('lfg-leave', ['🚪', 'Leave'], 'Secondary').custom_id(mode),
  )
}
