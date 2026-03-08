import type { AdminCommandContext, AdminComponentContext } from './types.ts'
import { createDb } from '@civup/db'
import { Button, Components } from 'discord-hono'
import { clearSeasonConfirmation, createSeasonConfirmation, getSeasonConfirmation } from '../../services/confirmations.ts'
import { archiveSeasonLeaderboards } from '../../services/leaderboard-message.ts'
import { hasAdminPermission } from '../../services/permissions.ts'
import { endSeason, startSeason } from '../../services/season/index.ts'
import { ensureSeasonSnapshotRoles, finalizeSeasonSnapshotRoles } from '../../services/season/snapshot-roles.ts'
import { factory } from '../../setup.ts'
import { getInteractionUserId, sendEphemeralResponse, sendTransientEphemeralResponse, updateSeasonActionPrompt } from './shared.ts'

export function handleSeasonStart(c: AdminCommandContext) {
  const seasonName = c.var.name?.trim()
  const guildId = c.interaction.guild_id
  const actorId = getInteractionUserId(c)

  if (!seasonName) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Please provide a season name.', 'error')
    })
  }

  if (!guildId || !actorId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
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

      if (pending.action === 'start') {
        const seasonName = pending.seasonName ?? 'Season'
        try {
          const db = createDb(c.env.DB)
          const season = await startSeason(db, { name: seasonName })
          await ensureSeasonSnapshotRoles(c.env.KV, guildId, c.env.DISCORD_TOKEN, season)
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
        const season = await endSeason(db)
        await archiveSeasonLeaderboards(db, c.env.KV, c.env.DISCORD_TOKEN, season.name)
        await finalizeSeasonSnapshotRoles(db, c.env.KV, guildId, c.env.DISCORD_TOKEN, season)
        await updateSeasonActionPrompt(c, `Ended **${season.name}**. Season peaks are now frozen in storage.`, 'success')
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
