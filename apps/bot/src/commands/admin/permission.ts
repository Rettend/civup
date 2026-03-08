import type { AdminCommandContext } from './types.ts'
import { addModRole, getModRoleIds, removeModRole } from '../../services/permissions.ts'
import { sendTransientEphemeralResponse } from './shared.ts'

export function handlePermissionList(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const modRoles = await getModRoleIds(c.env.KV, guildId)
    const message = modRoles.length > 0
      ? `Roles with /mod access: ${modRoles.map(roleId => `<@&${roleId}>`).join(', ')}`
      : 'No Mod roles configured yet. Use `/admin permission add role:@Role` to grant /mod access.'
    await sendTransientEphemeralResponse(c, message, 'info')
  })
}

export function handlePermissionAdd(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  const roleId = c.var.role
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  if (!roleId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Please select a role to grant Mod access.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const result = await addModRole(c.env.KV, guildId, roleId)
    const roleList = result.roles.map((id: string) => `<@&${id}>`).join(', ')

    if (!result.added) {
      await sendTransientEphemeralResponse(c, `<@&${roleId}> already has /mod access. Current roles: ${roleList}.`, 'info')
      return
    }

    await sendTransientEphemeralResponse(c, `Granted /mod access to <@&${roleId}>. Current roles: ${roleList}.`, 'success')
  })
}

export function handlePermissionRemove(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  const roleId = c.var.role
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  if (!roleId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Please select a role to revoke.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const result = await removeModRole(c.env.KV, guildId, roleId)
    const roleList = result.roles.length > 0
      ? result.roles.map((id: string) => `<@&${id}>`).join(', ')
      : '`none`'

    if (!result.removed) {
      await sendTransientEphemeralResponse(c, `<@&${roleId}> did not have /mod access. Current roles: ${roleList}.`, 'info')
      return
    }

    await sendTransientEphemeralResponse(c, `Revoked /mod access from <@&${roleId}>. Current roles: ${roleList}.`, 'success')
  })
}
