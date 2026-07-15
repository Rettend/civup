import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
<<<<<<< New base: fix: mod resolve
<<<<<<< New base: feat: save file analyzer
import { getBrowserAccessState, isSafeBrowserPreferenceRole, normalizePublicOrigin, setBrowserAccessState } from '../../services/activity/browser-access.ts'
import { createGuildRole, fetchGuildRoles, updateGuildRole } from '../../services/discord/index.ts'
||||||| Common ancestor
=======
import { getBrowserAccessState, normalizePublicOrigin, setBrowserAccessState } from '../../services/activity/browser-access.ts'
||||||| Common ancestor
import { getBrowserAccessState, normalizePublicOrigin, setBrowserAccessState } from '../../services/activity/browser-access.ts'
=======
import { getBrowserAccessState, isSafeBrowserPreferenceRole, normalizePublicOrigin, setBrowserAccessState } from '../../services/activity/browser-access.ts'
>>>>>>> Current commit: chore: cleanup and simplify setup
import { createGuildRole, fetchGuildRoles } from '../../services/discord/index.ts'
>>>>>>> Current commit: feat: external browser draft WIP
import { getKvStore } from '../../services/kv/batch.ts'
import {
  markLeaderboardsDirty,
  PLAYER_LEADERBOARD_MESSAGE_MODES,
  upsertCivLeaderboardMessageForChannel,
  upsertLeaderboardMessagesForChannel,
} from '../../services/leaderboard/message.ts'
import { clearLeaderboardDirtyState, clearLeaderboardMessageState, clearSystemChannel, getSystemChannel, setSystemChannel } from '../../services/system/channels.ts'
import { formatChannelMention, isCivLeaderboardSetupTarget, parseSetupTarget, sendEphemeralResponse, sendTransientEphemeralResponse, setupTargetCivModeScope, setupTargetLabel } from './shared.ts'

<<<<<<< New base: feat: save file analyzer
const BROWSER_ACCESS_TARGET = 'browser'
const BROWSER_PREFERENCE_ROLE_NAME = 'Web Browser'

||||||| Common ancestor
=======
const BROWSER_ACCESS_TARGET = 'browser'
const BROWSER_PREFERENCE_ROLE_NAME = 'CivUp Web Browser'

>>>>>>> Current commit: feat: external browser draft WIP
export function handleSetup(c: AdminCommandContext) {
  const rawTarget = c.var.target
  if (!rawTarget) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const [draftChannelId, archiveChannelId, commandsChannelId, leaderboardChannelId, legacyCivLeaderboardChannelId, civLeaderboardAllChannelId, civLeaderboardDuelChannelId, civLeaderboardDuoChannelId, civLeaderboardSquadChannelId, tournamentDraftChannelId, tournamentArchiveChannelId, tournamentLeaderboardChannelId, browserAccess] = await Promise.all([
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
        getBrowserAccessState(c.env.KV),
      ])

      await sendEphemeralResponse(
        c,
        '**Configured server features:**\n'
        + `Draft — ${formatChannelMention(draftChannelId)}\n`
        + `Archive — ${formatChannelMention(archiveChannelId)}\n`
        + `Bot Commands — ${formatChannelMention(commandsChannelId)}\n`
        + `Leaderboard — ${formatChannelMention(leaderboardChannelId)}\n`
        + `Civ Leaderboard (All) — ${formatChannelMention(civLeaderboardAllChannelId ?? legacyCivLeaderboardChannelId)}\n`
        + `Civ Leaderboard (Duel) — ${formatChannelMention(civLeaderboardDuelChannelId)}\n`
        + `Civ Leaderboard (Duo) — ${formatChannelMention(civLeaderboardDuoChannelId)}\n`
        + `Civ Leaderboard (Squad) — ${formatChannelMention(civLeaderboardSquadChannelId)}\n`
        + `Tournament Draft — ${formatChannelMention(tournamentDraftChannelId)}\n`
        + `Tournament Archive — ${formatChannelMention(tournamentArchiveChannelId)}\n`
        + `Tournament Leaderboard — ${formatChannelMention(tournamentLeaderboardChannelId)}\n`
        + `Browser Access — ${browserAccess.enabled && browserAccess.preferenceRoleId ? `on (<@&${browserAccess.preferenceRoleId}>)` : 'off'}`,
        'info',
      )
    })
  }

  if (rawTarget === BROWSER_ACCESS_TARGET) return handleBrowserAccessSetup(c)

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
<<<<<<< New base: feat: save file analyzer

function handleBrowserAccessSetup(c: AdminCommandContext) {
  const value = c.var.value
  if (value !== 'on' && value !== 'off') {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const state = await getBrowserAccessState(getKvStore(c.env))
      const status = state.enabled && state.preferenceRoleId ? `on (<@&${state.preferenceRoleId}>)` : 'off'
      await sendEphemeralResponse(c, `Browser Access is **${status}**. Set \`value\` to \`on\` or \`off\` to change it.`, 'info')
    })
  }

  const guildId = c.interaction.guild_id
  const allowedGuildId = c.env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? ''
  if (!guildId || !allowedGuildId || guildId !== allowedGuildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Browser Access can only be configured inside the configured server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const kv = getKvStore(c.env)
    const current = await getBrowserAccessState(kv)
    if (value === 'off') {
      await setBrowserAccessState(kv, { enabled: false, preferenceRoleId: current.preferenceRoleId })
      await sendTransientEphemeralResponse(c, 'Browser Access disabled. The preference role and member choices were preserved.', 'info')
      return
    }

    if (!normalizePublicOrigin(c.env.ACTIVITY_PUBLIC_ORIGIN)) {
      await sendTransientEphemeralResponse(c, 'Could not enable Browser Access because ACTIVITY_PUBLIC_ORIGIN is missing or invalid.', 'error')
      return
    }

    try {
      const roles = await fetchGuildRoles(c.env.DISCORD_TOKEN, guildId)
      const storedRole = current.preferenceRoleId
        ? roles.find(role => role.id === current.preferenceRoleId && isSafeBrowserPreferenceRole(role))
        : null
      const namedRole = roles.find(role => role.name === BROWSER_PREFERENCE_ROLE_NAME && isSafeBrowserPreferenceRole(role))
      const role = storedRole
        ? storedRole.name === BROWSER_PREFERENCE_ROLE_NAME
          ? storedRole
          : await updateGuildRole(c.env.DISCORD_TOKEN, guildId, storedRole.id, { name: BROWSER_PREFERENCE_ROLE_NAME })
        : namedRole ?? await createGuildRole(c.env.DISCORD_TOKEN, guildId, {
            name: BROWSER_PREFERENCE_ROLE_NAME,
            permissions: '0',
            hoist: false,
            mentionable: false,
          })
      if (!role.id) throw new Error('Discord returned a role without an ID')

      await setBrowserAccessState(kv, { enabled: true, preferenceRoleId: role.id })
      const action = storedRole || namedRole ? 'verified' : 'created'
      await sendTransientEphemeralResponse(c, `Browser Access enabled. Preference role ${action}: <@&${role.id}>.`, 'success')
    }
    catch (error) {
      console.error('[admin setup] failed to enable browser access', { guildId }, error)
      await sendTransientEphemeralResponse(c, 'Could not verify or create the Browser Access preference role. Check the bot role permissions and try again.', 'error')
    }
  })
}
||||||| Common ancestor
=======

function handleBrowserAccessSetup(c: AdminCommandContext) {
  const value = c.var.value
  if (value !== 'on' && value !== 'off') {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const state = await getBrowserAccessState(getKvStore(c.env))
      const status = state.enabled && state.preferenceRoleId ? `on (<@&${state.preferenceRoleId}>)` : 'off'
      await sendEphemeralResponse(c, `Browser Access is **${status}**. Set \`value\` to \`on\` or \`off\` to change it.`, 'info')
    })
  }

  const guildId = c.interaction.guild_id
  const allowedGuildId = c.env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? ''
  if (!guildId || !allowedGuildId || guildId !== allowedGuildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'Browser Access can only be configured inside the configured server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const kv = getKvStore(c.env)
    const current = await getBrowserAccessState(kv)
    if (value === 'off') {
      await setBrowserAccessState(kv, { enabled: false, preferenceRoleId: current.preferenceRoleId })
      await sendTransientEphemeralResponse(c, 'Browser Access disabled. The preference role and member choices were preserved.', 'info')
      return
    }

    if (!normalizePublicOrigin(c.env.ACTIVITY_PUBLIC_ORIGIN)) {
      await sendTransientEphemeralResponse(c, 'Could not enable Browser Access because ACTIVITY_PUBLIC_ORIGIN is missing or invalid.', 'error')
      return
    }

    try {
      const roles = await fetchGuildRoles(c.env.DISCORD_TOKEN, guildId)
      const storedRole = current.preferenceRoleId
        ? roles.find(role => role.id === current.preferenceRoleId && isSafeBrowserPreferenceRole(role))
        : null
      const namedRole = roles.find(role => role.name === BROWSER_PREFERENCE_ROLE_NAME && isSafeBrowserPreferenceRole(role))
      const role = storedRole ?? namedRole ?? await createGuildRole(c.env.DISCORD_TOKEN, guildId, {
        name: BROWSER_PREFERENCE_ROLE_NAME,
        permissions: '0',
        hoist: false,
        mentionable: false,
      })
      if (!role.id) throw new Error('Discord returned a role without an ID')

      await setBrowserAccessState(kv, { enabled: true, preferenceRoleId: role.id })
      const action = storedRole || namedRole ? 'verified' : 'created'
      await sendTransientEphemeralResponse(c, `Browser Access enabled. Preference role ${action}: <@&${role.id}>.`, 'success')
    }
    catch (error) {
      console.error('[admin setup] failed to enable browser access', { guildId }, error)
      await sendTransientEphemeralResponse(c, 'Could not verify or create the Browser Access preference role. Check the bot role permissions and try again.', 'error')
    }
  })
}
<<<<<<< New base: fix: mod resolve

function isSafeBrowserPreferenceRole(role: {
  hoist?: boolean
  managed?: boolean
  mentionable?: boolean
  permissions?: string
}): boolean {
  return role.managed === false
    && role.permissions === '0'
    && role.hoist === false
    && role.mentionable === false
}
>>>>>>> Current commit: feat: external browser draft WIP
||||||| Common ancestor

function isSafeBrowserPreferenceRole(role: {
  hoist?: boolean
  managed?: boolean
  mentionable?: boolean
  permissions?: string
}): boolean {
  return role.managed === false
    && role.permissions === '0'
    && role.hoist === false
    && role.mentionable === false
}
=======
>>>>>>> Current commit: chore: cleanup and simplify setup
