/* eslint-disable no-console, antfu/no-top-level-await */
import process from 'node:process'
import { register } from 'discord-hono'
import * as commands from './commands/index.ts'
import { factory } from './setup.ts'

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const registration = {
  applicationId: process.env.DISCORD_APPLICATION_ID?.trim() ?? '',
  guildId: process.env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? '',
}

if (!/^\d{17,20}$/.test(registration.applicationId) || !/^\d{17,20}$/.test(registration.guildId) || !DISCORD_TOKEN) {
  console.error('Registration requires a valid Discord application ID, guild ID, and DISCORD_TOKEN')
  process.exit(1)
}

const commandsForRegistration = factory.getCommands(Object.values(commands))

console.log(`Registering ${commandsForRegistration.length} commands...`)
for (const cmd of commandsForRegistration) {
  console.log(`  /${(cmd as { name?: string }).name}`)
}

await register(
  commandsForRegistration,
  registration.applicationId,
  DISCORD_TOKEN,
  registration.guildId,
)

console.log('Done!')
