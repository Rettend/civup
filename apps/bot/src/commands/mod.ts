import type { GameMode, Leader, QueueEntry } from '@civup/game'
import type { ManualReportedMatchPlayerInput } from '../services/match/index.ts'
import type { MatchVar } from './match/shared'
import { createDb } from '@civup/db'
import { formatModeLabel, GAME_MODE_CHOICES, getLeader, getLeaders, parseGameMode, playerCountOptions, searchLeaders, slotToTeamIndex } from '@civup/game'
import { Autocomplete, Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { lobbyCancelledEmbed, lobbyResultEmbed } from '../embeds/match'
import { createChannelMessage } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { filterQueueEntriesForLobby, getLobbyById, setLobbyStatus } from '../services/lobby/index.ts'
import { upsertLobbyMessage } from '../services/lobby/message.ts'
import { cancelMatchByModerator, correctMatchLeadersByModerator, createManualReportedMatch, getStoredGameModeContext, resolveMatchByModerator } from '../services/match/index.ts'
import { storeMatchMessageMapping } from '../services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../services/match/report-discord.ts'
import { canUseModCommands, parseRoleIds } from '../services/permissions/index.ts'
import { listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles } from '../services/ranked/role-sync.ts'
import { sendEphemeralResponse, sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { syncSeasonPeaksForPlayers } from '../services/season/index.ts'
import { getSessionLobbyProjectionByMatch } from '../services/session/index.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { isMatchTournamentLinked } from '../services/tournament/index.ts'
import { factory } from '../setup'
import { buildFfaPlacementOptions, collectFfaPlacementUserIds, getIdentity, getIdentityByUserId } from './match/shared'

interface ModVar extends MatchVar {
  leader?: string
  reason?: string
  swap_with?: string
  [key: `player_${number}`]: string | undefined
  [key: `leader_${number}`]: string | undefined
}

const LIVE_LEADER_ID_SET = new Set(getLeaders('live').map(leader => leader.id))
const MANUAL_MATCH_MAX_PLAYERS = 12
const MANUAL_MATCH_SLOT_NUMBERS = Array.from({ length: MANUAL_MATCH_MAX_PLAYERS }, (_, index) => index + 1)

export const command_mod = factory.autocomplete<ModVar>(
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
      new SubCommand('manual', 'Create a completed match report from players and leaders').options(
        new Option('mode', 'Game mode for the manual report').required().choices(...GAME_MODE_CHOICES),
        ...buildManualReportOptions(),
      ),
      new SubCommand('swap', 'Set or swap reported match leaders').options(
        new Option('match_id', 'Match ID').required(),
        new Option('player', 'Participant to correct', 'User').required(),
        new Option('leader', 'Leader to assign').autocomplete(),
        new Option('swap_with', 'Participant to swap leaders with', 'User'),
        new Option('reason', 'Optional short reason for correction').max_length(140),
      ),
    ),
  ),
  c => c.resAutocomplete(
    new Autocomplete(typeof c.focused?.value === 'string' ? c.focused.value : '').choices(
      ...buildLeaderAutocompleteChoices(typeof c.focused?.value === 'string' ? c.focused.value : ''),
    ),
  ),
  async (c) => {
    const guildId = c.interaction.guild_id
    const kv = getKvStore(c.env)
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

          const directLobby = await getLobbyById(kv, matchId) ?? await getSessionLobbyProjectionByMatch(db, matchId)
          if (directLobby && directLobby.status === 'open' && !directLobby.matchId) {
            const lobbyQueueEntries = filterQueueEntriesForLobby(directLobby, [])
            const cancelledLobby = await setLobbyStatus(kv, directLobby.id, 'cancelled', directLobby, {
              db,
              sessionNamespace: c.env.SessionDO,
              queueEntries: lobbyQueueEntries,
            }) ?? directLobby

            try {
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, cancelledLobby, {
                embeds: [lobbyCancelledEmbed(directLobby.mode, buildCancelledLobbyParticipants(directLobby, lobbyQueueEntries), 'cancel', { actorId, reason }, directLobby.draftConfig.leaderDataVersion, directLobby.draftConfig.redDeath)],
                components: [],
              }, { db, sessionNamespace: c.env.SessionDO })
            }
            catch (error) {
              console.error(`Failed to update cancelled embed for lobby ${directLobby.id}:`, error)
            }

            await sendTransientEphemeralResponse(c, `Cancelled open lobby **${directLobby.id}**.`, 'success')
            return
          }

          const existingLobby = directLobby?.matchId ? directLobby : await getSessionLobbyProjectionByMatch(db, matchId)
          const result = await cancelMatchByModerator(db, kv, {
            matchId,
            cancelledAt: Date.now(),
          }, {
            sessionNamespace: c.env.SessionDO,
            rankedRoleGuildId: existingLobby?.guildId ?? c.interaction.guild_id ?? null,
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
          const isTournamentMatch = await isMatchTournamentLinked(db, result.match.id)
          const archiveChannelType = isTournamentMatch ? 'tournament-archive' : 'archive'

          if (existingLobby) {
            try {
              const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, existingLobby, {
                embeds: [lobbyCancelledEmbed(mode, result.participants, 'cancel', moderation, existingLobby.draftConfig.leaderDataVersion, existingLobby.draftConfig.redDeath)],
                components: [],
              }, { db, sessionNamespace: c.env.SessionDO })
              await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
            }
            catch (error) {
              console.error(`Failed to update cancelled embed for match ${result.match.id}:`, error)
            }
          }

          const shouldArchiveCancellation = result.previousStatus === 'completed'
          const archiveChannelId = shouldArchiveCancellation ? await getSystemChannel(kv, archiveChannelType) : null
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

          const isRankedMatch = matchContext.ranked
          try {
            if (!isTournamentMatch && !matchContext.redDeath) {
              await markLeaderboardsDirty(db, `mod-cancel:${result.match.id}`, {
                civ: true,
                modes: matchContext.leaderboardMode ? [matchContext.leaderboardMode] : [],
              })
            }
          }
          catch (error) {
            console.error(`Failed to mark leaderboards dirty after cancelling match ${result.match.id}:`, error)
          }

          try {
            if (!isTournamentMatch && isRankedMatch) {
              await markRankedRolesDirty(kv, `mod-cancel:${result.match.id}`)
            }
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
            }, {
              sessionNamespace: c.env.SessionDO,
              rankedRoleGuildId: c.interaction.guild_id ?? null,
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

            const existingLobby = result.previousStatus === 'completed' ? null : await getSessionLobbyProjectionByMatch(db, result.match.id)
            const mode = matchContext.mode
            const moderation = { actorId, reason }
            const guildId = existingLobby?.guildId ?? c.interaction.guild_id ?? null
            const participantIds = result.participants.map(participant => participant.playerId)
            const isRankedMatch = matchContext.ranked
            const isTournamentMatch = await isMatchTournamentLinked(db, result.match.id)
            const archiveChannelType = isTournamentMatch ? 'tournament-archive' : 'archive'

            try {
              if (!isTournamentMatch && !matchContext.redDeath) {
                await markLeaderboardsDirty(db, `mod-resolve:${result.match.id}`, {
                  civ: true,
                  modes: matchContext.leaderboardMode ? [matchContext.leaderboardMode] : [],
                })
              }
            }
            catch (error) {
              console.error(`Failed to mark leaderboards dirty after resolving match ${result.match.id}:`, error)
            }

            try {
              if (!isTournamentMatch && isRankedMatch) {
                await markRankedRolesDirty(kv, `mod-resolve:${result.match.id}`)
              }
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
              let rankedRoleLines: string[] = []
              if (!isTournamentMatch && isRankedMatch && guildId) {
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
                  }, { db, sessionNamespace: c.env.SessionDO })
                  await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
                }
                catch (error) {
                  console.error(`Failed to update resolved result embed for match ${result.match.id}:`, error)
                }
              }

              const archiveChannelId = await getSystemChannel(kv, archiveChannelType)
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

      // ── match manual ────────────────────────────────────
      case 'match manual': {
        const parsedInput = parseManualReportInput(c)
        if ('error' in parsedInput) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, parsedInput.error, 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          try {
            const db = createDb(c.env.DB)
            const actor = getIdentity(c)
            if (!actor) {
              await sendTransientEphemeralResponse(c, 'Could not identify moderator user.', 'error')
              return
            }

            const result = await createManualReportedMatch(db, kv, {
              mode: parsedInput.mode,
              players: parsedInput.players,
              reporterId: actor.userId,
              reportedAt: Date.now(),
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

            const guildId = c.interaction.guild_id ?? null
            const participantIds = result.participants.map(participant => participant.playerId)
            try {
              if (!matchContext.redDeath) {
                await markLeaderboardsDirty(db, `mod-manual:${result.match.id}`, {
                  civ: true,
                  modes: matchContext.leaderboardMode ? [matchContext.leaderboardMode] : [],
                })
              }
            }
            catch (error) {
              console.error(`Failed to mark leaderboards dirty after creating manual match ${result.match.id}:`, error)
            }

            try {
              if (matchContext.ranked) {
                await markRankedRolesDirty(kv, `mod-manual:${result.match.id}`)
              }
            }
            catch (error) {
              console.error(`Failed to mark ranked roles dirty after creating manual match ${result.match.id}:`, error)
            }

            await sendEphemeralResponse(
              c,
              `Created manual ${formatModeLabel(parsedInput.mode, parsedInput.mode, { targetSize: parsedInput.players.length })} match **${result.match.id}**. Recalculated ${result.recalculatedMatchIds.length} completed matches.`,
              'success',
            )

            c.executionCtx.waitUntil((async () => {
              let rankedRoleLines: string[] = []
              if (matchContext.ranked && guildId) {
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
                  console.error(`Failed to preview ranked role changes after creating manual match ${result.match.id}:`, error)
                }
              }

              const syncResult = await syncReportedMatchDiscordMessages({
                db,
                kv,
                token: c.env.DISCORD_TOKEN,
                matchId: result.match.id,
                reportedMode: matchContext.mode,
                reportedRedDeath: matchContext.redDeath,
                participants: result.participants,
                rankedRoleLines,
                matchDraftData: result.match.draftData,
                reporter: actor,
                archivePolicy: 'always',
              })
              if (syncResult.errors.length > 0) {
                console.error(`Failed to sync manual match ${result.match.id} embeds:`, syncResult.errors)
              }
            })())
          }
          catch (error) {
            console.error('Failed to create manual match report:', error)
            try {
              await sendTransientEphemeralResponse(c, 'Failed to create manual match report. Check bot logs for details.', 'error')
            }
            catch (responseError) {
              console.error('Failed to send manual match error response:', responseError)
            }
          }
        })
      }

      // ── match swap ──────────────────────────────────────
      case 'match swap': {
        const matchId = c.var.match_id
        const playerId = c.var.player
        const leaderInput = c.var.leader?.trim() ?? ''
        const swapWithPlayerId = c.var.swap_with ?? null
        const reason = c.var.reason?.trim() ?? null

        if (!matchId || !playerId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please provide a match ID and player.', 'error')
          })
        }

        const hasLeader = leaderInput.length > 0
        const hasSwapWith = Boolean(swapWithPlayerId)
        if (hasLeader === hasSwapWith) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Provide exactly one of `leader` or `swap_with`.', 'error')
          })
        }

        const leaderId = hasLeader ? resolveLeaderInput(leaderInput) : null
        if (hasLeader && !leaderId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Choose a leader from the autocomplete suggestions.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          try {
            const db = createDb(c.env.DB)
            const result = await correctMatchLeadersByModerator(db, {
              matchId,
              playerId,
              leaderId,
              swapWithPlayerId,
              correctedAt: Date.now(),
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
            const isTournamentMatch = await isMatchTournamentLinked(db, result.match.id)

            try {
              if (!isTournamentMatch && !matchContext.redDeath && result.corrections.some(correction => correction.previousCivId !== correction.nextCivId)) {
                await markLeaderboardsDirty(db, `mod-leader:${result.match.id}`, { civ: true })
              }
            }
            catch (error) {
              console.error(`Failed to mark leaderboards dirty after correcting leaders for match ${result.match.id}:`, error)
            }

            await sendEphemeralResponse(
              c,
              `Updated leaders for match **${result.match.id}**.${reason ? ` Reason: ${reason}` : ''}\n${formatLeaderCorrections(result.corrections)}`,
              'success',
            )

            c.executionCtx.waitUntil((async () => {
              const existingLobby = await getSessionLobbyProjectionByMatch(db, result.match.id)
              const syncResult = await syncReportedMatchDiscordMessages({
                db,
                kv,
                token: c.env.DISCORD_TOKEN,
                matchId: result.match.id,
                reportedMode: matchContext.mode,
                reportedRedDeath: matchContext.redDeath,
                participants: result.participants,
                lobby: existingLobby,
                sessionNamespace: c.env.SessionDO,
                matchDraftData: result.match.draftData,
                archivePolicy: 'if-missing',
                archiveChannelType: isTournamentMatch ? 'tournament-archive' : 'archive',
              })
              if (syncResult.errors.length > 0) {
                console.error(`Failed to refresh leader-corrected match ${result.match.id} embeds:`, syncResult.errors)
              }
            })())
          }
          catch (error) {
            console.error(`Failed to correct leaders for match ${matchId} by moderator:`, error)
            try {
              await sendTransientEphemeralResponse(c, 'Failed to correct match leaders. Check bot logs for details.', 'error')
            }
            catch (responseError) {
              console.error(`Failed to send leader correction error response for match ${matchId}:`, responseError)
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

function buildCancelledLobbyParticipants(lobby: { mode: GameMode, slots: (string | null)[] }, entries: QueueEntry[]) {
  const entryByPlayerId = new Map(entries.map(entry => [entry.playerId, entry]))
  return lobby.slots
    .map((playerId, slot) => {
      if (!playerId) return null
      const entry = entryByPlayerId.get(playerId)
      return {
        playerId,
        team: slotToTeamIndex(lobby.mode, slot, lobby.slots.length),
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
        displayName: entry?.displayName,
      }
    })
    .filter((participant): participant is NonNullable<typeof participant> => participant != null)
}

function buildManualReportOptions() {
  return MANUAL_MATCH_SLOT_NUMBERS.flatMap(slot => [
    new Option(`player_${slot}`, `Slot ${slot} player`, 'User'),
    new Option(`leader_${slot}`, `Slot ${slot} leader`).autocomplete(),
  ])
}

type ManualReportParseResult = {
  mode: GameMode
  players: ManualReportedMatchPlayerInput[]
} | { error: string }

function parseManualReportInput(c: Parameters<typeof getIdentityByUserId>[0] & { var: ModVar }): ManualReportParseResult {
  const mode = parseGameMode(c.var.mode)
  if (!mode) return { error: 'Please provide a valid game mode.' }

  const highestSlot = findHighestManualReportSlot(c.var)
  if (highestSlot === 0) return { error: 'Provide player and leader slots for the completed match.' }

  const allowedCounts = playerCountOptions(mode)
  if (!allowedCounts.includes(highestSlot)) {
    return { error: `${formatModeLabel(mode, mode)} manual reports require ${formatAllowedCounts(allowedCounts)} players. Fill slots 1-${allowedCounts[allowedCounts.length - 1]}.` }
  }

  const playerIds = new Set<string>()
  const leaderIds = new Set<string>()
  const players: ManualReportedMatchPlayerInput[] = []

  for (let slot = 1; slot <= highestSlot; slot++) {
    const playerId = c.var[`player_${slot}`]?.trim() ?? ''
    const leaderInput = c.var[`leader_${slot}`]?.trim() ?? ''
    if (!playerId || !leaderInput) return { error: `Slot ${slot} needs both a player and a leader.` }

    if (playerIds.has(playerId)) return { error: `<@${playerId}> is listed more than once.` }
    playerIds.add(playerId)

    const leaderId = resolveLeaderInput(leaderInput)
    if (!leaderId) return { error: `Choose slot ${slot}'s leader from the autocomplete suggestions.` }
    if (leaderIds.has(leaderId)) return { error: `${formatLeaderLabel(leaderId)} is listed more than once.` }
    leaderIds.add(leaderId)

    const identity = getIdentityByUserId(c, playerId)
    players.push({
      playerId,
      displayName: identity?.displayName ?? playerId,
      avatarUrl: identity?.avatarUrl ?? null,
      civId: leaderId,
    })
  }

  return { mode, players }
}

function findHighestManualReportSlot(vars: ModVar): number {
  let highestSlot = 0
  for (const slot of MANUAL_MATCH_SLOT_NUMBERS) {
    const hasPlayer = Boolean(vars[`player_${slot}`]?.trim())
    const hasLeader = Boolean(vars[`leader_${slot}`]?.trim())
    if (hasPlayer || hasLeader) highestSlot = slot
  }
  return highestSlot
}

function formatAllowedCounts(counts: readonly number[]): string {
  if (counts.length === 1) return String(counts[0])
  return `${counts.slice(0, -1).join(', ')} or ${counts[counts.length - 1]}`
}

function buildLeaderAutocompleteChoices(query: string): Array<{ name: string, value: string }> {
  const leaders = query.trim().length > 0 ? searchLeaders(query, 'live') : getLeaders('live')
  const seen = new Set<string>()
  const choices: Array<{ name: string, value: string }> = []

  for (const leader of leaders) {
    if (!LIVE_LEADER_ID_SET.has(leader.id) || seen.has(leader.id)) continue
    seen.add(leader.id)
    choices.push({
      name: truncateAutocompleteName(formatLeaderAutocompleteName(leader)),
      value: leader.id,
    })
    if (choices.length >= 25) break
  }

  return choices
}

function resolveLeaderInput(input: string): string | null {
  const normalized = input.trim()
  if (LIVE_LEADER_ID_SET.has(normalized)) return normalized

  const lower = normalized.toLowerCase()
  const exact = getLeaders('live').find(leader => leader.name.toLowerCase() === lower || `${leader.name} ${leader.civilization}`.toLowerCase() === lower)
  if (exact) return exact.id

  const matches = searchLeaders(normalized, 'live').filter(leader => LIVE_LEADER_ID_SET.has(leader.id))
  return matches.length === 1 ? matches[0]!.id : null
}

function formatLeaderCorrections(corrections: Array<{ playerId: string, previousCivId: string | null, nextCivId: string | null }>): string {
  return corrections
    .map(correction => `<@${correction.playerId}>: ${formatLeaderLabel(correction.previousCivId)} -> ${formatLeaderLabel(correction.nextCivId)}`)
    .join('\n')
}

function formatLeaderLabel(leaderId: string | null): string {
  if (!leaderId) return 'No leader'
  try {
    const leader = getLeader(leaderId, 'live')
    return `${leader.name} (${leader.civilization})`
  }
  catch {
    return leaderId
  }
}

function formatLeaderAutocompleteName(leader: Leader): string {
  return `${leader.name} - ${leader.civilization}`
}

function truncateAutocompleteName(name: string): string {
  return name.length <= 100 ? name : `${name.slice(0, 97)}...`
}
