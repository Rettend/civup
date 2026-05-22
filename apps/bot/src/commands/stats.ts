import type { StatsModeFilter } from '../embeds/player-card.ts'
import { createDb } from '@civup/db'
import { GAME_MODE_CHOICES, LEADERBOARD_MODES, parseGameMode, toLeaderboardMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { playerCardEmbed } from '../embeds/player-card.ts'
import { teamCardEmbed } from '../embeds/team-card.ts'
import { getIdentityByUserId } from './identity.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { upsertPlayerProfiles } from '../services/player/profile.ts'
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
  teammate1?: string
  teammate2?: string
  teammate3?: string
  teammate4?: string
  teammate5?: string
}

export const command_stats = factory.command<Var>(
  new Command('stats', 'View player stats and rating').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Filter by game mode').choices(...MODE_CHOICES),
    new Option('teammate1', 'First teammate for lineup stats', 'User'),
    new Option('teammate2', 'Second teammate for lineup stats', 'User'),
    new Option('teammate3', 'Third teammate for lineup stats', 'User'),
    new Option('teammate4', 'Fourth teammate for lineup stats', 'User'),
    new Option('teammate5', 'Fifth teammate for lineup stats', 'User'),
  ),
  (c) => {
    const guildId = c.interaction.guild_id
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const teammateIds = [c.var.teammate1, c.var.teammate2, c.var.teammate3, c.var.teammate4, c.var.teammate5]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    const mode = (parseGameMode(c.var.mode) ?? 'all') as StatsModeFilter
    const isDefaultSelfLookup = !c.var.player && !c.var.mode && teammateIds.length === 0

    if (!targetId) return c.res('Could not identify the player.')
    const playerIds = [targetId, ...teammateIds]
    if (new Set(playerIds).size !== playerIds.length) {
      return c.res('Pick unique players for lineup stats.')
    }

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      const identities = new Map(playerIds.flatMap((playerId) => {
        const identity = getIdentityByUserId(c, playerId)
        return identity ? [[identity.userId, identity] as const] : []
      }))
      await upsertPlayerProfiles(db, [...identities.values()].map(identity => ({
        playerId: identity.userId,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
      })))

      if (teammateIds.length > 0) {
        const embed = await teamCardEmbed(db, kv, guildId ?? null, playerIds, mode)
        return { embeds: [embed] }
      }

      const rankProfile = guildId
        ? await getPlayerStatsRankProfile(db, kv, guildId, targetId)
        : null

      const visibleModes = mode === 'all'
        ? LEADERBOARD_MODES
        : (() => {
            const leaderboardMode = toLeaderboardMode(mode)
            return leaderboardMode ? [leaderboardMode] as const : LEADERBOARD_MODES
          })()

      const embed = await playerCardEmbed(db, targetId, mode, {
        rankProfile: rankProfile?.rankProfile ?? null,
        ratingRows: rankProfile?.ratingRows,
        visibleModes,
      })
      return { embeds: [embed] }
    }, {
      ephemeral: isDefaultSelfLookup,
    })
  },
)
