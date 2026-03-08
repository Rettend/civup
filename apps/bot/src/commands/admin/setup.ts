import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
import { upsertLeaderboardMessagesForChannel } from '../../services/leaderboard-message.ts'
import { clearLeaderboardDirtyState, clearLeaderboardMessageState, clearSystemChannel, getSystemChannel, setSystemChannel } from '../../services/system-channels.ts'
import { formatChannelMention, parseSetupTarget, sendEphemeralResponse, sendTransientEphemeralResponse, setupTargetLabel } from './shared.ts'

export function handleSetup(c: AdminCommandContext) {
  const rawTarget = c.var.target
  if (!rawTarget) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const [draftChannelId, archiveChannelId, leaderboardChannelId, rankAnnouncementsChannelId] = await Promise.all([
        getSystemChannel(c.env.KV, 'draft'),
        getSystemChannel(c.env.KV, 'archive'),
        getSystemChannel(c.env.KV, 'leaderboard'),
        getSystemChannel(c.env.KV, 'rank-announcements'),
      ])

      await sendEphemeralResponse(
        c,
        '**Configured channels:**\n'
        + `Draft — ${formatChannelMention(draftChannelId)}\n`
        + `Archive — ${formatChannelMention(archiveChannelId)}\n`
        + `Leaderboard — ${formatChannelMention(leaderboardChannelId)}\n`
        + `Rank Announcements — ${formatChannelMention(rankAnnouncementsChannelId)}`,
        'info',
      )
    })
  }

  const target = parseSetupTarget(rawTarget)
  if (!target) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Invalid setup target. Use Draft, Archive, or Leaderboard.', 'error')
    })
  }

  const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
  if (!channelId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Could not identify the current channel.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
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
        const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
        await sendTransientEphemeralResponse(c, `Leaderboard channel set to <#${channelId}>${movedFrom}.`, 'success')
      }
      catch (error) {
        console.error('Failed to initialize leaderboard messages:', error)
        await sendTransientEphemeralResponse(c, `Leaderboard channel set to <#${channelId}>, but failed to initialize leaderboard embeds.`, 'error')
      }
      return
    }

    const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
    await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>${movedFrom}.`, 'success')
  })
}
