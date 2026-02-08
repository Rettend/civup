/* eslint-disable no-console, antfu/no-top-level-await */
import process from 'node:process'
import { register } from 'discord-hono'
import * as commands from './commands/index.ts'
import { factory } from './setup.ts'

const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const DISCORD_TEST_GUILD_ID = process.env.DISCORD_TEST_GUILD_ID

if (!DISCORD_APPLICATION_ID || !DISCORD_TOKEN) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_TOKEN in environment')
  process.exit(1)
}

const allCommands = factory.getCommands(Object.values(commands))

console.log(`Registering ${allCommands.length} commands...`)
for (const cmd of allCommands) {
  console.log(`  /${(cmd as { name?: string }).name}`)
}

await register(
  allCommands,
  DISCORD_APPLICATION_ID,
  DISCORD_TOKEN,
  DISCORD_TEST_GUILD_ID, // omit for global registration
)

console.log('Done!')
