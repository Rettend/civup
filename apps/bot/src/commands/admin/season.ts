import type { AdminCommandContext, AdminComponentContext } from './types.ts'
import { createDb } from '@civup/db'
import { Button, Components } from 'discord-hono'
import { archiveSeasonLeaderboards, refreshConfiguredLeaderboards } from '../../services/leaderboard/message.ts'
import { hasAdminPermission } from '../../services/permissions/index.ts'
import { resetCurrentRankedRoleState, syncRankedRoles } from '../../services/ranked/role-sync.ts'
import { clearSeasonConfirmation, createSeasonConfirmation, getSeasonConfirmation } from '../../services/season/confirmation.ts'
import { endSeason, formatSeasonName, getActiveSeason, getNextSeasonNumber, startSeason } from '../../services/season/index.ts'
import { ensureSeasonSnapshotRoles, finalizeSeasonSnapshotRoles } from '../../services/season/snapshot-roles.ts'
import { createStateStore } from '../../services/state/store.ts'
import { factory } from '../../setup.ts'
import { getInteractionUserId, sendEphemeralResponse, sendTransientEphemeralResponse, updateSeasonActionPrompt } from './shared.ts'

export function handleSeasonStart(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  const actorId = getInteractionUserId(c)

  if (!guildId || !actorId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const activeSeason = await getActiveSeason(db)
    if (activeSeason) {
      await sendTransientEphemeralResponse(c, `Cannot start a new season while **${activeSeason.name}** is still active.`, 'error')
      return
    }

    const seasonName = formatSeasonName(await getNextSeasonNumber(db))
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

export function handleSeasonEnd(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  const actorId = getInteractionUserId(c)

  if (!guildId || !actorId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const activeSeason = await getActiveSeason(db)
    if (!activeSeason) {
      await sendTransientEphemeralResponse(c, 'There is no active season to end.', 'error')
      return
    }

    const token = await createSeasonConfirmation(c.env.KV, {
      guildId,
      actorId,
      action: 'end',
      seasonName: activeSeason.name,
    })

    const components = new Components().row(
      new Button('admin-season-confirm', 'Confirm', 'Danger').custom_id(token),
      new Button('admin-season-cancel', 'Cancel', 'Secondary').custom_id(token),
    )

    await sendEphemeralResponse(
      c,
      `Confirm season end for **${activeSeason.name}**? This action is not recoverable.`,
      'info',
      { components, autoDeleteMs: null },
    )
  })
}

export const component_admin_season_confirm = factory.component(
  new Button('admin-season-confirm', 'Confirm', 'Primary'),
  async (c) => {
    const token = c.var.custom_id
    if (!token) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'Season confirmation token was missing.', 'error')
      })
    }

    if (!hasAdminPermission({ permissions: c.interaction.member?.permissions })) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'You need Administrator or Manage Server permission for this action.', 'error')
      })
    }

    const actorId = getInteractionUserId(c)
    const guildId = c.interaction.guild_id
    if (!actorId || !guildId) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'This action can only be used in a server.', 'error')
      })
    }

    const pending = await getSeasonConfirmation(c.env.KV, token)
    if (!pending) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'This confirmation expired. Run the command again.', 'error')
      })
    }

    if (pending.actorId !== actorId || pending.guildId !== guildId) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'Only the original command author can confirm this action.', 'error')
      })
    }

    return c.update().resDefer(async (c: AdminComponentContext) => {
      await clearSeasonConfirmation(c.env.KV, token)
      const kv = createStateStore(c.env)

      if (pending.action === 'start') {
        try {
          const db = createDb(c.env.DB)
          const season = await startSeason(db, { kv })
          await resetCurrentRankedRoleState({ kv, guildId, token: c.env.DISCORD_TOKEN })
          await refreshConfiguredLeaderboards(db, kv, c.env.DISCORD_TOKEN)
          await ensureSeasonSnapshotRoles(kv, guildId, c.env.DISCORD_TOKEN, season)
          await updateSeasonActionPrompt(c, `Started **${season.name}**. New matches will now count toward this season.`, 'success')
        }
        catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to start the season.'
          await updateSeasonActionPrompt(c, message, 'error')
        }
        return
      }

      try {
        const db = createDb(c.env.DB)
        await syncRankedRoles({ db, kv, guildId })
        const season = await endSeason(db)
        await archiveSeasonLeaderboards(db, kv, c.env.DISCORD_TOKEN, season.name)
        await finalizeSeasonSnapshotRoles(db, kv, guildId, c.env.DISCORD_TOKEN, season)
        await updateSeasonActionPrompt(c, `Ended **${season.name}**. Season data is now archived.`, 'success')
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to end the season.'
        await updateSeasonActionPrompt(c, message, 'error')
      }
    })
  },
)

export const component_admin_season_cancel = factory.component(
  new Button('admin-season-cancel', 'Cancel', 'Secondary'),
  async (c) => {
    const token = c.var.custom_id
    if (!token) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'Season confirmation token was missing.', 'error')
      })
    }

    const actorId = getInteractionUserId(c)
    const guildId = c.interaction.guild_id
    if (!actorId || !guildId) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'This action can only be used in a server.', 'error')
      })
    }

    const pending = await getSeasonConfirmation(c.env.KV, token)
    if (!pending) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'This confirmation already expired or was already handled.', 'info')
      })
    }

    if (pending.actorId !== actorId || pending.guildId !== guildId) {
      return c.flags('EPHEMERAL').resDefer(async (c: AdminComponentContext) => {
        await sendTransientEphemeralResponse(c, 'Only the original command author can cancel this confirmation.', 'error')
      })
    }

    return c.update().resDefer(async (c: AdminComponentContext) => {
      await clearSeasonConfirmation(c.env.KV, token)
      await updateSeasonActionPrompt(c, 'Cancelled season action.', 'info')
    })
  },
)
