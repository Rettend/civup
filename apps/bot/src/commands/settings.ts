import { Button, Command, Components } from 'discord-hono'
import { ephemeralResponseEmbed } from '../embeds/response.ts'
import { resolveBrowserAccessConfig, resolveInteractionLaunchMode } from '../services/activity/browser-access.ts'
import { addGuildMemberRole, removeGuildMemberRole } from '../services/discord/index.ts'
import { getIdentity } from './identity.ts'
import { factory } from '../setup.ts'

const SETTINGS_ACTIVITY_BUTTON_ID = 'settings-open-activity'
const SETTINGS_BROWSER_BUTTON_ID = 'settings-open-browser'

export const command_settings = factory.command(
  new Command('settings', 'Choose how the draft launch buttons open'),
  async (c) => {
    return c.flags('EPHEMERAL').resDefer(async (deferred) => {
      await deferred.followup(await buildSettingsPanel(c.env, c.interaction.member?.roles))
    })
  },
)

export const component_settings_activity = factory.component(
  new Button(SETTINGS_ACTIVITY_BUTTON_ID, 'Discord Activity', 'Secondary'),
  async (c) => updateSettingsPreference(c, 'activity'),
)

export const component_settings_browser = factory.component(
  new Button(SETTINGS_BROWSER_BUTTON_ID, 'Web browser', 'Secondary'),
  async (c) => updateSettingsPreference(c, 'browser'),
)

export async function buildSettingsPanel(env: Parameters<typeof resolveInteractionLaunchMode>[0], memberRoles: unknown, error?: string) {
  const launch = await resolveInteractionLaunchMode(env, memberRoles)
  if (!launch.ok) return { embeds: [ephemeralResponseEmbed(error ?? launch.error, 'error')] }
  if (!launch.config) {
    return { embeds: [ephemeralResponseEmbed(error ?? 'Browser access is not available on this deployment.', 'info')] }
  }

  const currentLabel = launch.mode === 'browser' ? 'Web browser' : 'Discord Activity'
  return {
    embeds: [ephemeralResponseEmbed(error ?? `Current launch mode: **${currentLabel}**\n\nThe existing Join and Browse buttons will use this mode.`, error ? 'error' : 'info')],
    components: new Components().row(
      new Button(SETTINGS_ACTIVITY_BUTTON_ID, 'Discord Activity', launch.mode === 'activity' ? 'Primary' : 'Secondary'),
      new Button(SETTINGS_BROWSER_BUTTON_ID, 'Web browser', launch.mode === 'browser' ? 'Primary' : 'Secondary'),
    ),
  }
}

export async function updateSettingsPreference(c: any, mode: 'activity' | 'browser') {
  const identity = getIdentity(c)
  const guildId = c.interaction.guild_id
  const roles = c.interaction.member?.roles
  const config = await resolveBrowserAccessConfig(c.env)
  const allowedGuildId = c.env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? ''
  if (!identity || !guildId || (allowedGuildId && guildId !== allowedGuildId) || !Array.isArray(roles) || !config) {
    return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('Could not update this setting. Use `/settings` inside the configured server and try again.', 'error')] })
  }

  const hasRole = roles.includes(config.preferenceRoleId)
  if ((mode === 'browser') === hasRole) {
    return c.update().res(await buildSettingsPanel(c.env, roles))
  }

  return c.update().resDefer(async (deferred: any) => {
    try {
      if (mode === 'browser') {
        await addGuildMemberRole(c.env.DISCORD_TOKEN, guildId, identity.userId, config.preferenceRoleId)
      }
      else {
        await removeGuildMemberRole(c.env.DISCORD_TOKEN, guildId, identity.userId, config.preferenceRoleId)
      }

      const nextRoles = mode === 'browser'
        ? [...new Set([...roles, config.preferenceRoleId])]
        : roles.filter((roleId: unknown) => roleId !== config.preferenceRoleId)
      await deferred.followup(await buildSettingsPanel(c.env, nextRoles))
    }
    catch (error) {
      console.error('[settings] failed to update browser preference role', { guildId, userId: identity.userId, mode }, error)
      await deferred.followup(await buildSettingsPanel(c.env, roles, 'Discord could not update your launch mode. Please try again.'))
    }
  })
}
