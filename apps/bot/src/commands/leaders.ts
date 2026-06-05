import type { LeadersModeFilter } from '../embeds/player-leaders.ts'
import { createDb } from '@civup/db'
import { GAME_MODE_CHOICES, LEADERBOARD_MODES, parseGameMode, toLeaderboardMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { playerLeadersEmbed } from '../embeds/player-leaders.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { syncPlayerProfileFromDiscord } from '../services/player/profile.ts'
import { getPlayerStatsRankProfile } from '../services/player/rank.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { factory } from '../setup.ts'

const MODE_CHOICES = [
  { name: 'All', value: 'all' },
  ...GAME_MODE_CHOICES,
] as const

interface Var {
  player?: string
  mode?: string
}

export const command_leaders = factory.command<Var>(
  new Command('leaders', 'View player leader stats').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Filter by game mode').choices(...MODE_CHOICES),
  ),
  (c) => {
    const guildId = c.interaction.guild_id
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const mode = (parseGameMode(c.var.mode) ?? 'all') as LeadersModeFilter

    if (!targetId) return c.res('Could not identify the player.')

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      c.executionCtx.waitUntil((async () => {
        try {
          await syncPlayerProfileFromDiscord(db, c.env.DISCORD_TOKEN, targetId)
        }
        catch (error) {
          console.error(`Failed to sync player profile for ${targetId}:`, error)
        }
      })())

      const rankProfile = guildId
        ? await getPlayerStatsRankProfile(db, kv, guildId, targetId)
        : null
      const visibleModes = mode === 'all'
        ? LEADERBOARD_MODES
        : (() => {
            const leaderboardMode = toLeaderboardMode(mode)
            return leaderboardMode ? [leaderboardMode] as const : LEADERBOARD_MODES
          })()

      const embed = await playerLeadersEmbed(db, targetId, mode, {
        rankProfile: rankProfile?.rankProfile ?? null,
        ratingRows: rankProfile?.ratingRows,
        visibleModes,
      })
      return { embeds: [embed] }
    })
  },
)
