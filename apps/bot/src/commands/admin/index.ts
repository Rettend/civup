import type { AdminVar } from './types.ts'
import { LEADERBOARD_MODE_CHOICES } from '@civup/game'
import { Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { hasAdminPermission } from '../../services/permissions/index.ts'
import { factory } from '../../setup.ts'
import { component_admin_show_response } from './components.ts'
import { handleConfig } from './config.ts'
import { handlePermissionAdd, handlePermissionList, handlePermissionRemove } from './permission.ts'
import { handleRankedPreview, handleRankedRoles, handleRankedSync, handleReset } from './ranked.ts'
import { component_admin_season_cancel, component_admin_season_confirm, handleSeasonEnd, handleSeasonStart } from './season.ts'
import { handleSetup } from './setup.ts'
import { sendTransientEphemeralResponse } from './shared.ts'

export const command_admin = factory.command<AdminVar>(
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
      new SubCommand('start', 'Start a new season'),
      new SubCommand('end', 'End the current season'),
    ),
    new SubGroup('ranked', 'Ranked commands').options(
      new SubCommand('roles', 'Show or update current ranked role mappings').options(
        new Option('count', 'How many ranked roles to use (3-10)'),
        new Option('role1', 'Ranked role 1 (highest)', 'Role'),
        new Option('role2', 'Ranked role 2', 'Role'),
        new Option('role3', 'Ranked role 3', 'Role'),
        new Option('role4', 'Ranked role 4', 'Role'),
        new Option('role5', 'Ranked role 5', 'Role'),
        new Option('role6', 'Ranked role 6', 'Role'),
        new Option('role7', 'Ranked role 7', 'Role'),
        new Option('role8', 'Ranked role 8', 'Role'),
        new Option('role9', 'Ranked role 9', 'Role'),
        new Option('role10', 'Ranked role 10 (lowest if used)', 'Role'),
      ),
      new SubCommand('preview', 'Preview current ranked role assignments'),
      new SubCommand('sync', 'Compute and apply current ranked role assignments'),
    ),
    new SubCommand('setup', 'View or toggle system channels').options(
      new Option('target', 'Channel role to configure').choices(
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
      new Option('mode', 'Rating mode to reset').choices(...LEADERBOARD_MODE_CHOICES).required(),
    ),
  ),
  (c) => {
    if (!hasAdminPermission({ permissions: c.interaction.member?.permissions })) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'You need Administrator or Manage Server permission for /admin commands.', 'error')
      })
    }

    if (c.sub.string === 'permission list') return handlePermissionList(c)
    if (c.sub.string === 'permission add') return handlePermissionAdd(c)
    if (c.sub.string === 'permission remove') return handlePermissionRemove(c)
    if (c.sub.string === 'season start') return handleSeasonStart(c)
    if (c.sub.string === 'season end') return handleSeasonEnd(c)
    if (c.sub.string === 'ranked roles') return handleRankedRoles(c)
    if (c.sub.string === 'ranked preview') return handleRankedPreview(c)
    if (c.sub.string === 'ranked sync') return handleRankedSync(c)
    if (c.sub.string === 'setup') return handleSetup(c)
    if (c.sub.string === 'config') return handleConfig(c)
    if (c.sub.string === 'reset') return handleReset(c)

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      await sendTransientEphemeralResponse(c, 'Unknown admin subcommand.', 'error')
    })
  },
)

export { component_admin_season_cancel, component_admin_season_confirm, component_admin_show_response }
