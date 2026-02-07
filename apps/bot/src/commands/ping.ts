import { Command } from 'discord-hono'
import { factory } from '../setup.ts'

export const command_ping = factory.command(
  new Command('ping', 'Check if the bot is alive'),
  c => c.res('🏛️ Pong! CivUp is online.'),
)
