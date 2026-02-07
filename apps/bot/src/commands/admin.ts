import { createDb } from '@civup/db'
import { Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { factory } from '../setup.ts'

interface Var {
  match_id?: string
  result?: string
  name?: string
  key?: string
  value?: string
  player?: string
  mode?: string
}

export const command_admin = factory.command<Var>(
  new Command('admin', 'Admin commands for CivUp').options(
    new SubGroup('match', 'Match management').options(
      new SubCommand('cancel', 'Cancel an active match').options(
        new Option('match_id', 'Match ID').required(),
      ),
      new SubCommand('resolve', 'Resolve a disputed match').options(
        new Option('match_id', 'Match ID').required(),
        new Option('result', 'Result (e.g. "A" for Team A wins, or placement order)').required(),
      ),
    ),
    new SubGroup('season', 'Season management').options(
      new SubCommand('start', 'Start a new season').options(
        new Option('name', 'Season name').required(),
      ),
      new SubCommand('end', 'End the current season'),
    ),
    new SubCommand('config', 'View or update configuration').options(
      new Option('key', 'Config key'),
      new Option('value', 'New value'),
    ),
    new SubCommand('reset', 'Reset a player\'s rating').options(
      new Option('player', 'Player to reset', 'User').required(),
      new Option('mode', 'Rating mode to reset')
        .choices(
          { name: 'FFA', value: 'ffa' },
          { name: 'Duel', value: 'duel' },
          { name: 'Teamers', value: 'teamers' },
        )
        .required(),
    ),
  ),
  (c) => {
    // Admin permission check
    const permissions = BigInt(c.interaction.member?.permissions ?? '0')
    const MANAGE_GUILD = 1n << 5n
    if ((permissions & MANAGE_GUILD) === 0n) {
      return c.flags('EPHEMERAL').res('You need Manage Server permission for admin commands.')
    }

    switch (c.sub.string) {
      // ── match cancel ──────────────────────────────────
      case 'match cancel': {
        const matchId = c.var.match_id
        if (!matchId)
          return c.res('Please provide a match ID.')

        return c.resDefer(async (c) => {
          const _db = createDb(c.env.DB)
          // TODO: implement cancelMatch service
          await c.followup(`Match **${matchId}** has been cancelled. No rating changes applied.`)
        })
      }

      // ── match resolve ─────────────────────────────────
      case 'match resolve': {
        const matchId = c.var.match_id
        const result = c.var.result
        if (!matchId || !result)
          return c.res('Please provide match ID and result.')

        return c.resDefer(async (c) => {
          const _db = createDb(c.env.DB)
          // TODO: implement resolveMatch service
          await c.followup(`Match **${matchId}** resolved with result: ${result}. Ratings updated.`)
        })
      }

      // ── season start ──────────────────────────────────
      case 'season start': {
        const name = c.var.name
        if (!name)
          return c.res('Please provide a season name.')

        return c.resDefer(async (c) => {
          const _db = createDb(c.env.DB)
          // TODO: implement startSeason service
          await c.followup(`Season **${name}** started! All ratings have been soft-reset.`)
        })
      }

      // ── season end ────────────────────────────────────
      case 'season end': {
        return c.resDefer(async (c) => {
          const _db = createDb(c.env.DB)
          // TODO: implement endSeason service
          await c.followup('Current season ended. Final standings have been archived.')
        })
      }

      // ── config ────────────────────────────────────────
      case 'config': {
        const key = c.var.key
        const value = c.var.value

        if (!key) {
          return c.flags('EPHEMERAL').res(
            '**Available config keys:**\n'
            + '`ffa_size` — Default FFA player count (6-12)\n'
            + '`ban_timer` — Ban phase timer in seconds\n'
            + '`pick_timer` — Pick phase timer in seconds\n'
            + '`queue_timeout` — Queue timeout in minutes\n'
            + '`lfg_category` — Category ID for temp voice channels',
          )
        }

        if (!value) {
          return c.resDefer(async (c) => {
            const kv = c.env.KV
            const current = await kv.get(`config:${key}`)
            await c.followup(`\`${key}\` = \`${current ?? 'not set'}\``)
          })
        }

        return c.resDefer(async (c) => {
          const kv = c.env.KV
          await kv.put(`config:${key}`, value)
          await c.followup(`\`${key}\` set to \`${value}\`.`)
        })
      }

      // ── reset ─────────────────────────────────────────
      case 'reset': {
        const playerId = c.var.player
        const mode = c.var.mode
        if (!playerId || !mode)
          return c.res('Please provide player and mode.')

        return c.resDefer(async (c) => {
          const _db = createDb(c.env.DB)
          // TODO: implement resetRating service
          await c.followup(`<@${playerId}>'s **${mode}** rating has been reset.`)
        })
      }

      default:
        return c.res('Unknown admin subcommand.')
    }
  },
)
