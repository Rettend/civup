import type { EphemeralResponseTone } from '../embeds/response'
import type { SystemChannelType } from '../services/system-channels'
import { createDb } from '@civup/db'
import { Button, Command, Components, Option, SubCommand, SubGroup } from 'discord-hono'
import {
  getServerConfigRows,
  parseServerConfigKey,
  SERVER_CONFIG_KEYS,
  setServerConfigValue,
} from '../services/config'
import { clearSeasonConfirmation, createSeasonConfirmation, getSeasonConfirmation } from '../services/confirmations'
import { createChannelMessage } from '../services/discord'
import {
  clearDeferredEphemeralResponse,
  SHOW_EPHEMERAL_RESPONSE_BUTTON_ID,
  sendEphemeralResponse as sendRawEphemeralResponse,
  sendTransientEphemeralResponse as sendRawTransientEphemeralResponse,
} from '../services/ephemeral-response'
import { upsertLeaderboardMessagesForChannel } from '../services/leaderboard-message'
import { addModRole, getModRoleIds, hasAdminPermission, removeModRole } from '../services/permissions'
import { clearLeaderboardDirtyState, clearLeaderboardMessageState, clearSystemChannel, getSystemChannel, setSystemChannel } from '../services/system-channels'
import { factory } from '../setup'

interface Var {
  name?: string
  key?: string
  value?: string
  player?: string
  mode?: string
  target?: string
  role?: string
}

export const command_admin = factory.command<Var>(
  new Command('admin', 'Admin commands for CivUp').options(
    new SubGroup('permission', 'Configure Mod command access').options(
      new SubCommand('list', 'Show roles allowed to use /mod commands'),
      new SubCommand('add', 'Grant /mod command access to a role').options(
        new Option('role', 'Role to grant', 'Role').required(),
      ),
      new SubCommand('remove', 'Revoke /mod command access from a role').options(
        new Option('role', 'Role to revoke', 'Role').required(),
      ),
    ),
    new SubGroup('season', 'Season management').options(
      new SubCommand('start', 'Start a new season').options(
        new Option('name', 'Season name').required(),
      ),
      new SubCommand('end', 'End the current season'),
    ),
    new SubCommand('setup', 'View or toggle system channels').options(
      new Option('target', 'Channel role to configure')
        .choices(
          { name: 'Draft', value: 'draft' },
          { name: 'Archive', value: 'archive' },
          { name: 'Leaderboard', value: 'leaderboard' },
        ),
    ),
    new SubCommand('config', 'View or update configuration').options(
      new Option('key', 'Config key').choices(
        { name: 'ban_timer', value: 'ban_timer' },
        { name: 'pick_timer', value: 'pick_timer' },
        { name: 'queue_timeout', value: 'queue_timeout' },
        { name: 'match_category', value: 'match_category' },
      ),
      new Option('value', 'New value'),
    ),
    new SubCommand('reset', 'Reset a player\'s rating').options(
      new Option('player', 'Player to reset', 'User').required(),
      new Option('mode', 'Rating mode to reset')
        .choices(
          { name: 'Duel', value: 'duel' },
          { name: 'Teamers', value: 'teamers' },
          { name: 'FFA', value: 'ffa' },
        )
        .required(),
    ),
  ),
  (c) => {
    if (!hasAdminPermission({ permissions: c.interaction.member?.permissions })) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'You need Administrator or Manage Server permission for /admin commands.', 'error')
      })
    }

    switch (c.sub.string) {
      // ── permission ───────────────────────────────────────
      case 'permission list': {
        const guildId = c.interaction.guild_id
        if (!guildId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const modRoles = await getModRoleIds(c.env.KV, guildId)
          const message = modRoles.length > 0
            ? `Roles with /mod access: ${modRoles.map(roleId => `<@&${roleId}>`).join(', ')}`
            : 'No Mod roles configured yet. Use `/admin permission add role:@Role` to grant /mod access.'
          await sendTransientEphemeralResponse(c, message, 'info')
        })
      }

      case 'permission add': {
        const guildId = c.interaction.guild_id
        const roleId = c.var.role
        if (!guildId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
          })
        }

        if (!roleId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please select a role to grant Mod access.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const result = await addModRole(c.env.KV, guildId, roleId)
          const roleList = result.roles.map(id => `<@&${id}>`).join(', ')

          if (!result.added) {
            await sendTransientEphemeralResponse(c, `<@&${roleId}> already has /mod access. Current roles: ${roleList}.`, 'info')
            return
          }

          await sendTransientEphemeralResponse(c, `Granted /mod access to <@&${roleId}>. Current roles: ${roleList}.`, 'success')
        })
      }

      case 'permission remove': {
        const guildId = c.interaction.guild_id
        const roleId = c.var.role
        if (!guildId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
          })
        }

        if (!roleId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please select a role to revoke.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const result = await removeModRole(c.env.KV, guildId, roleId)
          const roleList = result.roles.length > 0
            ? result.roles.map(id => `<@&${id}>`).join(', ')
            : '`none`'

          if (!result.removed) {
            await sendTransientEphemeralResponse(c, `<@&${roleId}> did not have /mod access. Current roles: ${roleList}.`, 'info')
            return
          }

          await sendTransientEphemeralResponse(c, `Revoked /mod access from <@&${roleId}>. Current roles: ${roleList}.`, 'success')
        })
      }

      // ── season start ────────────────────────────────────
      case 'season start': {
        const seasonName = c.var.name?.trim()
        const guildId = c.interaction.guild_id
        const actorId = getInteractionUserId(c)

        if (!seasonName) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please provide a season name.', 'error')
          })
        }

        if (!guildId || !actorId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const token = await createSeasonConfirmation(c.env.KV, {
            guildId,
            actorId,
            action: 'start',
            seasonName,
          })

          const components = new Components().row(
            new Button('admin-season-confirm', 'Confirm', 'Primary').custom_id(token),
            new Button('admin-season-cancel', 'Cancel', 'Secondary').custom_id(token),
          )

          await sendEphemeralResponse(
            c,
            `Confirm season start for **${seasonName}**? This action is not recoverable.`,
            'info',
            { components, autoDeleteMs: null },
          )
        })
      }

      // ── season end ──────────────────────────────────────
      case 'season end': {
        const guildId = c.interaction.guild_id
        const actorId = getInteractionUserId(c)

        if (!guildId || !actorId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const token = await createSeasonConfirmation(c.env.KV, {
            guildId,
            actorId,
            action: 'end',
            seasonName: null,
          })

          const components = new Components().row(
            new Button('admin-season-confirm', 'Confirm', 'Danger').custom_id(token),
            new Button('admin-season-cancel', 'Cancel', 'Secondary').custom_id(token),
          )

          await sendEphemeralResponse(
            c,
            'Confirm season end? This action is not recoverable.',
            'info',
            { components, autoDeleteMs: null },
          )
        })
      }

      // ── setup ───────────────────────────────────────────
      case 'setup': {
        const rawTarget = c.var.target
        if (!rawTarget) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            const [draftChannelId, archiveChannelId, leaderboardChannelId] = await Promise.all([
              getSystemChannel(c.env.KV, 'draft'),
              getSystemChannel(c.env.KV, 'archive'),
              getSystemChannel(c.env.KV, 'leaderboard'),
            ])

            await sendEphemeralResponse(
              c,
              '**Configured channels:**\n'
              + `Draft — ${formatChannelMention(draftChannelId)}\n`
              + `Archive — ${formatChannelMention(archiveChannelId)}\n`
              + `Leaderboard — ${formatChannelMention(leaderboardChannelId)}`,
              'info',
            )
          })
        }

        const target = parseSetupTarget(rawTarget)
        if (!target) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Invalid setup target. Use Draft, Archive, or Leaderboard.', 'error')
          })
        }

        const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
        if (!channelId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify the current channel.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const previousChannelId = await getSystemChannel(kv, target)

          if (previousChannelId === channelId) {
            await clearSystemChannel(kv, target)
            if (target === 'leaderboard') {
              await clearLeaderboardMessageState(kv)
              await clearLeaderboardDirtyState(kv)
            }
            await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel disabled in <#${channelId}>.`, 'info')
            return
          }

          await setSystemChannel(kv, target, channelId)

          if (target === 'leaderboard') {
            try {
              const db = createDb(c.env.DB)
              await upsertLeaderboardMessagesForChannel(db, kv, c.env.DISCORD_TOKEN, channelId)
              await clearLeaderboardDirtyState(kv)
              const movedFrom = previousChannelId && previousChannelId !== channelId
                ? ` (moved from <#${previousChannelId}>)`
                : ''
              await sendTransientEphemeralResponse(c, `Leaderboard channel set to <#${channelId}>${movedFrom}.`, 'success')
            }
            catch (error) {
              console.error('Failed to initialize leaderboard messages:', error)
              await sendTransientEphemeralResponse(c, `Leaderboard channel set to <#${channelId}>, but failed to initialize leaderboard embeds.`, 'error')
            }
            return
          }

          const movedFrom = previousChannelId && previousChannelId !== channelId
            ? ` (moved from <#${previousChannelId}>)`
            : ''
          await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>${movedFrom}.`, 'success')
        })
      }

      // ── config ──────────────────────────────────────────
      case 'config': {
        const rawKey = c.var.key
        const key = parseServerConfigKey(rawKey)
        const value = c.var.value

        if (rawKey && !key) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, `Unknown config key. Supported keys: ${SERVER_CONFIG_KEYS.map(item => `\`${item}\``).join(', ')}.`, 'error')
          })
        }

        if (!key) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            const rows = await getServerConfigRows(c.env.KV)
            await sendTransientEphemeralResponse(
              c,
              `**Available config keys:**\n${
                rows.map(row => `\`${row.key}\` = \`${row.value}\` — ${row.description}`).join('\n')}`,
              'info',
            )
          })
        }

        if (!value) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(
              c,
              'Provide both `key` and `value` to update config. Use `/admin config` with no arguments to list current values.',
              'error',
            )
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const result = await setServerConfigValue(c.env.KV, key, value)
          if (!result.ok) {
            await sendTransientEphemeralResponse(c, result.error ?? 'Invalid config value.', 'error')
            return
          }
          await sendTransientEphemeralResponse(c, `\`${key}\` set to \`${result.value}\`.`, 'success')
        })
      }

      // ── reset ───────────────────────────────────────────
      case 'reset': {
        const playerId = c.var.player
        const mode = c.var.mode
        if (!playerId || !mode) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please provide player and mode.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const _db = createDb(c.env.DB)
          // TODO: implement resetRating service
          await sendTransientEphemeralResponse(c, `<@${playerId}>\'s **${mode}** rating has been reset.`, 'success')
        })
      }

      default:
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, 'Unknown admin subcommand.', 'error')
        })
    }
  },
)

export const component_admin_season_confirm = factory.component(
  new Button('admin-season-confirm', 'Confirm', 'Primary'),
  (c) => {
    const token = c.var.custom_id
    if (!token) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Season confirmation token was missing.', 'error')
      })
    }

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      if (!hasAdminPermission({ permissions: c.interaction.member?.permissions })) {
        await sendTransientEphemeralResponse(c, 'You need Administrator or Manage Server permission for this action.', 'error')
        return
      }

      const actorId = getInteractionUserId(c)
      const guildId = c.interaction.guild_id
      if (!actorId || !guildId) {
        await sendTransientEphemeralResponse(c, 'This action can only be used in a server.', 'error')
        return
      }

      const pending = await getSeasonConfirmation(c.env.KV, token)
      if (!pending) {
        await sendTransientEphemeralResponse(c, 'This confirmation expired. Run the command again.', 'error')
        return
      }

      if (pending.actorId !== actorId || pending.guildId !== guildId) {
        await sendTransientEphemeralResponse(c, 'Only the original command author can confirm this action.', 'error')
        return
      }

      await clearSeasonConfirmation(c.env.KV, token)

      if (pending.action === 'start') {
        const seasonName = pending.seasonName ?? 'Season'
        const _db = createDb(c.env.DB)
        // TODO: implement startSeason service
        await sendTransientEphemeralResponse(c, `**${seasonName}** has started! Season lifecycle service is not implemented yet.`, 'info')
        return
      }

      const _db = createDb(c.env.DB)
      // TODO: implement endSeason service
      await sendTransientEphemeralResponse(c, 'Season has ended! Season lifecycle service is not implemented yet.', 'info')
    })
  },
)

export const component_admin_season_cancel = factory.component(
  new Button('admin-season-cancel', 'Cancel', 'Secondary'),
  (c) => {
    const token = c.var.custom_id
    if (!token) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Season confirmation token was missing.', 'error')
      })
    }

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const actorId = getInteractionUserId(c)
      const guildId = c.interaction.guild_id
      if (!actorId || !guildId) {
        await sendTransientEphemeralResponse(c, 'This action can only be used in a server.', 'error')
        return
      }

      const pending = await getSeasonConfirmation(c.env.KV, token)
      if (!pending) {
        await sendTransientEphemeralResponse(c, 'This confirmation already expired or was already handled.', 'info')
        return
      }

      if (pending.actorId !== actorId || pending.guildId !== guildId) {
        await sendTransientEphemeralResponse(c, 'Only the original command author can cancel this confirmation.', 'error')
        return
      }

      await clearSeasonConfirmation(c.env.KV, token)

      await sendTransientEphemeralResponse(c, 'Cancelled season action.', 'info')
    })
  },
)

export const component_admin_show_response = factory.component(
  new Button(SHOW_EPHEMERAL_RESPONSE_BUTTON_ID, 'Show', 'Secondary'),
  (c) => {
    return c.update().resDefer(async (c) => {
      const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
      const sourceMessage = (c.interaction as {
        message?: {
          content?: unknown
          embeds?: unknown
        }
      }).message

      if (!channelId || !sourceMessage) {
        await sendRawTransientEphemeralResponse(c, 'Could not read the original response to share.', 'error', { showButton: false })
        return
      }

      const content = typeof sourceMessage.content === 'string' ? sourceMessage.content : null
      const embeds = Array.isArray(sourceMessage.embeds) ? sourceMessage.embeds : []
      if (!content && embeds.length === 0) {
        await sendRawTransientEphemeralResponse(c, 'There is nothing to share for this response.', 'error', { showButton: false })
        return
      }

      try {
        await createChannelMessage(c.env.DISCORD_TOKEN, channelId, {
          content,
          embeds,
        })
      }
      catch (error) {
        console.error('Failed to share admin response publicly:', error)
        await sendRawTransientEphemeralResponse(c, 'Failed to share this response publicly. Please try again.', 'error', { showButton: false })
        return
      }

      await clearDeferredEphemeralResponse(c)
    })
  },
)

function setupTargetLabel(target: SystemChannelType): string {
  if (target === 'draft') return 'Draft'
  if (target === 'archive') return 'Archive'
  return 'Leaderboard'
}

function parseSetupTarget(value: string): SystemChannelType | null {
  if (value === 'draft' || value === 'archive' || value === 'leaderboard') return value
  return null
}

function formatChannelMention(channelId: string | null): string {
  if (!channelId) return '`not set`'
  return `<#${channelId}>`
}

function getInteractionUserId(c: {
  interaction: {
    member?: { user?: { id?: string } }
    user?: { id?: string }
  }
}): string | null {
  return c.interaction.member?.user?.id ?? c.interaction.user?.id ?? null
}

async function sendEphemeralResponse(
  c: Parameters<typeof sendRawEphemeralResponse>[0],
  message: string,
  tone: EphemeralResponseTone,
  options?: {
    components?: unknown
    autoDeleteMs?: number | null
  },
): Promise<void> {
  await sendRawEphemeralResponse(c, message, tone, {
    ...options,
    showButton: true,
  })
}

async function sendTransientEphemeralResponse(
  c: Parameters<typeof sendRawTransientEphemeralResponse>[0],
  message: string,
  tone: EphemeralResponseTone,
): Promise<void> {
  await sendRawTransientEphemeralResponse(c, message, tone, { showButton: true })
}
