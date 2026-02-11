import type { GameMode } from '@civup/game'
import type { LfgVar } from './shared.ts'
import { createDb, matches } from '@civup/db'
import { maxPlayerCount, minPlayerCount } from '@civup/game'
import { Command, Option, SubCommand } from 'discord-hono'
import { eq } from 'drizzle-orm'
import { lobbyComponents, lobbyOpenEmbed } from '../../embeds/lfg.ts'
import { getMatchForUser, storeUserMatchMappings } from '../../services/activity.ts'
import { createChannelMessage } from '../../services/discord.ts'
import { clearDeferredEphemeralResponse, sendEphemeralResponse, sendTransientEphemeralResponse } from '../../services/ephemeral-response.ts'
import { upsertLobbyMessage } from '../../services/lobby-message.ts'
import { clearLobby, createLobby, getLobby, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbySlots } from '../../services/lobby.ts'
import { addToQueue, clearQueue, getQueueState, removeFromQueue } from '../../services/queue.ts'
import { getSystemChannel } from '../../services/system-channels.ts'
import { factory } from '../../setup.ts'
import { GAME_MODE_CHOICES, getIdentity, joinLobbyAndMaybeStartMatch, LOBBY_STATUS_LABELS } from './shared.ts'

export const command_lfg = factory.command<LfgVar>(
  new Command('lfg', 'Looking for game — queue management').options(
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
                  components: lobbyComponents(mode, 'open'),
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
              components: lobbyComponents(mode, 'open'),
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
              await sendTransientEphemeralResponse(c, 'You are not in queue right now. If you need back in, use `/lfg join` for the active mode to reopen the activity.', 'error')
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
                components: lobbyComponents(removed, 'open'),
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

      default:
        return c.res('Unknown subcommand.')
    }
  },
)
