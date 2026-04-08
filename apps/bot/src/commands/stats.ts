import type { StatsModeFilter } from '../embeds/player-card.ts'
import { createDb } from '@civup/db'
import { GAME_MODE_CHOICES, parseGameMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { playerCardEmbed } from '../embeds/player-card.ts'
import { teamCardEmbed } from '../embeds/team-card.ts'
import { syncPlayerProfileFromDiscord } from '../services/player/profile.ts'
import { getPlayerRankProfile } from '../services/player/rank.ts'
import { createStateStore } from '../services/state/store.ts'
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
}

export const command_stats = factory.command<Var>(
  new Command('stats', 'View player stats and rating').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Filter by game mode').choices(...MODE_CHOICES),
    new Option('teammate1', 'First teammate for lineup stats', 'User'),
    new Option('teammate2', 'Second teammate for lineup stats', 'User'),
    new Option('teammate3', 'Third teammate for lineup stats', 'User'),
  ),
  (c) => {
    const guildId = c.interaction.guild_id
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const teammateIds = [c.var.teammate1, c.var.teammate2, c.var.teammate3]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    const mode = (parseGameMode(c.var.mode) ?? 'all') as StatsModeFilter

    if (!targetId) return c.res('Could not identify the player.')
    const playerIds = [targetId, ...teammateIds]
    if (new Set(playerIds).size !== playerIds.length) {
      return c.res('Pick unique players for lineup stats.')
    }

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const kv = createStateStore(c.env)
      c.executionCtx.waitUntil((async () => {
        await Promise.allSettled(playerIds.map(async (playerId) => {
          try {
            await syncPlayerProfileFromDiscord(db, c.env.DISCORD_TOKEN, playerId)
          }
          catch (error) {
            console.error(`Failed to sync player profile for ${playerId}:`, error)
          }
        }))
      })())

      if (teammateIds.length > 0) {
        const embed = await teamCardEmbed(db, kv, guildId ?? null, playerIds)
        await c.followup({ embeds: [embed] })
        return
      }

      const rankProfile = guildId
        ? await getPlayerRankProfile(db, kv, guildId, targetId)
        : null

      const embed = await playerCardEmbed(db, targetId, mode, { rankProfile })
      await c.followup({ embeds: [embed] })
    })
  },
)
