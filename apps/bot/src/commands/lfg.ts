import type { GameMode } from '@civup/game'
import type { Embed } from 'discord-hono'
import { Button, Command, Option, SubCommand } from 'discord-hono'
import { lfgComponents, lfgEmbed } from '../embeds/lfg.ts'
import { addToQueue, getQueueState, removeFromQueue } from '../services/queue.ts'
import { factory } from '../setup.ts'

const GAME_MODE_CHOICES = [
  { name: 'FFA', value: 'ffa' },
  { name: 'Duel', value: 'duel' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
] as const

interface Var {
  mode?: string
  player?: string
}

// ── /lfg join [mode] ────────────────────────────────────────

export const command_lfg = factory.command<Var>(
  new Command('lfg', 'Looking for game — queue management').options(
    new SubCommand('join', 'Join the queue for a game mode').options(
      new Option('mode', 'Game mode to queue for')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
    new SubCommand('leave', 'Leave the current queue'),
    new SubCommand('status', 'Show all active queues'),
    new SubCommand('kick', 'Remove a player from the queue (admin)').options(
      new Option('player', 'Player to remove', 'User').required(),
    ),
  ),
  (c) => {
    switch (c.sub.string) {
      // ── join ────────────────────────────────────────────
      case 'join': {
        const mode = c.var.mode as GameMode
        const userId = c.interaction.member?.user?.id ?? c.interaction.user?.id
        const displayName = c.interaction.member?.user?.global_name
          ?? c.interaction.member?.user?.username
          ?? c.interaction.user?.global_name
          ?? c.interaction.user?.username
          ?? 'Unknown'

        if (!userId)
          return c.res('Could not identify you.')

        return c.resDefer(async (c) => {
          const kv = c.env.KV
          const result = await addToQueue(kv, mode, {
            playerId: userId,
            displayName,
            joinedAt: Date.now(),
          })

          if (result.error) {
            await c.followup(result.error)
            return
          }

          const queue = await getQueueState(kv, mode)
          await c.followup({
            content: `<@${userId}> joined the **${mode.toUpperCase()}** queue! (${queue.entries.length}/${queue.targetSize})`,
            embeds: [lfgEmbed(queue)],
            components: lfgComponents(mode),
          })
        })
      }

      // ── leave ───────────────────────────────────────────
      case 'leave': {
        const userId = c.interaction.member?.user?.id ?? c.interaction.user?.id
        if (!userId)
          return c.res('Could not identify you.')

        return c.resDefer(async (c) => {
          const kv = c.env.KV
          const removed = await removeFromQueue(kv, userId)

          if (!removed) {
            await c.followup('You are not in any queue.')
            return
          }

          await c.followup(`<@${userId}> left the **${removed.toUpperCase()}** queue.`)
        })
      }

      // ── status ──────────────────────────────────────────
      case 'status': {
        return c.resDefer(async (c) => {
          const kv = c.env.KV
          const modes: GameMode[] = ['ffa', 'duel', '2v2', '3v3']
          const embeds: Embed[] = []

          for (const mode of modes) {
            const queue = await getQueueState(kv, mode)
            if (queue.entries.length > 0) {
              embeds.push(lfgEmbed(queue))
            }
          }

          if (embeds.length === 0) {
            await c.followup('No active queues. Use `/lfg join` to start one!')
            return
          }

          await c.followup({ embeds })
        })
      }

      // ── kick ────────────────────────────────────────────
      case 'kick': {
        const targetId = c.var.player
        if (!targetId)
          return c.res('Please specify a player.')

        // Basic admin check — guild-level manage_guild permission
        const permissions = BigInt(c.interaction.member?.permissions ?? '0')
        const MANAGE_GUILD = 1n << 5n
        if ((permissions & MANAGE_GUILD) === 0n) {
          return c.flags('EPHEMERAL').res('You need Manage Server permission to kick from queue.')
        }

        return c.resDefer(async (c) => {
          const kv = c.env.KV
          const removed = await removeFromQueue(kv, targetId)

          if (!removed) {
            await c.followup(`<@${targetId}> is not in any queue.`)
            return
          }

          await c.followup(`<@${targetId}> was removed from the **${removed.toUpperCase()}** queue.`)
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
)

// ── LFG Button Handlers ─────────────────────────────────────

export const component_lfg_join = factory.component(
  new Button('lfg-join', 'Join Queue', 'Success'),
  (c) => {
    const mode = c.var.custom_id as GameMode | undefined
    const userId = c.interaction.member?.user?.id ?? c.interaction.user?.id
    const displayName = c.interaction.member?.user?.global_name
      ?? c.interaction.member?.user?.username
      ?? c.interaction.user?.global_name
      ?? c.interaction.user?.username
      ?? 'Unknown'

    if (!userId || !mode)
      return c.flags('EPHEMERAL').res('Something went wrong.')

    return c.resDefer(async (c) => {
      const kv = c.env.KV
      const result = await addToQueue(kv, mode, {
        playerId: userId,
        displayName,
        joinedAt: Date.now(),
      })

      if (result.error) {
        await c.followup(result.error)
        return
      }

      const queue = await getQueueState(kv, mode)
      await c.followup(`<@${userId}> joined! (${queue.entries.length}/${queue.targetSize})`)
    })
  },
)

export const component_lfg_leave = factory.component(
  new Button('lfg-leave', 'Leave Queue', 'Danger'),
  (c) => {
    const userId = c.interaction.member?.user?.id ?? c.interaction.user?.id
    if (!userId)
      return c.flags('EPHEMERAL').res('Something went wrong.')

    return c.resDefer(async (c) => {
      const kv = c.env.KV
      const removed = await removeFromQueue(kv, userId)

      if (!removed) {
        await c.followup('You are not in any queue.')
        return
      }

      await c.followup(`<@${userId}> left the **${removed.toUpperCase()}** queue.`)
    })
  },
)
