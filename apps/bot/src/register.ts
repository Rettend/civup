/* eslint-disable no-console */
import process from 'node:process'
import { register } from 'discord-hono'
import { resolveCloudflareTarget } from '../../../config/cloudflare-targets'
import * as commands from './commands/index.ts'
import { factory } from './setup.ts'

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const target = process.env.CIVUP_TARGET
  ? resolveCloudflareTarget(process.env.CIVUP_TARGET, { localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE })
  : undefined
const registration = {
  applicationId: target?.discord.applicationId ?? process.env.DISCORD_APPLICATION_ID?.trim() ?? '',
  guildId: target?.discord.guildId ?? process.env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? '',
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

const result = await register(commandsForRegistration, registration.applicationId, DISCORD_TOKEN, registration.guildId)

// discord-hono returns its log text even when Discord rejects registration.
if (result !== '===== ✅ Success =====') process.exitCode = 1
else console.log('Done!')
