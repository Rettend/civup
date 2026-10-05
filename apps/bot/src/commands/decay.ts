import { Command, Option } from 'discord-hono'
import { and, eq } from 'drizzle-orm'
import { createDb, players, seasonRatingStates } from '@civup/db'
import { playerDecayEmbed } from '../embeds/decay.ts'
import { getDivisionRankPolicy } from '../services/ranked/division-rank-runtime.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { loadPublicRatingDecayPolicy } from '../services/season/decay.ts'
import { getDisplaySeason } from '../services/season/index.ts'
import { factory } from '../setup.ts'
import { getIdentityByUserId } from './identity.ts'

export const command_decay = factory.command<{ player?: string }>(
  new Command('decay', 'Check your RP activity bank').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
  ),
  c => {
    const playerId = c.var.player ?? c.interaction.member?.user?.id ?? c.interaction.user?.id
    if (!playerId) return c.res('Could not identify the player.')
    return resDeferGeneralCommandResponse(
      c,
      async c => {
        const db = createDb(c.env.DB)
        const identity = getIdentityByUserId(c, playerId)
        const [season, policy, [player]] = await Promise.all([
          getDisplaySeason(db),
          loadPublicRatingDecayPolicy(db),
          db.select().from(players).where(eq(players.id, playerId)).limit(1),
        ])
        const ratings =
          season?.ratingSystem === 'rp' && season.publicReadsEnabled
            ? await db
                .select({
                  mode: seasonRatingStates.mode,
                  publicRating: seasonRatingStates.publicRating,
                  publicDecay: seasonRatingStates.publicDecay,
                })
                .from(seasonRatingStates)
                .where(and(eq(seasonRatingStates.seasonId, season.id), eq(seasonRatingStates.playerId, playerId)))
            : []
        const divisionPolicy = c.interaction.guild_id ? await getDivisionRankPolicy(db, c.interaction.guild_id) : null
        return {
          embeds: [
            playerDecayEmbed({
              displayName: identity?.displayName ?? player?.displayName ?? playerId,
              avatarUrl: identity?.avatarUrl ?? player?.avatarUrl,
              ratings,
              policy,
              season: season?.publicReadsEnabled ? season : null,
              now: Date.now(),
              modeOnly: divisionPolicy?.phase === 'active' && divisionPolicy.seasonId === season?.id,
            }),
          ],
        }
      },
      { ephemeral: !c.var.player },
    )
  },
)
