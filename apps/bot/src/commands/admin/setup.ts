import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
import { getKvStore } from '../../services/kv/batch.ts'
import { upsertCivLeaderboardMessageForChannel, upsertLeaderboardMessagesForChannel } from '../../services/leaderboard/message.ts'
import { clearLeaderboardDirtyState, clearLeaderboardMessageState, clearSystemChannel, getSystemChannel, setSystemChannel } from '../../services/system/channels.ts'
import { formatChannelMention, parseSetupTarget, sendEphemeralResponse, sendTransientEphemeralResponse, setupTargetLabel } from './shared.ts'

export function handleSetup(c: AdminCommandContext) {
  const rawTarget = c.var.target
  if (!rawTarget) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const [draftChannelId, archiveChannelId, commandsChannelId, leaderboardChannelId, civLeaderboardChannelId, tournamentDraftChannelId, tournamentArchiveChannelId, tournamentLeaderboardChannelId] = await Promise.all([
        getSystemChannel(c.env.KV, 'draft'),
        getSystemChannel(c.env.KV, 'archive'),
        getSystemChannel(c.env.KV, 'commands'),
        getSystemChannel(c.env.KV, 'leaderboard'),
        getSystemChannel(c.env.KV, 'civ-leaderboard'),
        getSystemChannel(c.env.KV, 'tournament-draft'),
        getSystemChannel(c.env.KV, 'tournament-archive'),
        getSystemChannel(c.env.KV, 'tournament-leaderboard'),
      ])

      await sendEphemeralResponse(
        c,
        '**Configured channels:**\n'
        + `Draft — ${formatChannelMention(draftChannelId)}\n`
        + `Archive — ${formatChannelMention(archiveChannelId)}\n`
        + `Bot Commands — ${formatChannelMention(commandsChannelId)}\n`
        + `Leaderboard — ${formatChannelMention(leaderboardChannelId)}\n`
        + `Civ Leaderboard — ${formatChannelMention(civLeaderboardChannelId)}\n`
        + `Tournament Draft — ${formatChannelMention(tournamentDraftChannelId)}\n`
        + `Tournament Archive — ${formatChannelMention(tournamentArchiveChannelId)}\n`
        + `Tournament Leaderboard — ${formatChannelMention(tournamentLeaderboardChannelId)}`,
        'info',
      )
    })
  }

  const target = parseSetupTarget(rawTarget)
  if (!target) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Invalid setup target. Use Draft, Archive, Bot Commands, Leaderboard, Civ Leaderboard, Tournament Draft, Tournament Archive, or Tournament Leaderboard.', 'error')
    })
  }

  const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
  if (!channelId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Could not identify the current channel.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const kv = getKvStore(c.env)
    const previousChannelId = await getSystemChannel(kv, target)

    if (previousChannelId === channelId) {
      await clearSystemChannel(kv, target)
      if (target === 'leaderboard' || target === 'civ-leaderboard') {
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

    if (target === 'civ-leaderboard') {
      try {
        const db = createDb(c.env.DB)
        const initialized = await upsertCivLeaderboardMessageForChannel(db, kv, c.env.DISCORD_TOKEN, channelId)
        await clearLeaderboardDirtyState(kv)
        const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
        if (!initialized) {
          await sendTransientEphemeralResponse(c, `Civ Leaderboard channel set to <#${channelId}>${movedFrom}, but no initialized civ leaderboard snapshot exists yet.`, 'info')
          return
        }
        await sendTransientEphemeralResponse(c, `Civ Leaderboard channel set to <#${channelId}>${movedFrom}.`, 'success')
      }
      catch (error) {
        console.error('Failed to initialize civ leaderboard messages:', error)
        await sendTransientEphemeralResponse(c, `Civ Leaderboard channel set to <#${channelId}>, but failed to initialize civ leaderboard embeds.`, 'error')
      }
      return
    }

    const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
    await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>${movedFrom}.`, 'success')
  })
}
