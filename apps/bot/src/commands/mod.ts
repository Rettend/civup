import type { MatchVar } from './match/shared'
import { createDb } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { lobbyCancelledEmbed, lobbyResultEmbed } from '../embeds/match'
import { clearLobbyMappings } from '../services/activity/index.ts'
import { createChannelMessage } from '../services/discord/index.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { rebuildLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { clearLobbyById, filterQueueEntriesForLobby, getLobbyById, getLobbyByMatch } from '../services/lobby/index.ts'
import { upsertLobbyMessage } from '../services/lobby/message.ts'
import { cancelMatchByModerator, getStoredGameModeContext, resolveMatchByModerator } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { canUseModCommands, parseRoleIds } from '../services/permissions/index.ts'
import { clearQueue, getQueueState } from '../services/queue/index.ts'
import { listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles } from '../services/ranked/role-sync.ts'
import { sendEphemeralResponse, sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { syncSeasonPeaksForPlayers } from '../services/season/index.ts'
import { createStateStore } from '../services/state/store.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { factory } from '../setup'
import { buildFfaPlacementOptions, collectFfaPlacementUserIds } from './match/shared'

interface ModVar extends MatchVar {
  reason?: string
}

export const command_mod = factory.command<ModVar>(
  new Command('mod', 'Moderation commands for match and lobby operations').options(
    new SubGroup('match', 'Match moderation').options(
      new SubCommand('cancel', 'Cancel a match, including completed history').options(
        new Option('match_id', 'Match or lobby ID').required(),
        new Option('reason', 'Optional short reason for cancellation').max_length(140),
      ),
      new SubCommand('resolve', 'Resolve or correct a match result').options(
        new Option('match_id', 'Match ID').required(),
        new Option('winner', 'Winner (1v1/team) or 1st place (FFA)', 'User'),
        ...buildFfaPlacementOptions(),
        new Option('reason', 'Optional short reason for correction').max_length(140),
      ),
    ),
  ),
  async (c) => {
    const guildId = c.interaction.guild_id
    const kv = createStateStore(c.env)
    if (!guildId) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
      })
    }

    const allowed = await canUseModCommands({
      kv,
      guildId,
      permissions: c.interaction.member?.permissions,
      roles: parseRoleIds(c.interaction.member?.roles),
    })

    if (!allowed) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(
          c,
          'You need Administrator/Manage Server permission or a configured Mod role (`/admin permission add`) for /mod commands.',
          'error',
        )
      })
    }

    switch (c.sub.string) {
      // ── match cancel ────────────────────────────────────
      case 'match cancel': {
        const matchId = c.var.match_id
        const reason = c.var.reason?.trim() ?? null

        if (!matchId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please provide a match ID.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const db = createDb(c.env.DB)
          const actorId = c.interaction.member?.user?.id ?? c.interaction.user?.id
          if (!actorId) {
            await sendTransientEphemeralResponse(c, 'Could not identify moderator user.', 'error')
            return
          }

          const directLobby = await getLobbyById(kv, matchId)
          if (directLobby && directLobby.status === 'open' && !directLobby.matchId) {
            const queue = await getQueueState(kv, directLobby.mode)
            const lobbyQueueEntries = filterQueueEntriesForLobby(directLobby, queue.entries)
            if (lobbyQueueEntries.length > 0) {
              await clearQueue(kv, directLobby.mode, lobbyQueueEntries.map(entry => entry.playerId), {
                currentState: queue,
              })
            }

            await clearLobbyMappings(kv, directLobby.memberPlayerIds, directLobby.channelId)
            try {
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, directLobby, {
                embeds: [lobbyCancelledEmbed(directLobby.mode, [], 'cancel', { actorId, reason }, directLobby.draftConfig.leaderDataVersion, directLobby.draftConfig.redDeath)],
                components: [],
              })
            }
            catch (error) {
              console.error(`Failed to update cancelled embed for lobby ${directLobby.id}:`, error)
            }

            await clearLobbyById(kv, directLobby.id, directLobby)
            await sendTransientEphemeralResponse(c, `Cancelled open lobby **${directLobby.id}**.`, 'success')
            return
          }

          const existingLobby = await getLobbyByMatch(kv, matchId)
          const result = await cancelMatchByModerator(db, kv, {
            matchId,
            cancelledAt: Date.now(),
          })

          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          const matchContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
          if (!matchContext) {
            await sendTransientEphemeralResponse(c, `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.`, 'error')
            return
          }

          const mode = matchContext.mode
          const moderation = { actorId, reason }

          if (existingLobby) {
            try {
              const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, existingLobby, {
                embeds: [lobbyCancelledEmbed(mode, result.participants, 'cancel', moderation, existingLobby.draftConfig.leaderDataVersion, existingLobby.draftConfig.redDeath)],
                components: [],
              })
              await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
            }
            catch (error) {
              console.error(`Failed to update cancelled embed for match ${result.match.id}:`, error)
            }
          }

          const shouldArchiveCancellation = result.previousStatus === 'completed'
          const archiveChannelId = shouldArchiveCancellation ? await getSystemChannel(kv, 'archive') : null
          if (archiveChannelId && shouldArchiveCancellation) {
            try {
              const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
                embeds: [lobbyCancelledEmbed(mode, result.participants, 'cancel', moderation, existingLobby?.draftConfig.leaderDataVersion, matchContext.redDeath)],
              })
              await storeMatchMessageMapping(db, archiveMessage.id, result.match.id)
            }
            catch (error) {
              console.error(`Failed to post archive cancellation note for match ${result.match.id}:`, error)
            }
          }

          try {
            await markLeaderboardsDirty(db, `mod-cancel:${result.match.id}`)
          }
          catch (error) {
            console.error(`Failed to mark leaderboards dirty after cancelling match ${result.match.id}:`, error)
          }

          try {
            await markRankedRolesDirty(kv, `mod-cancel:${result.match.id}`)
          }
          catch (error) {
            console.error(`Failed to mark ranked roles dirty after cancelling match ${result.match.id}:`, error)
          }

          const recalculated = result.recalculatedMatchIds.length
          await sendTransientEphemeralResponse(
            c,
            `Cancelled match **${result.match.id}** (was ${result.previousStatus}). Recalculated ${recalculated} completed ${formatModeLabel(mode, mode, { redDeath: matchContext.redDeath })} matches.`,
            'success',
          )
        })
      }

      // ── match resolve ───────────────────────────────────
      case 'match resolve': {
        const matchId = c.var.match_id
        const winnerId = c.var.winner ?? null
        const orderedFfaIds = collectFfaPlacementUserIds(c.var)
        const reason = c.var.reason?.trim() ?? null

        if (!matchId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please provide a match ID.', 'error')
          })
        }

        const hasWinner = Boolean(winnerId)
        // collectFfaPlacementUserIds now includes winner as the first element
        // So strict FFA implies we have more than just the winner (at least winner + second)
        // But for flexible moderation, we might just look at what's provided.

        if (!hasWinner && orderedFfaIds.length === 0) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Provide at least a `winner` (or FFA 1st place).', 'error')
          })
        }

        const placements = orderedFfaIds.map(playerId => `<@${playerId}>`).join('\n')

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          try {
            const db = createDb(c.env.DB)
            const actorId = c.interaction.member?.user?.id ?? c.interaction.user?.id
            if (!actorId) {
              await sendTransientEphemeralResponse(c, 'Could not identify moderator user.', 'error')
              return
            }

            const result = await resolveMatchByModerator(db, kv, {
              matchId,
              placements,
              resolvedAt: Date.now(),
            })

            if ('error' in result) {
              await sendTransientEphemeralResponse(c, result.error, 'error')
              return
            }

            const matchContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
            if (!matchContext) {
              await sendTransientEphemeralResponse(c, `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.`, 'error')
              return
            }

            const existingLobby = result.previousStatus === 'completed' ? null : await getLobbyByMatch(kv, result.match.id)
            const mode = matchContext.mode
            const moderation = { actorId, reason }
            const guildId = existingLobby?.guildId ?? c.interaction.guild_id ?? null
            const participantIds = result.participants.map(participant => participant.playerId)

            try {
              await markLeaderboardsDirty(db, `mod-resolve:${result.match.id}`)
            }
            catch (error) {
              console.error(`Failed to mark leaderboards dirty after resolving match ${result.match.id}:`, error)
            }

            try {
              await markRankedRolesDirty(kv, `mod-resolve:${result.match.id}`)
            }
            catch (error) {
              console.error(`Failed to mark ranked roles dirty after resolving match ${result.match.id}:`, error)
            }

            const recalculated = result.recalculatedMatchIds.length
            await sendEphemeralResponse(
              c,
              `Resolved match **${result.match.id}** (was ${result.previousStatus}). Recalculated ${recalculated} completed ${formatModeLabel(mode)} matches.`,
              'success',
            )

            c.executionCtx.waitUntil((async () => {
              try {
                await rebuildLeaderboardModeSnapshot(db, kv, matchContext.leaderboardMode)
              }
              catch (error) {
                console.error(`Failed to rebuild leaderboard snapshot after resolving match ${result.match.id}:`, error)
              }

              let rankedRoleLines: string[] = []
              if (guildId) {
                try {
                  const rankedPreview = await previewRankedRoles({
                    db,
                    kv,
                    guildId,
                    playerIds: participantIds,
                    includePlayerIdentities: false,
                  })
                  rankedRoleLines = await listRankedRoleMatchUpdateLines({
                    kv,
                    guildId,
                    preview: rankedPreview,
                    playerIds: participantIds,
                  })
                  await syncSeasonPeaksForPlayers(db, {
                    playerIds: participantIds,
                    playerPreviews: rankedPreview.playerPreviews,
                  })
                }
                catch (error) {
                  console.error(`Failed to preview ranked role changes after resolving match ${result.match.id}:`, error)
                }
              }

              if (existingLobby) {
                try {
                  const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, existingLobby, {
                    embeds: [lobbyResultEmbed(mode, result.participants, moderation, {
                      rankedRoleLines,
                    }, existingLobby.draftConfig.redDeath)],
                    components: [],
                  })
                  await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
                }
                catch (error) {
                  console.error(`Failed to update resolved result embed for match ${result.match.id}:`, error)
                }
              }

              const archiveChannelId = await getSystemChannel(kv, 'archive')
              if (archiveChannelId) {
                try {
                  const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
                    embeds: [lobbyResultEmbed(mode, result.participants, moderation, {
                      rankedRoleLines,
                    }, matchContext.redDeath)],
                  })
                  await storeMatchMessageMapping(db, archiveMessage.id, result.match.id)
                }
                catch (error) {
                  console.error(`Failed to post archive resolve note for match ${result.match.id}:`, error)
                }
              }
            })())
          }
          catch (error) {
            console.error(`Failed to resolve match ${matchId} by moderator:`, error)
            try {
              await sendTransientEphemeralResponse(c, 'Failed to resolve match. Check bot logs for details.', 'error')
            }
            catch (responseError) {
              console.error(`Failed to send resolve error response for match ${matchId}:`, responseError)
            }
          }
        })
      }

      default:
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, 'Unknown mod subcommand.', 'error')
        })
    }
  },
)
