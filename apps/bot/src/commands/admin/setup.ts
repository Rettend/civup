import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
import { getKvStore } from '../../services/kv/batch.ts'
import {
  markLeaderboardsDirty,
  PLAYER_LEADERBOARD_MESSAGE_MODES,
  upsertCivLeaderboardMessageForChannel,
  upsertLeaderboardMessagesForChannel,
} from '../../services/leaderboard/message.ts'
import { clearLeaderboardDirtyState, clearLeaderboardMessageState, clearSystemChannel, getSystemChannel, setSystemChannel } from '../../services/system/channels.ts'
import { formatChannelMention, isCivLeaderboardSetupTarget, parseSetupTarget, sendEphemeralResponse, sendTransientEphemeralResponse, setupTargetCivModeScope, setupTargetLabel } from './shared.ts'

export function handleSetup(c: AdminCommandContext) {
  const rawTarget = c.var.target
  if (!rawTarget) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const [draftChannelId, archiveChannelId, commandsChannelId, leaderboardChannelId, civLeaderboardFallbackChannelId, civLeaderboardAllChannelId, civLeaderboardDuelChannelId, civLeaderboardDuoChannelId, civLeaderboardSquadChannelId, tournamentDraftChannelId, tournamentArchiveChannelId, tournamentLeaderboardChannelId] = await Promise.all([
        getSystemChannel(c.env.KV, 'draft'),
        getSystemChannel(c.env.KV, 'archive'),
        getSystemChannel(c.env.KV, 'commands'),
        getSystemChannel(c.env.KV, 'leaderboard'),
        getSystemChannel(c.env.KV, 'civ-leaderboard'),
        getSystemChannel(c.env.KV, 'civ-leaderboard-all'),
        getSystemChannel(c.env.KV, 'civ-leaderboard-duel'),
        getSystemChannel(c.env.KV, 'civ-leaderboard-duo'),
        getSystemChannel(c.env.KV, 'civ-leaderboard-squad'),
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
        + `Civ Leaderboard (All) — ${formatChannelMention(civLeaderboardAllChannelId ?? civLeaderboardFallbackChannelId)}\n`
        + `Civ Leaderboard (Duel) — ${formatChannelMention(civLeaderboardDuelChannelId)}\n`
        + `Civ Leaderboard (Duo) — ${formatChannelMention(civLeaderboardDuoChannelId)}\n`
        + `Civ Leaderboard (Squad) — ${formatChannelMention(civLeaderboardSquadChannelId)}\n`
        + `Civ Leaderboard (All Fallback) — ${formatChannelMention(civLeaderboardFallbackChannelId)}\n`
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
      await sendTransientEphemeralResponse(c, 'Invalid setup target. Use Draft, Archive, Bot Commands, Leaderboard, a Civ Leaderboard scope, Tournament Draft, Tournament Archive, or Tournament Leaderboard.', 'error')
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
      if (target === 'leaderboard' || isCivLeaderboardSetupTarget(target)) {
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
        const [initialMode, ...queuedModes] = PLAYER_LEADERBOARD_MESSAGE_MODES
        await upsertLeaderboardMessagesForChannel(db, kv, c.env.DISCORD_TOKEN, channelId, { modes: initialMode ? [initialMode] : [] })
        if (queuedModes.length > 0) await markLeaderboardsDirty(db, 'admin-setup:leaderboard', { modes: queuedModes })
        await clearLeaderboardDirtyState(kv)
        const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
        await sendTransientEphemeralResponse(c, `Leaderboard channel set to <#${channelId}>${movedFrom}. Initialized ${initialMode ?? 'leaderboard'}; remaining modes are queued for scheduled refresh.`, 'success')
      }
      catch (error) {
        console.error('Failed to initialize leaderboard messages:', error)
        await sendTransientEphemeralResponse(c, `Leaderboard channel set to <#${channelId}>, but failed to initialize leaderboard images.`, 'error')
      }
      return
    }

    if (isCivLeaderboardSetupTarget(target)) {
      try {
        const db = createDb(c.env.DB)
        const modeScope = setupTargetCivModeScope(target) ?? 'all'
        const initialized = await upsertCivLeaderboardMessageForChannel(db, kv, c.env.DISCORD_TOKEN, channelId, { modeScope })
        await clearLeaderboardDirtyState(kv)
        const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
        if (!initialized) {
          await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>${movedFrom}, but no initialized civ leaderboard snapshot exists yet.`, 'info')
          return
        }
        await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>${movedFrom}.`, 'success')
      }
      catch (error) {
        console.error('Failed to initialize civ leaderboard messages:', error)
        await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>, but failed to initialize civ leaderboard embeds.`, 'error')
      }
      return
    }

    const movedFrom = previousChannelId && previousChannelId !== channelId ? ` (moved from <#${previousChannelId}>)` : ''
    await sendTransientEphemeralResponse(c, `${setupTargetLabel(target)} channel set to <#${channelId}>${movedFrom}.`, 'success')
  })
}
