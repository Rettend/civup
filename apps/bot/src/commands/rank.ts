import { createDb } from '@civup/db'
import { Command, Option } from 'discord-hono'
import { rankEmbed } from '../embeds/rank.ts'
import { syncPlayerProfileFromDiscord } from '../services/player/profile.ts'
import { getPlayerRankProfile } from '../services/player/rank.ts'
import { getActiveSeason } from '../services/season/index.ts'
import { listPlayerSeasonSnapshotHistory } from '../services/season/snapshot-roles.ts'
import { factory } from '../setup.ts'

interface Var {
  player?: string
}

export const command_rank = factory.command<Var>(
  new Command('rank', 'View current ranked role data').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
  ),
  (c) => {
    const guildId = c.interaction.guild_id
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id

    if (!guildId) return c.res('This command can only be used in a server.')
    if (!targetId) return c.res('Could not identify the player.')

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      try {
        await syncPlayerProfileFromDiscord(db, c.env.DISCORD_TOKEN, targetId)
      }
      catch (error) {
        console.error(`Failed to sync player profile for ${targetId}:`, error)
      }

      const [profile, activeSeason, seasonHistory] = await Promise.all([
        getPlayerRankProfile(db, c.env.KV, guildId, targetId),
        getActiveSeason(db),
        listPlayerSeasonSnapshotHistory(db, c.env.KV, guildId, targetId),
      ])

      const embed = await rankEmbed(db, targetId, profile, {
        activeSeason,
        seasonHistory,
      })
      await c.followup({ embeds: [embed] })
    })
  },
)
