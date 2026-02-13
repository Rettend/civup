import type { LeaderboardMode } from '@civup/game'
import { createDb } from '@civup/db'
import { Command, Option } from 'discord-hono'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { factory } from '../setup.ts'

const MODE_CHOICES = [
  { name: 'Duel', value: 'duel' },
  { name: 'Teamers', value: 'teamers' },
  { name: 'FFA', value: 'ffa' },
] as const

interface Var {
  mode?: string
}

export const command_leaderboard = factory.command<Var>(
  new Command('leaderboard', 'Show the top players').options(
    new Option('mode', 'Leaderboard track')
      .choices(...MODE_CHOICES),
  ),
  (c) => {
    const mode = (c.var.mode ?? 'ffa') as LeaderboardMode

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const embed = await leaderboardEmbed(db, mode)
      await c.followup({ embeds: [embed] })
    })
  },
)
