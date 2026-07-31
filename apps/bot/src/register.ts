/* eslint-disable no-console, antfu/no-top-level-await */
import process from 'node:process'
import { resolveApprovedDiscordGuildConfiguration } from '@civup/utils'
import { register } from 'discord-hono'
import * as commands from './commands/index.ts'
import { factory } from './setup.ts'

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim() ?? ''
const guildConfig = resolveApprovedDiscordGuildConfiguration({
  ALLOWED_DISCORD_GUILD_ID: process.env.ALLOWED_DISCORD_GUILD_ID,
  ALLOWED_DISCORD_GUILD_IDS: process.env.ALLOWED_DISCORD_GUILD_IDS,
})
const guildIds = guildConfig.ok ? guildConfig.guildIds : []

if (!/^\d{17,20}$/.test(applicationId) || guildIds.length === 0 || !DISCORD_TOKEN) {
  console.error(`Registration requires a valid Discord application ID, approved guild config, and DISCORD_TOKEN${guildConfig.ok ? '' : ` (${guildConfig.error})`}`)
  process.exit(1)
}

const commandsForRegistration = factory.getCommands(Object.values(commands))

console.log(`Registering ${commandsForRegistration.length} commands in ${guildIds.length} guild(s)...`)
for (const cmd of commandsForRegistration) {
  console.log(`  /${(cmd as { name?: string }).name}`)
}

for (const guildId of guildIds) {
  console.log(`Guild ${guildId}`)
  await register(commandsForRegistration, applicationId, DISCORD_TOKEN, guildId)
}

console.log('Done!')
