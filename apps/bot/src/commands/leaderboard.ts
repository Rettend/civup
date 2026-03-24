import { createDb } from '@civup/db'
import { LEADERBOARD_MODE_CHOICES, parseLeaderboardMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { ensureLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { createStateStore } from '../services/state/store.ts'
import { factory } from '../setup.ts'

interface Var {
  mode?: string
}

export const command_leaderboard = factory.command<Var>(
  new Command('leaderboard', 'Show the top players').options(
    new Option('mode', 'Leaderboard track')
      .choices(...LEADERBOARD_MODE_CHOICES),
  ),
  (c) => {
    const mode = parseLeaderboardMode(c.var.mode) ?? 'ffa'

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const kv = createStateStore(c.env)
      const snapshot = await ensureLeaderboardModeSnapshot(db, kv, mode)
      const embed = leaderboardEmbed(mode, snapshot.rows)
      await c.followup({ embeds: [embed] })
    })
  },
)
