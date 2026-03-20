import { createDb } from '@civup/db'
import { parseLeaderboardMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { getDefaultEnabledLeaderboardMode, getRegisteredLeaderboardModeChoices, isLeaderboardModeEnabled } from '../services/game-modes.ts'
import { ensureLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { createStateStore } from '../services/state/store.ts'
import { factory } from '../setup.ts'

const LEADERBOARD_CHOICES = getRegisteredLeaderboardModeChoices()

interface Var {
  mode?: string
}

export const command_leaderboard = factory.command<Var>(
  new Command('leaderboard', 'Show the top players').options(
    new Option('mode', 'Leaderboard track')
      .choices(...LEADERBOARD_CHOICES),
  ),
  (c) => {
    const requestedMode = parseLeaderboardMode(c.var.mode)
    if (requestedMode && !isLeaderboardModeEnabled(c.env, requestedMode)) {
      return c.res('That leaderboard track is not enabled on this deployment.')
    }

    const mode = requestedMode ?? getDefaultEnabledLeaderboardMode(c.env)

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const kv = createStateStore(c.env)
      const snapshot = await ensureLeaderboardModeSnapshot(db, kv, mode)
      const embed = leaderboardEmbed(mode, snapshot.rows)
      await c.followup({ embeds: [embed] })
    })
  },
)
