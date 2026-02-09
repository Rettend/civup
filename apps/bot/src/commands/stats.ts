import type { StatsModeFilter } from '../embeds/player-card.ts'
import { createDb } from '@civup/db'
import { Command, Option } from 'discord-hono'
import { playerCardEmbed } from '../embeds/player-card.ts'
import { syncPlayerProfileFromDiscord } from '../services/player-profile.ts'
import { factory } from '../setup.ts'

const MODE_CHOICES = [
  { name: 'All', value: 'all' },
  { name: 'FFA', value: 'ffa' },
  { name: '1v1', value: 'duel' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
] as const

interface Var {
  player?: string
  mode?: string
}

export const command_stats = factory.command<Var>(
  new Command('stats', 'View player stats and rating').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Filter by game mode').choices(...MODE_CHOICES),
  ),
  (c) => {
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const mode = (c.var.mode ?? 'all') as StatsModeFilter

    if (!targetId) return c.res('Could not identify the player.')

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      try {
        await syncPlayerProfileFromDiscord(db, c.env.DISCORD_TOKEN, targetId)
      }
      catch (error) {
        console.error(`Failed to sync player profile for ${targetId}:`, error)
      }

      const embed = await playerCardEmbed(db, targetId, mode)
      await c.followup({ embeds: [embed] })
    })
  },
)
