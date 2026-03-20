import { createDb } from '@civup/db'
import { parseLeaderboardMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { rankedPreviewEmbeds } from '../embeds/ranked-preview.ts'
import { getEnabledLeaderboardModes, getRegisteredLeaderboardModeChoices, isLeaderboardModeEnabled } from '../services/game-modes.ts'
import { summarizeRankedPreview } from '../services/ranked/role-sync.ts'
import { createStateStore } from '../services/state/store.ts'
import { factory } from '../setup.ts'

const MODE_CHOICES = [
  { name: 'All', value: 'all' },
  ...getRegisteredLeaderboardModeChoices(),
] as const

interface Var {
  mode?: string
}

export const command_tiers = factory.command<Var>(
  new Command('tiers', 'View ranked role thresholds and live cutoffs').options(
    new Option('mode', 'Filter by leaderboard track').choices(...MODE_CHOICES),
  ),
  (c) => {
    const guildId = c.interaction.guild_id
    const mode = parseLeaderboardMode(c.var.mode)
    if (mode && !isLeaderboardModeEnabled(c.env, mode)) return c.res('That leaderboard track is not enabled on this deployment.')

    if (!guildId) return c.res('This command can only be used in a server.')

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const kv = createStateStore(c.env)
      const summary = await summarizeRankedPreview({
        db,
        kv,
        guildId,
        mode: mode ?? undefined,
      })

      const visibleModes = new Set(getEnabledLeaderboardModes(c.env))
      await c.followup({
        embeds: rankedPreviewEmbeds(mode
          ? summary
          : {
              ...summary,
              modes: summary.modes.filter(entry => visibleModes.has(entry.mode)),
            }),
      })
    })
  },
)
