import { Command } from 'discord-hono'
import { factory } from '../setup.ts'

export const command_ping = factory.command(
  new Command('ping', 'Check if the bot is alive'),
  (c) => {
    return c.resDefer(async (c) => {
      const startedAt = performance.now()
      await c.followup('🏛️ Pong! Measuring latency...')
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
      await c.followup(`🏛️ Pong! Bot is online. (${latencyMs} ms)`)
    })
  },
)
