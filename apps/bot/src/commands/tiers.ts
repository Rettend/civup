import { createDb } from '@civup/db'
import { LEADERBOARD_MODE_CHOICES, parseLeaderboardMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { rankedPreviewEmbeds } from '../embeds/ranked-preview.ts'
import { summarizeRankedPreview } from '../services/ranked/role-sync.ts'
import { createStateStore } from '../services/state/store.ts'
import { factory } from '../setup.ts'

const MODE_CHOICES = [
  { name: 'All', value: 'all' },
  ...LEADERBOARD_MODE_CHOICES,
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

      await c.followup({ embeds: rankedPreviewEmbeds(summary) })
    })
  },
)
