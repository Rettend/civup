import { Command, Embed } from 'discord-hono'
import { sendTransientEphemeralResponse } from '../services/ephemeral-response'
import { canUseModCommands, hasAdminPermission, parseRoleIds } from '../services/permissions'
import { factory } from '../setup'

const MAX_HELP_DESCRIPTION_LENGTH = 3_800

interface DiscordApplicationCommandOption {
  type: number
  name: string
  description: string
  required?: boolean
  options?: DiscordApplicationCommandOption[]
}

interface DiscordApplicationCommand {
  type?: number
  name: string
  description: string
  options?: DiscordApplicationCommandOption[]
}

interface HelpEntry {
  root: string
  invocation: string
  description: string
}

export const command_help = factory.command(
  new Command('help', 'Show available CivUp commands'),
  async (c) => {
    const memberPermissions = c.interaction.member?.permissions
    const canUseAdmin = hasAdminPermission({ permissions: memberPermissions })

    const canUseMod = await canUseModCommands({
      kv: c.env.KV,
      guildId: c.interaction.guild_id,
      permissions: memberPermissions,
      roles: parseRoleIds(c.interaction.member?.roles),
    })

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      let commandDefs: DiscordApplicationCommand[]
      try {
        commandDefs = await fetchRegisteredCommands(
          c.env.DISCORD_TOKEN,
          c.env.DISCORD_APPLICATION_ID,
          c.interaction.guild_id,
        )
      }
      catch (error) {
        console.error('Failed to fetch command list for /help:', error)
        await sendTransientEphemeralResponse(c, 'Could not load command list right now. Please try again.', 'error')
        return
      }

      const allEntries = buildHelpEntries(commandDefs)
      const generalEntries = allEntries.filter((entry) => {
        if (entry.root === 'admin' || entry.root === 'mod') return false
        return true
      })

      const embeds: Embed[] = []
      if (canUseAdmin) {
        const adminEntries = allEntries.filter(entry => entry.root === 'admin')
        if (adminEntries.length > 0) embeds.push(helpGroupEmbed('Admin Commands', 0xDC2626, adminEntries))
      }

      if (canUseMod) {
        const modEntries = allEntries.filter(entry => entry.root === 'mod')
        if (modEntries.length > 0) embeds.push(helpGroupEmbed('Mod Commands', 0xD97706, modEntries))
      }

      if (generalEntries.length > 0) embeds.push(helpGroupEmbed('General Commands', 0x2563EB, generalEntries))

      if (embeds.length === 0) {
        await sendTransientEphemeralResponse(c, 'No commands available for your permissions in this context.', 'error')
        return
      }

      await c.followup({ embeds })
    })
  },
)

function helpGroupEmbed(title: string, color: number, entries: HelpEntry[]): Embed {
  const sortedEntries = [...entries].sort((a, b) => a.invocation.localeCompare(b.invocation))

  const lines: string[] = []
  let length = 0
  for (const entry of sortedEntries) {
    const line = `\`${entry.invocation}\` - ${entry.description || 'No description.'}`
    if (length + line.length + 1 > MAX_HELP_DESCRIPTION_LENGTH) {
      lines.push('...')
      break
    }
    lines.push(line)
    length += line.length + 1
  }

  return new Embed()
    .title(title)
    .color(color)
    .description(lines.join('\n') || 'No commands available.')
}

function buildHelpEntries(commands: DiscordApplicationCommand[]): HelpEntry[] {
  const byInvocation = new Map<string, HelpEntry>()

  for (const command of commands) {
    const type = command.type ?? 1

    if (type === 3) {
      const invocation = `Message: ${command.name}`
      byInvocation.set(invocation, {
        root: command.name.toLowerCase(),
        invocation,
        description: command.description || 'Message context command.',
      })
      continue
    }

    if (type !== 1) continue

    const options = command.options ?? []
    const hasNestedOptions = options.some(option => option.type === 1 || option.type === 2)

    if (!hasNestedOptions) {
      const invocation = buildSlashInvocation(command.name, options)
      byInvocation.set(invocation, {
        root: command.name,
        invocation,
        description: command.description,
      })
      continue
    }

    for (const option of options) {
      if (option.type === 1) {
        const invocation = buildSlashInvocation(`${command.name} ${option.name}`, option.options ?? [])
        byInvocation.set(invocation, {
          root: command.name,
          invocation,
          description: option.description,
        })
      }

      if (option.type === 2) {
        for (const subOption of option.options ?? []) {
          if (subOption.type !== 1) continue

          const invocation = buildSlashInvocation(
            `${command.name} ${option.name} ${subOption.name}`,
            subOption.options ?? [],
          )
          byInvocation.set(invocation, {
            root: command.name,
            invocation,
            description: subOption.description,
          })
        }
      }
    }
  }

  return [...byInvocation.values()]
}

function buildSlashInvocation(commandPath: string, options: DiscordApplicationCommandOption[]): string {
  const args = options
    .filter(option => option.type !== 1 && option.type !== 2)
    .map((option) => {
      const token = option.name.toLowerCase()
      return option.required ? `<${token}>` : `[${token}]`
    })
    .join(' ')

  return args.length > 0 ? `/${commandPath} ${args}` : `/${commandPath}`
}

async function fetchRegisteredCommands(
  token: string,
  applicationId: string,
  guildId?: string,
): Promise<DiscordApplicationCommand[]> {
  const urls = [
    guildId ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands` : null,
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
  ].filter((url): url is string => url !== null)

  const commandsByKey = new Map<string, DiscordApplicationCommand>()
  let successCount = 0
  let lastError: string | null = null

  for (const url of urls) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${token}`,
      },
    })

    if (!response.ok) {
      lastError = `HTTP ${response.status}`
      continue
    }

    successCount += 1
    const commands = await response.json() as DiscordApplicationCommand[]
    for (const command of commands) {
      const key = `${command.type ?? 1}:${command.name}`
      if (commandsByKey.has(key)) continue
      commandsByKey.set(key, command)
    }
  }

  if (successCount === 0) {
    throw new Error(lastError ?? 'Could not fetch command list from Discord API')
  }

  return [...commandsByKey.values()]
}
