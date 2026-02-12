import type { GameMode } from '@civup/game'
import type { LfgVar } from './shared.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { isTeamMode, maxPlayerCount, minPlayerCount } from '@civup/game'
import { Command, Option, SubCommand } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { lobbyComponents, lobbyOpenEmbed, lobbyResultEmbed } from '../../embeds/lfg.ts'
import { getMatchForUser, storeUserMatchMappings } from '../../services/activity.ts'
import { createChannelMessage } from '../../services/discord.ts'
import { clearDeferredEphemeralResponse, sendEphemeralResponse, sendTransientEphemeralResponse } from '../../services/ephemeral-response.ts'
import { refreshConfiguredLeaderboards } from '../../services/leaderboard-message.ts'
import { upsertLobbyMessage } from '../../services/lobby-message.ts'
import { clearLobby, clearLobbyByMatch, createLobby, getLobby, getLobbyByMatch, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbySlots, setLobbyStatus } from '../../services/lobby.ts'
import { storeMatchMessageMapping } from '../../services/match-message.ts'
import { reportMatch } from '../../services/match.ts'
import { addToQueue, clearQueue, getQueueState, removeFromQueue } from '../../services/queue.ts'
import { getSystemChannel } from '../../services/system-channels.ts'
import { factory } from '../../setup.ts'
import { collectFfaPlacementUserIds, GAME_MODE_CHOICES, getIdentity, joinLobbyAndMaybeStartMatch, LOBBY_STATUS_LABELS } from './shared.ts'

export const command_lfg = factory.command<LfgVar>(
  new Command('lfg', 'Looking for game, queue management').options(
    new SubCommand('create', 'Create a lobby and auto-join as host').options(
      new Option('mode', 'Game mode for the lobby')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
    new SubCommand('join', 'Join the queue for a game mode').options(
      new Option('mode', 'Game mode to queue for')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
    new SubCommand('leave', 'Leave the current queue'),
    new SubCommand('status', 'Show all active lobbies'),
    new SubCommand('report', 'Report your active match result (host only)').options(
      new Option('match_id', 'Optional match ID override'),
      new Option('winner', 'Winner (1v1/team) or 1st place (FFA)', 'User'),
      new Option('second', 'FFA 2nd place', 'User'),
      new Option('third', 'FFA 3rd place', 'User'),
      new Option('fourth', 'FFA 4th place', 'User'),
      new Option('fifth', 'FFA 5th place', 'User'),
      new Option('sixth', 'FFA 6th place', 'User'),
      new Option('seventh', 'FFA 7th place', 'User'),
      new Option('eighth', 'FFA 8th place', 'User'),
      new Option('ninth', 'FFA 9th place', 'User'),
      new Option('tenth', 'FFA 10th place', 'User'),
    ),
  ),
  async (c) => {
    switch (c.sub.string) {
      // ── create ──────────────────────────────────────────
      case 'create': {
        const mode = c.var.mode as GameMode
        const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const draftChannelId = await getSystemChannel(kv, 'draft')
          if (!draftChannelId) {
            await sendTransientEphemeralResponse(
              c,
              'Draft channel is not configured. Run `/admin setup target:Draft` to set up this channel.',
              'error',
            )
            return
          }

          const existingLobby = await getLobby(kv, mode)
          if (existingLobby) {
            if (existingLobby.status === 'open') {
              const queue = await getQueueState(kv, mode)
              const slots = normalizeLobbySlots(mode, existingLobby.slots, queue.entries)
              const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)
              const embed = lobbyOpenEmbed(mode, slottedEntries, maxPlayerCount(mode))
              if (!sameLobbySlots(slots, existingLobby.slots)) {
                await setLobbySlots(kv, mode, slots)
              }
              try {
                await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, existingLobby, {
                  embeds: [embed],
                  components: lobbyComponents(mode),
                })
              }
              catch (error) {
                console.error('Failed to refresh existing lobby embed:', error)
              }
              await sendTransientEphemeralResponse(c, `A ${mode.toUpperCase()} lobby is already active in <#${existingLobby.channelId}>.`, 'error')
              return
            }

            if (!existingLobby.matchId) {
              await clearLobby(kv, mode)
            }
            else {
              const db = createDb(c.env.DB)
              const [existingMatch] = await db
                .select({ status: matches.status })
                .from(matches)
                .where(eq(matches.id, existingLobby.matchId))
                .limit(1)

              if (!existingMatch || existingMatch.status === 'completed' || existingMatch.status === 'cancelled') {
                await clearLobby(kv, mode)
              }
              else {
                await sendTransientEphemeralResponse(c, `A ${mode.toUpperCase()} lobby is already active in <#${existingLobby.channelId}>.`, 'error')
                return
              }
            }
          }

          const staleQueue = await getQueueState(kv, mode)
          if (staleQueue.entries.length > 0) {
            await clearQueue(kv, mode, staleQueue.entries.map(entry => entry.playerId))
          }

          const result = await addToQueue(kv, mode, {
            playerId: identity.userId,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
            joinedAt: Date.now(),
          })

          if (result.error) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          const queue = await getQueueState(kv, mode)
          const embed = lobbyOpenEmbed(mode, queue.entries, maxPlayerCount(mode))

          try {
            const message = await createChannelMessage(c.env.DISCORD_TOKEN, draftChannelId, {
              embeds: [embed],
              components: lobbyComponents(mode),
            })
            await createLobby(kv, {
              mode,
              hostId: identity.userId,
              channelId: draftChannelId,
              messageId: message.id,
            })
            if (interactionChannelId === draftChannelId) {
              await clearDeferredEphemeralResponse(c)
            }
            else {
              await sendTransientEphemeralResponse(c, `Created ${mode.toUpperCase()} lobby in <#${draftChannelId}>.`, 'info')
            }
          }
          catch (error) {
            console.error('Failed to create lobby message:', error)
            await removeFromQueue(kv, identity.userId)
            await sendTransientEphemeralResponse(c, 'Failed to create lobby message. Please try again.', 'error')
          }
        })
      }

      // ── join ────────────────────────────────────────────
      case 'join': {
        const mode = c.var.mode as GameMode
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        const lobby = await getLobby(c.env.KV, mode)
        if (!lobby) {
          const userMatchId = await getMatchForUser(c.env.KV, identity.userId)
          if (userMatchId) {
            c.executionCtx.waitUntil(storeUserMatchMappings(c.env.KV, [identity.userId], userMatchId))
            return c.resActivity()
          }
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, `No active ${mode.toUpperCase()} lobby. Use \`/lfg create\` first.`, 'error')
          })
        }

        if (lobby.status !== 'open') {
          if (!lobby.matchId) {
            await clearLobby(c.env.KV, mode)
            return c.flags('EPHEMERAL').resDefer(async (c) => {
              await sendTransientEphemeralResponse(c, 'This lobby was stale and has been cleared. Use `/lfg create` to start a fresh lobby.', 'error')
            })
          }

          c.executionCtx.waitUntil(storeUserMatchMappings(c.env.KV, [identity.userId], lobby.matchId))
          return c.resActivity()
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const outcome = await joinLobbyAndMaybeStartMatch(
            c,
            mode,
            identity.userId,
            identity.displayName,
            identity.avatarUrl,
            lobby.channelId,
          )
          if ('error' in outcome) {
            await sendTransientEphemeralResponse(c, outcome.error, 'error')
            return
          }

          try {
            await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
              embeds: outcome.embeds,
              components: outcome.components,
            })

            await clearDeferredEphemeralResponse(c)
          }
          catch (error) {
            console.error('Failed to update lobby message after slash join:', error)
            await sendTransientEphemeralResponse(c, 'Joined queue, but failed to update lobby embed.', 'error')
          }
        })
      }

      // ── leave ───────────────────────────────────────────
      case 'leave': {
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const removed = await removeFromQueue(kv, identity.userId)

          if (!removed) {
            const userMatchId = await getMatchForUser(kv, identity.userId)
            if (userMatchId) {
              await sendTransientEphemeralResponse(c, 'You are not in queue right now. If you need back in, use `/lfg join` for the game mode to reopen the activity.', 'error')
              return
            }

            await sendTransientEphemeralResponse(c, 'You are not in any queue.', 'error')
            return
          }

          const lobby = await getLobby(kv, removed)
          if (lobby?.status === 'open') {
            const queue = await getQueueState(kv, removed)
            const slots = normalizeLobbySlots(removed, lobby.slots, queue.entries)
            const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)
            if (!sameLobbySlots(slots, lobby.slots)) {
              await setLobbySlots(kv, removed, slots)
            }
            try {
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyOpenEmbed(removed, slottedEntries, maxPlayerCount(removed))],
                components: lobbyComponents(removed),
              })
            }
            catch (error) {
              console.error('Failed to update lobby message after leave:', error)
            }
          }

          await clearDeferredEphemeralResponse(c)
        })
      }

      // ── status ──────────────────────────────────────────
      case 'status': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const modes: GameMode[] = ['ffa', '1v1', '2v2', '3v3']
          const lines: string[] = []

          for (const mode of modes) {
            const lobby = await getLobby(kv, mode)
            if (!lobby) continue

            const label = LOBBY_STATUS_LABELS[lobby.status]
            if (lobby.status === 'open') {
              const queue = await getQueueState(kv, mode)
              const slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
              const filled = slots.filter(slot => slot != null).length
              const target = mode === 'ffa'
                ? `${minPlayerCount(mode)}-${maxPlayerCount(mode)}`
                : String(maxPlayerCount(mode))
              lines.push(`- ${mode.toUpperCase()} - ${label} in <#${lobby.channelId}> (${filled}/${target} slotted, ${queue.entries.length} joined)`)
            }
            else {
              lines.push(`- ${mode.toUpperCase()} - ${label} in <#${lobby.channelId}>`)
            }
          }

          if (lines.length === 0) {
            await sendTransientEphemeralResponse(c, 'No active lobbies. Use `/lfg create` to start one.', 'error')
            return
          }

          await sendEphemeralResponse(c, lines.join('\n'), 'info')
        })
      }

      // ── report ──────────────────────────────────────────
      case 'report': {
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const db = createDb(c.env.DB)
          const kv = c.env.KV

          let matchId = c.var.match_id?.trim() ?? null
          if (!matchId) {
            matchId = await getMatchForUser(kv, identity.userId)
          }

          if (!matchId) {
            const [active] = await db
              .select({ matchId: matchParticipants.matchId })
              .from(matchParticipants)
              .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
              .where(and(
                eq(matchParticipants.playerId, identity.userId),
                inArray(matches.status, ['active']),
              ))
              .orderBy(desc(matches.createdAt))
              .limit(1)

            matchId = active?.matchId ?? null
            if (matchId) {
              c.executionCtx.waitUntil(storeUserMatchMappings(kv, [identity.userId], matchId))
            }
          }

          if (!matchId) {
            await sendTransientEphemeralResponse(c, 'Could not find an active match for you. You can pass `match_id` explicitly.', 'error')
            return
          }

          const [match] = await db
            .select({ id: matches.id, gameMode: matches.gameMode, status: matches.status })
            .from(matches)
            .where(eq(matches.id, matchId))
            .limit(1)

          if (!match) {
            await sendTransientEphemeralResponse(c, `Match **${matchId}** was not found.`, 'error')
            return
          }

          if (match.status !== 'active') {
            await sendTransientEphemeralResponse(c, `Match **${match.id}** is not active (status: ${match.status}).`, 'error')
            return
          }

          const orderedFfaIds = collectFfaPlacementUserIds(c.var)
          const winnerId = c.var.winner ?? null
          const mode = normalizeMatchMode(match.gameMode)

          let placements: string
          if (mode === 'ffa') {
            if (!winnerId) {
              await sendTransientEphemeralResponse(c, 'For FFA reporting, you must provide a `winner` (1st place) user.', 'error')
              return
            }
            if (orderedFfaIds.length < 6) {
              await sendTransientEphemeralResponse(c, 'FFA reporting needs at least 6 ordered users (`winner` + `second` to `sixth`).', 'error')
              return
            }
            placements = orderedFfaIds.map(playerId => `<@${playerId}>`).join('\n')
          }
          else {
            if (orderedFfaIds.length > 1) {
              await sendTransientEphemeralResponse(c, 'For 1v1/team reporting, use the `winner` user option only (no partial placements).', 'error')
              return
            }
            if (!winnerId) {
              await sendTransientEphemeralResponse(c, 'Please provide `winner` for 1v1/team reporting.', 'error')
              return
            }
            placements = `<@${winnerId}>`
          }

          const result = await reportMatch(db, kv, {
            matchId: match.id,
            reporterId: identity.userId,
            placements,
          })

          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          const reportedMode = normalizeMatchMode(result.match.gameMode)

          const lobby = await getLobbyByMatch(kv, result.match.id)
          if (lobby) {
            await setLobbyStatus(kv, lobby.mode, 'completed')
            try {
              const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyResultEmbed(lobby.mode, result.participants)],
                components: [],
              })
              await storeMatchMessageMapping(kv, updatedLobby.messageId, result.match.id)
            }
            catch (error) {
              console.error(`Failed to update lobby result embed for match ${result.match.id}:`, error)
            }
            await clearLobbyByMatch(kv, result.match.id)
          }

          const archiveChannelId = await getSystemChannel(kv, 'archive')
          if (archiveChannelId) {
            try {
              const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
                embeds: [lobbyResultEmbed(reportedMode, result.participants)],
              })
              await storeMatchMessageMapping(kv, archiveMessage.id, result.match.id)
            }
            catch (error) {
              console.error(`Failed to post archive result for match ${result.match.id}:`, error)
            }
          }

          try {
            await refreshConfiguredLeaderboards(db, kv, c.env.DISCORD_TOKEN)
          }
          catch (error) {
            console.error(`Failed to refresh leaderboard embeds after match ${result.match.id}:`, error)
          }

          await sendTransientEphemeralResponse(c, `Reported result for match **${result.match.id}**.`, 'success')
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
)

function normalizeMatchMode(mode: string): GameMode {
  if (mode === '1v1' || mode === '2v2' || mode === '3v3' || mode === 'ffa') return mode
  return isTeamMode(mode as GameMode) ? mode as GameMode : '1v1'
}
