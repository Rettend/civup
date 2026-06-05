import type { DraftSeat, GameMode, QueueEntry, ResolvedMapVoteResult } from '@civup/game'
import type { EphemeralResponseTone } from '../../embeds/response.ts'
import type { Env } from '../../env.ts'
import type { LobbyState } from '../../services/lobby/index.ts'
import type { MatchJoinEntry, MatchVar } from './shared.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { defaultPlayerCount, formatModeLabel, GAME_MODE_CHOICES, GAME_MODES, isTeamMode, minPlayerCount, parseGameMode, slotToTeamIndex, startPlayerCountOptions } from '@civup/game'
import { Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { eq } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed, lobbyDraftingEmbed, lobbyOpenEmbed } from '../../embeds/match.ts'
import { getMatchForUser } from '../../services/activity/index.ts'
import { storeActivityLaunchTargetSelection } from '../../services/activity/launch-target.ts'
import { createChannelMessage, deleteChannelMessage } from '../../services/discord/index.ts'
import { getKvStore } from '../../services/kv/batch.ts'
import { markLeaderboardsDirty } from '../../services/leaderboard/message.ts'
import { createLobby, filterQueueEntriesForLobby, getLobbyBumpCooldownRemainingMs, getLobbyById, mapLobbySlotsToEntries, markLobbyBumped, normalizeLobbySlots, repostLobbyMessage, setLobbyLastActivityAt, setLobbyRoster, setLobbyStatus, setLobbySteamLobbyLink } from '../../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { upsertLobbyMessage } from '../../services/lobby/message.ts'
import { buildOpenLobbyRenderPayload } from '../../services/lobby/render.ts'
import { cancelMatchByModerator, getStoredGameModeContext, releaseReportedMatchProcessingClaim, reportMatch } from '../../services/match/index.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from '../../services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../../services/match/report-discord.ts'
import { markRankedRolesDirty } from '../../services/ranked/role-sync.ts'
import { clearDeferredEphemeralResponse, sendEphemeralResponse, sendTransientEphemeralResponse } from '../../services/response/ephemeral.ts'
import { formatSessionAdmissionError, getLiveSessionLobbyProjections, getLiveSessionLobbyProjectionsForUser, getLiveSessionLobbyProjectionsHostedBy, getOpenSessionLobbyProjectionForPlayer, getOpenSessionLobbyProjectionHostedBy, getOpenSessionLobbyProjectionsByMode, getSessionLobbyProjectionByMatch, isSessionAdmissionError } from '../../services/session/index.ts'
import { MAX_STEAM_LOBBY_LINK_LENGTH, parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../../services/steam-link.ts'
import { getSystemChannel } from '../../services/system/channels.ts'
import { buildTournamentReservedSlotLabels, getTournamentMatchBySessionId, isMatchTournamentLinked, listOpenTournamentSessionIds, refreshTournamentLeaderboard, updateTournamentMatchRoster } from '../../services/tournament/index.ts'
import { getSessionRecord, queueSessionReportedDiscordSync } from '../../session-runtime/session-do-client.ts'
import { buildSessionRosterQueueEntries } from '../../session-runtime/session-record.ts'
import { factory } from '../../setup.ts'
import { buildFfaPlacementOptions, collectFfaPlacementUserIds, findBlockingDraftMatchIdsForPlayers, getIdentity, joinLobbyAndMaybeStartMatch, LOBBY_STATUS_LABELS, preflightMatchCreateSessionState, resolveReportableMatchIdForPlayer } from './shared.ts'

const MATCH_MODE_CHOICES = GAME_MODE_CHOICES
const MATCH_BUMP_RESPONSE_DELETE_MS = 5_000

type MatchCreateOutcome
  = | { kind: 'clear' }
    | { kind: 'message', message: string, tone: EphemeralResponseTone }

interface CreateMatchLobbyInput {
  env: Env['Bindings']
  kv: KVNamespace
  mode: GameMode
  steamLobbyLink: string | null
  interactionChannelId: string | null
  draftChannelId: string
  guildId: string | null
  identity: { userId: string, displayName: string, avatarUrl: string }
}

interface DeferredMatchCreateContext {
  executionCtx: { waitUntil: (promise: Promise<unknown>) => void }
  followup: (data?: any) => Promise<unknown>
}

function buildMatchCreateSubCommand() {
  return new SubCommand('create', 'Create a lobby and auto-join as host').options(
    new Option('mode', 'Game mode for the lobby')
      .required()
      .choices(...MATCH_MODE_CHOICES),
    new Option('steam_link', 'Optional Civ 6 Steam lobby link').max_length(MAX_STEAM_LOBBY_LINK_LENGTH),
  )
}

export const command_match = factory.command<MatchVar>(
  new Command('match', 'Looking for game and lobby management').options(
    buildMatchCreateSubCommand(),
    new SubCommand('join', 'Join an open lobby for a game mode').options(
      new Option('mode', 'Game mode to join')
        .required()
        .choices(...MATCH_MODE_CHOICES),
    ),
    new SubCommand('activity', 'Open the activity for this channel'),
    new SubCommand('cancel', 'Cancel your hosted open or live lobby').options(
      new Option('match_id', 'Optional match or lobby ID override'),
    ),
    new SubCommand('leave', 'Leave the current open lobby'),
    new SubCommand('bump', 'Repost the embed for your current lobby').options(
      new Option('match_id', 'Optional match or lobby ID override'),
    ),
    new SubCommand('status', 'Show all active lobbies'),
    new SubCommand('report', 'Report your draft-complete match result').options(
      new Option('match_id', 'Optional match ID override'),
      new Option('winner', 'Winner or 1st place', 'User'),
      ...buildFfaPlacementOptions(),
    ),
    new SubGroup('steam', 'Manage the Civ 6 Steam lobby link').options(
      new SubCommand('set', 'Set or update the Steam lobby link').options(
        new Option('steam_link', 'Civ 6 Steam lobby link').required().max_length(MAX_STEAM_LOBBY_LINK_LENGTH),
        new Option('match_id', 'Optional match or lobby ID override'),
      ),
      new SubCommand('clear', 'Clear the Steam lobby link').options(
        new Option('match_id', 'Optional match or lobby ID override'),
      ),
    ),
  ),
  async (c) => {
    switch (c.sub.string) {
      // ── create ──────────────────────────────────────────
      case 'create': {
        const mode = parseGameMode(c.var.mode)
        const steamLobbyLink = parseSteamLobbyLink(c.var.steam_link)
        const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
        const guildId = c.interaction.guild_id ?? null
        const identity = getIdentity(c)
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          try {
            if (!mode) {
              await sendTransientEphemeralResponse(c, 'Please provide a valid game mode.', 'error')
              return
            }
            if (!identity) {
              await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
              return
            }
            if (steamLobbyLink === undefined) {
              await sendTransientEphemeralResponse(c, STEAM_LOBBY_LINK_ERROR, 'error')
              return
            }

            const kv = getKvStore(c.env)
            const draftChannelId = await getSystemChannel(kv, 'draft')
            if (!draftChannelId) {
              await sendTransientEphemeralResponse(
                c,
                'Draft channel is not configured. Run `/admin setup target:Draft` to set up this channel.',
                'error',
              )
              return
            }

            const outcome = await createMatchLobby({
              env: c.env,
              kv,
              mode,
              steamLobbyLink,
              interactionChannelId,
              draftChannelId,
              guildId,
              identity,
            })
            await sendDeferredMatchCreateOutcome(c, outcome)
          }
          catch (error) {
            console.error('[match:create] unexpected failure', {
              mode,
              interactionChannelId,
              userId: identity?.userId,
            }, error)
            try {
              await sendTransientEphemeralResponse(c, 'Failed to create lobby. Check bot logs for details.', 'error')
            }
            catch (followupError) {
              console.error('[match:create] failed to send error followup', followupError)
            }
          }
        })
      }

      // ── join ────────────────────────────────────────────
      case 'join': {
        const mode = parseGameMode(c.var.mode)
        const kv = getKvStore(c.env)
        const identity = getIdentity(c)
        const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
        if (!mode) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Please provide a valid game mode.', 'error')
          })
        }
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        const joinRequest = buildMatchJoinRequest(c, mode, identity)
        if ('error' in joinRequest) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, joinRequest.error, 'error')
          })
        }

        const db = createDb(c.env.DB)
        const tournamentSessionIds = await listOpenTournamentSessionIds(db)
        const openLobbies = (await getOpenSessionLobbyProjectionsByMode(db, mode)).filter(lobby => !tournamentSessionIds.has(lobby.id))
        if (openLobbies.length === 0) {
          if (joinRequest.entries.length > 1) {
            return c.flags('EPHEMERAL').resDefer(async (c) => {
              await sendTransientEphemeralResponse(c, `No active ${formatModeLabel(mode)} lobby. Use \`/match create\` first.`, 'error')
            })
          }

          let userMatchId = await getMatchForUser(db, identity.userId)
          if (!userMatchId) {
            userMatchId = (await findBlockingDraftMatchIdsForPlayers(db, [identity.userId])).get(identity.userId) ?? null
          }

          if (userMatchId) {
            await storeActivityLaunchTargetSelection(c.env.Activity, c.env.CIVUP_SECRET, interactionChannelId, identity.userId, { kind: 'match', id: userMatchId })
            return c.resActivity()
          }
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, `No active ${formatModeLabel(mode)} lobby. Use \`/match create\` first.`, 'error')
          })
        }

        const blockingDraftMatchIdByPlayer = await findBlockingDraftMatchIdsForPlayers(db, joinRequest.entries.map(entry => entry.playerId))
        if (blockingDraftMatchIdByPlayer.size > 0) {
          const playersInLiveMatch = joinRequest.entries
            .map(entry => entry.playerId)
            .filter(playerId => blockingDraftMatchIdByPlayer.has(playerId))
          if (playersInLiveMatch.length > 0) {
            const mentions = playersInLiveMatch.map(playerId => `<@${playerId}>`).join(', ')
            return c.flags('EPHEMERAL').resDefer(async (c) => {
              await sendTransientEphemeralResponse(c, `${mentions} ${playersInLiveMatch.length === 1 ? 'is' : 'are'} already in a live match.`, 'error')
            })
          }
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const outcome = await joinLobbyAndMaybeStartMatch(
            c,
            mode,
            joinRequest.entries,
            { liveMatchPlayerIds: new Set(blockingDraftMatchIdByPlayer.keys()) },
          )
          if ('error' in outcome) {
            await sendTransientEphemeralResponse(c, outcome.error, 'error')
            return
          }

          try {
            await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, outcome.lobby, {
              embeds: outcome.embeds,
              components: outcome.components,
            }, { db, sessionNamespace: c.env.SessionDO })

            await clearDeferredEphemeralResponse(c)
          }
          catch (error) {
            console.error('Failed to update lobby message after slash join:', error)
            await sendTransientEphemeralResponse(c, 'Joined lobby, but failed to update lobby embed.', 'error')
          }
        })
      }

      // ── activity ────────────────────────────────
      case 'activity': {
        return c.resActivity()
      }

      // ── cancel ──────────────────────────────────────────
      case 'cancel': {
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = getKvStore(c.env)
          const db = createDb(c.env.DB)
          const targetId = c.var.match_id?.trim() ?? null

          if (targetId) {
            const lobbyById = await getLobbyById(kv, targetId)
            const lobbyByMatch = lobbyById?.matchId === targetId
              ? lobbyById
              : await getSessionLobbyProjectionByMatch(db, targetId)
            if (lobbyById?.hostId !== identity.userId) {
              if (!lobbyByMatch || lobbyByMatch.hostId !== identity.userId) {
                await sendTransientEphemeralResponse(c, 'You can only cancel your own hosted lobby or match.', 'error')
                return
              }
            }

            const openLobby = lobbyById && !lobbyById.matchId ? lobbyById : lobbyByMatch?.status === 'open' && !lobbyByMatch.matchId ? lobbyByMatch : null
            if (openLobby) {
              await cancelHostedOpenLobby(c.env.DISCORD_TOKEN, kv, openLobby, {
                db,
                sessionNamespace: c.env.SessionDO,
              })
              await sendTransientEphemeralResponse(c, `Cancelled hosted ${formatModeLabel(openLobby.mode)} lobby.`, 'success')
              return
            }

            const lobby = lobbyById ?? lobbyByMatch
            const matchId = lobby?.matchId ?? targetId
            if (!lobby || !matchId) {
              await sendTransientEphemeralResponse(c, 'Could not find that hosted lobby or match.', 'error')
              return
            }

            const result = await cancelMatchByModerator(db, kv, {
              matchId,
              cancelledAt: Date.now(),
            }, {
              sessionNamespace: c.env.SessionDO,
              rankedRoleGuildId: lobby.guildId,
            })

            if ('error' in result) {
              await sendTransientEphemeralResponse(c, result.error, 'error')
              return
            }

            try {
              const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'cancel', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath, undefined, lobby.draftConfig.civBlitz)],
                components: [],
              }, { db, sessionNamespace: c.env.SessionDO })
              await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
            }
            catch (error) {
              console.error(`Failed to update cancelled lobby embed for match ${matchId}:`, error)
            }

            if (result.previousStatus === 'completed') {
              const cancelContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
              try {
                if (cancelContext && !cancelContext.redDeath) {
                  await markLeaderboardsDirty(db, `match-cancel:${result.match.id}`, {
                    civ: true,
                    modes: cancelContext.leaderboardMode ? [cancelContext.leaderboardMode] : [],
                  })
                }
              }
              catch (error) {
                console.error(`Failed to mark leaderboards dirty after cancelling match ${result.match.id}:`, error)
              }

              try {
                if (cancelContext?.ranked) {
                  await markRankedRolesDirty(kv, `match-cancel:${result.match.id}`)
                }
              }
              catch (error) {
                console.error(`Failed to mark ranked roles dirty after cancelling match ${result.match.id}:`, error)
              }
            }

            await sendTransientEphemeralResponse(c, `Cancelled hosted match **${matchId}**.`, 'success')
            return
          }

          const hostedLobby = await findHostedOpenLobby(db, identity.userId)
          if (!hostedLobby) {
            await sendTransientEphemeralResponse(c, 'No hosted open lobby found. Pass `match_id` to cancel a live match.', 'error')
            return
          }

          await cancelHostedOpenLobby(c.env.DISCORD_TOKEN, kv, hostedLobby, {
            db,
            sessionNamespace: c.env.SessionDO,
          })
          await sendTransientEphemeralResponse(c, `Cancelled hosted ${formatModeLabel(hostedLobby.mode)} lobby.`, 'success')
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
          const kv = getKvStore(c.env)
          const db = createDb(c.env.DB)
          const currentLobby = await getOpenSessionLobbyProjectionForPlayer(db, identity.userId)

          if (currentLobby?.hostId === identity.userId) {
            await sendTransientEphemeralResponse(c, 'You are hosting this lobby. Use `/match cancel` instead.', 'error')
            return
          }

          if (!currentLobby) {
            const userMatchId = await getMatchForUser(db, identity.userId)
            if (userMatchId) {
              await sendTransientEphemeralResponse(c, 'You are not in an open lobby right now.', 'error')
              return
            }

            await sendTransientEphemeralResponse(c, 'You are not in an open lobby.', 'error')
            return
          }

          const lobby = currentLobby
          if (lobby?.status === 'open') {
            const rosterEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
            const nextMemberIds = lobby.memberPlayerIds.filter(playerId => playerId !== identity.userId)
            const lobbyQueueEntries = filterQueueEntriesForLobby({ ...lobby, memberPlayerIds: nextMemberIds }, rosterEntries)
            const slots = normalizeLobbySlots(lobby.mode, lobby.slots, lobbyQueueEntries)
            const activityAt = Date.now()
            const nextLobby = await setLobbyRoster(kv, lobby.id, {
              memberPlayerIds: nextMemberIds,
              slots,
              lastActivityAt: activityAt,
              now: activityAt,
            }, lobby, { db: createDb(c.env.DB), sessionNamespace: c.env.SessionDO }) ?? lobby
            const nextLobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, nextLobby, rosterEntries)
            const nextSlots = normalizeLobbySlots(lobby.mode, nextLobby.slots, nextLobbyQueueEntries)
            await syncLobbyDerivedState(kv, nextLobby, {
              queueEntries: nextLobbyQueueEntries,
              slots: nextSlots,
            })
            if (await getTournamentMatchBySessionId(db, nextLobby.id)) await updateTournamentMatchRoster(db, nextLobby.id, nextMemberIds)
            const slottedEntries = mapLobbySlotsToEntries(nextSlots, nextLobbyQueueEntries)
            try {
              const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries, {
                reservedSlotLabels: await buildTournamentReservedSlotLabels(db, nextLobby),
              })
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, nextLobby, {
                embeds: renderPayload.embeds,
                components: renderPayload.components,
              }, { db, sessionNamespace: c.env.SessionDO })
            }
            catch (error) {
              console.error('Failed to update lobby message after leave:', error)
            }
          }

          await clearDeferredEphemeralResponse(c)
        })
      }

      // ── bump ────────────────────────────────────────────
      case 'bump': {
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendMatchBumpResponse(c, 'Could not identify you.', 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = getKvStore(c.env)
          const db = createDb(c.env.DB)
          const targetId = c.var.match_id?.trim() ?? null
          const resolvedTarget = await resolveLobbyBumpTarget(db, kv, identity.userId, targetId)
          if ('error' in resolvedTarget) {
            await sendMatchBumpResponse(c, resolvedTarget.error, 'error')
            return
          }

          const currentLobby = resolvedTarget.lobby
          const retryAfterMs = await getLobbyBumpCooldownRemainingMs(kv, currentLobby.id)
          if (retryAfterMs > 0) {
            await sendMatchBumpResponse(
              c,
              `This ${describeEditableLobbyTarget(currentLobby)} was just bumped. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
              'info',
            )
            return
          }

          try {
            const renderPayload = await buildLobbyBumpRenderPayload(db, kv, currentLobby, c.env.SessionDO)
            if ('error' in renderPayload) {
              await sendMatchBumpResponse(c, renderPayload.error, 'error')
              return
            }

            const reposted = await repostLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, renderPayload, { db, sessionNamespace: c.env.SessionDO })
            let updatedLobby = reposted.lobby
            if (updatedLobby.status === 'open') {
              updatedLobby = await setLobbyLastActivityAt(kv, updatedLobby.id, Date.now(), updatedLobby, { db, sessionNamespace: c.env.SessionDO }) ?? updatedLobby
              await syncLobbyDerivedState(kv, updatedLobby)
            }

            if (updatedLobby.matchId) {
              try {
                await storeMatchMessageMapping(db, updatedLobby.messageId, updatedLobby.matchId)
                if (reposted.previousMessageId !== updatedLobby.messageId) {
                  await clearMatchMessageMapping(db, reposted.previousMessageId)
                }
              }
              catch (error) {
                console.error(`Failed to rebind bumped lobby message mapping for match ${updatedLobby.matchId}:`, error)
              }
            }

            if (reposted.previousMessageId !== updatedLobby.messageId) {
              try {
                await deleteChannelMessage(c.env.DISCORD_TOKEN, updatedLobby.channelId, reposted.previousMessageId)
              }
              catch (error) {
                console.error(`Failed to delete bumped lobby message ${reposted.previousMessageId}:`, error)
              }
            }

            try {
              await markLobbyBumped(kv, updatedLobby.id)
            }
            catch (error) {
              console.error(`Failed to store bump cooldown for lobby ${updatedLobby.id}:`, error)
            }

            await clearDeferredEphemeralResponse(c)
          }
          catch (error) {
            console.error(`Failed to bump lobby embed for lobby ${currentLobby.id}:`, error)
            await sendMatchBumpResponse(c, 'Failed to repost the lobby embed. Please try again.', 'error')
          }
        })
      }

      // ── steam set / clear ───────────────────────────────
      case 'steam set':
      case 'steam clear': {
        const identity = getIdentity(c)
        if (!identity) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
          })
        }

        const nextSteamLobbyLink = c.sub.string === 'steam set'
          ? parseSteamLobbyLink(c.var.steam_link)
          : null
        if (nextSteamLobbyLink === undefined || (c.sub.string === 'steam set' && nextSteamLobbyLink == null)) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, STEAM_LOBBY_LINK_ERROR, 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = getKvStore(c.env)
          const db = createDb(c.env.DB)
          const targetId = c.var.match_id?.trim() ?? null
          const resolvedTarget = await resolveHostedSteamLobbyTarget(db, kv, identity.userId, targetId)
          if ('error' in resolvedTarget) {
            await sendTransientEphemeralResponse(c, resolvedTarget.error, 'error')
            return
          }

          const currentLobby = resolvedTarget.lobby
          const updatedLobby = await setLobbySteamLobbyLink(kv, currentLobby.id, nextSteamLobbyLink, currentLobby, { db, sessionNamespace: c.env.SessionDO }) ?? currentLobby
          if (updatedLobby.revision !== currentLobby.revision) {
            await syncLobbyDerivedState(kv, updatedLobby)
          }
          const targetLabel = describeEditableLobbyTarget(updatedLobby)

          if (c.sub.string === 'steam clear') {
            if (currentLobby.steamLobbyLink == null) {
              await sendTransientEphemeralResponse(c, `No Steam lobby link was set for your hosted ${targetLabel}.`, 'info')
              return
            }

            await sendTransientEphemeralResponse(c, `Cleared the Steam lobby link for your hosted ${targetLabel}.`, 'success')
            return
          }

          if (currentLobby.steamLobbyLink === nextSteamLobbyLink) {
            await sendTransientEphemeralResponse(c, `That Steam lobby link is already set for your hosted ${targetLabel}.`, 'info')
            return
          }

          await sendTransientEphemeralResponse(c, `Set the Steam lobby link for your hosted ${targetLabel}.`, 'success')
        })
      }

      // ── status ──────────────────────────────────────────
      case 'status': {
        return c.resDefer(async (c) => {
          const kv = getKvStore(c.env)
          const db = createDb(c.env.DB)
          const modes = GAME_MODES
          const lines: string[] = []
          const guildId = c.interaction.guild_id ?? null

          for (const mode of modes) {
            const lobbies = await getLiveSessionLobbyProjections(db, { mode })
            if (lobbies.length === 0) continue

            for (const lobby of lobbies) {
              const label = LOBBY_STATUS_LABELS[lobby.status]
              const link = formatLobbyMessageLink(guildId, lobby.channelId, lobby.messageId)
              if (lobby.status === 'open') {
                const lobbyQueueEntries = await getLobbyRosterEntriesForRender(c.env.SessionDO, lobby)
                const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
                const filled = slots.filter(slot => slot != null).length
                const validCounts = startPlayerCountOptions(mode, slots.length, { redDeath: lobby.draftConfig.redDeath, permanentAlly: lobby.draftConfig.permanentAlly })
                const target = formatPlayerCountList(validCounts, slots.length)
                lines.push(`- ${formatModeLabel(mode)} - ${label} (${filled}/${target}) - ${link} - \`${lobby.id}\``)
                continue
              }

              const idSuffix = lobby.matchId ? ` - \`${lobby.matchId}\`` : ` - \`${lobby.id}\``
              lines.push(`- ${formatModeLabel(mode)} - ${label} - ${link}${idSuffix}`)
            }
          }

          if (lines.length === 0) {
            await sendTransientEphemeralResponse(c, 'No active lobbies. Use `/match create` to start one.', 'error')
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
          const kv = getKvStore(c.env)

          const resolvedReportableMatch = await resolveReportableMatchIdForPlayer(db, identity.userId, c.var.match_id)
          if (resolvedReportableMatch.error) {
            await sendTransientEphemeralResponse(c, resolvedReportableMatch.error, 'error')
            return
          }
          const matchId = resolvedReportableMatch.matchId
          if (!matchId) return

          const [match] = await db
            .select({ id: matches.id, gameMode: matches.gameMode, draftData: matches.draftData, status: matches.status })
            .from(matches)
            .where(eq(matches.id, matchId))
            .limit(1)

          if (!match) {
            await sendTransientEphemeralResponse(c, `Match **${matchId}** was not found.`, 'error')
            return
          }

          if (match.status !== 'active' && match.status !== 'completed') {
            await sendTransientEphemeralResponse(c, `Match **${match.id}** is not active (status: ${match.status}).`, 'error')
            return
          }

          const liveLobbyBeforeReport = match.status === 'completed'
            ? null
            : await getSessionLobbyProjectionByMatch(db, match.id)
          let placements = ''
          if (match.status === 'active') {
            const orderedFfaIds = collectFfaPlacementUserIds(c.var)
            const winnerId = c.var.winner ?? null
            const matchContext = getStoredGameModeContext(match.gameMode, match.draftData)
            if (!matchContext) {
              await sendTransientEphemeralResponse(c, `Match **${match.id}** has unsupported game mode: ${match.gameMode}.`, 'error')
              return
            }

            const mode = matchContext.mode
            const participantRows = await db
              .select({ playerId: matchParticipants.playerId, team: matchParticipants.team })
              .from(matchParticipants)
              .where(eq(matchParticipants.matchId, match.id))
            const uniqueTeams = new Set(isTeamMode(mode)
              ? participantRows.flatMap(participant => participant.team == null ? [] : [participant.team])
              : [])

            if (mode === 'ffa') {
              if (!winnerId) {
                await sendTransientEphemeralResponse(c, 'For FFA reporting, you must provide a `winner` (1st place) user.', 'error')
                return
              }
              const requiredPlacements = matchContext.permanentAlly
                ? participantRows.length
                : matchContext.redDeath ? 4 : (participantRows.length > 0 ? participantRows.length : minPlayerCount(mode))
              const placementLabelByCount: Record<number, string> = {
                2: 'second',
                3: 'third',
                4: 'fourth',
                5: 'fifth',
                6: 'sixth',
                7: 'seventh',
                8: 'eighth',
                9: 'ninth',
                10: 'tenth',
                11: 'eleventh',
                12: 'twelfth',
              }
              const lastRequiredPlacement = placementLabelByCount[requiredPlacements] ?? `${requiredPlacements}th`
              const hasEnoughPlacements = matchContext.permanentAlly
                ? orderedFfaIds.length === requiredPlacements
                : orderedFfaIds.length >= requiredPlacements
              if (!hasEnoughPlacements) {
                const countText = matchContext.permanentAlly ? 'exactly' : 'at least'
                await sendTransientEphemeralResponse(c, `FFA reporting needs ${countText} ${requiredPlacements} ordered users (\`winner\` + \`second\` to \`${lastRequiredPlacement}\`). Permanent Ally reports should click teammates adjacent to each other: 1/1, 2/2, 3/3, etc.`, 'error')
                return
              }
              placements = orderedFfaIds.map(playerId => `<@${playerId}>`).join('\n')
            }
            else if (uniqueTeams.size > 2) {
              if (!winnerId) {
                await sendTransientEphemeralResponse(c, 'For multi-team team reporting, provide `winner` and one player from each remaining team in placement order.', 'error')
                return
              }

              const requiredPlacements = uniqueTeams.size
              const placementLabelByCount: Record<number, string> = {
                2: 'second',
                3: 'third',
                4: 'fourth',
                5: 'fifth',
                6: 'sixth',
                7: 'seventh',
                8: 'eighth',
                9: 'ninth',
                10: 'tenth',
              }
              const lastRequiredPlacement = placementLabelByCount[requiredPlacements] ?? `${requiredPlacements}th`
              if (orderedFfaIds.length !== requiredPlacements) {
                await sendTransientEphemeralResponse(c, `Multi-team team reporting needs exactly ${requiredPlacements} ordered users (winner + second to ${lastRequiredPlacement}), using one player from each team.`, 'error')
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
          }

          const result = await reportMatch(db, kv, {
            matchId: match.id,
            reporterId: identity.userId,
            placements,
          }, {
            sessionNamespace: c.env.SessionDO,
            rankedRoleGuildId: c.interaction.guild_id ?? null,
          })

          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          if (result.reportProcessing) {
            const message = result.reportFinalizing
              ? `Match **${result.match.id}** is finalizing leader swaps. Try reporting again in a moment.`
              : `Match **${result.match.id}** is already being reported.`
            await sendTransientEphemeralResponse(c, message, 'info')
            return
          }

          try {
            const reportedContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
            if (!reportedContext) {
              await sendTransientEphemeralResponse(c, `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.`, 'error')
              return
            }

            const lobby = liveLobbyBeforeReport
            const isRankedResult = reportedContext.ranked
            const isTournamentMatch = await isMatchTournamentLinked(db, result.match.id)
            const archiveChannelType = isTournamentMatch ? 'tournament-archive' : 'archive'
            if (isTournamentMatch) {
              await refreshTournamentLeaderboard(db, kv, c.env.DISCORD_TOKEN).catch((error) => {
                console.error(`Failed to refresh tournament leaderboard after match ${result.match.id}:`, error)
              })
            }

            if (result.idempotent) {
              console.log('[idempotency] slash report deduplicated after race', {
                matchId: result.match.id,
                reporterId: identity.userId,
              })
              const discordSync = await syncReportedMatchDiscordMessages({
                db,
                kv,
                token: c.env.DISCORD_TOKEN,
                matchId: result.match.id,
                reportedMode: reportedContext.mode,
                reportedRedDeath: reportedContext.redDeath,
                reportedCivBlitz: reportedContext.civBlitz,
                participants: result.participants,
                matchDraftData: result.match.draftData,
                lobby,
                sessionNamespace: c.env.SessionDO,
                archivePolicy: 'if-missing',
                archiveChannelType,
              })
              queueReportedDiscordRepairIfNeeded(c, result.match.id, discordSync.errors)
              await sendTransientEphemeralResponse(c, `Match **${result.match.id}** was already reported. Checked Discord result state.`, 'info')
              return
            }

            const discordSync = await syncReportedMatchDiscordMessages({
              db,
              kv,
              token: c.env.DISCORD_TOKEN,
              matchId: result.match.id,
              reportedMode: reportedContext.mode,
              reportedRedDeath: reportedContext.redDeath,
              reportedCivBlitz: reportedContext.civBlitz,
              participants: result.participants,
              matchDraftData: result.match.draftData,
              lobby,
              sessionNamespace: c.env.SessionDO,
              reporter: {
                userId: identity.userId,
                displayName: identity.displayName,
                avatarUrl: identity.avatarUrl,
              },
              archivePolicy: 'always',
              archiveChannelType,
            })
            queueReportedDiscordRepairIfNeeded(c, result.match.id, discordSync.errors)
            try {
              if (!isTournamentMatch && !reportedContext.redDeath) {
                await markLeaderboardsDirty(db, `match-report:${result.match.id}`, {
                  civ: true,
                  modes: reportedContext.leaderboardMode ? [reportedContext.leaderboardMode] : [],
                })
              }
            }
            catch (error) {
              console.error(`Failed to mark leaderboards dirty after match ${result.match.id}:`, error)
            }

            if (!isTournamentMatch && isRankedResult) {
              try {
                await markRankedRolesDirty(kv, `match-report:${result.match.id}`)
              }
              catch (error) {
                console.error(`Failed to mark ranked roles dirty after match ${result.match.id}:`, error)
              }
            }

            await sendTransientEphemeralResponse(c, `Reported result for match **${result.match.id}**.`, 'success')
          }
          finally {
            if (result.reportClaim) {
              await releaseReportedMatchProcessingClaim(c.env.SessionDO, result.reportClaim).catch((error) => {
                console.error(`Failed to release report claim for match ${result.match.id}:`, error)
              })
            }
          }
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
)

export const command_draft = factory.command<MatchVar>(
  new Command('draft', 'Draft lobby shortcuts').options(buildMatchCreateSubCommand()),
  command_match.handler,
)

function formatPlayerCountList(counts: readonly number[], fallback: number): string {
  if (counts.length === 0) return String(fallback)
  if (counts.length === 1) return String(counts[0]!)
  if (counts.length === 2) return `${counts[0]!} or ${counts[1]!}`
  return `${counts.slice(0, -1).join(', ')}, or ${counts[counts.length - 1]!}`
}

async function sendMatchBumpResponse(
  c: Parameters<typeof sendEphemeralResponse>[0],
  message: string,
  tone: Parameters<typeof sendEphemeralResponse>[2],
): Promise<void> {
  await sendEphemeralResponse(c, message, tone, { autoDeleteMs: MATCH_BUMP_RESPONSE_DELETE_MS })
}

async function createMatchLobby(input: CreateMatchLobbyInput): Promise<MatchCreateOutcome> {
  const { env, kv, mode, steamLobbyLink, identity, interactionChannelId, draftChannelId } = input
  const db = createDb(env.DB)
  const [createPreflight, blockingDraftMatchIdByPlayer] = await Promise.all([
    preflightMatchCreateSessionState(db, identity.userId),
    findBlockingDraftMatchIdsForPlayers(db, [identity.userId]),
  ])
  if (createPreflight.kind === 'reuse-hosted-open-lobby') {
    const updatedLobby = steamLobbyLink !== null
      ? (await setLobbySteamLobbyLink(kv, createPreflight.lobby.id, steamLobbyLink, createPreflight.lobby, { db, sessionNamespace: env.SessionDO }) ?? createPreflight.lobby)
      : createPreflight.lobby

    return {
      kind: 'message',
      message: steamLobbyLink !== null
        ? `You already have an open ${formatModeLabel(updatedLobby.mode)} lobby in <#${updatedLobby.channelId}>. Updated its Steam lobby link.`
        : `You already have an open ${formatModeLabel(updatedLobby.mode)} lobby in <#${updatedLobby.channelId}>.`,
      tone: 'info',
    }
  }

  if (createPreflight.kind === 'block-open-lobby') {
    return {
      kind: 'message',
      message: `You are already in an open ${formatModeLabel(createPreflight.lobby.mode)} lobby. Leave it first with \`/match leave\`.`,
      tone: 'error',
    }
  }

  if (blockingDraftMatchIdByPlayer.has(identity.userId)) {
    return {
      kind: 'message',
      message: 'You are already in a live match. Finish or cancel it before creating a new lobby.',
      tone: 'error',
    }
  }

  const hostEntry: QueueEntry = {
    playerId: identity.userId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    joinedAt: Date.now(),
  }

  const previewSlots = Array.from({ length: defaultPlayerCount(mode) }, (_, index) => index === 0 ? identity.userId : null)
  const previewEntries = mapLobbySlotsToEntries(previewSlots, [hostEntry])
  const embed = lobbyOpenEmbed(mode, previewEntries, previewSlots.length, undefined, undefined, 'live')

  let createdMessage: Awaited<ReturnType<typeof createChannelMessage>> | null = null
  try {
    createdMessage = await createChannelMessage(env.DISCORD_TOKEN, draftChannelId, {
      embeds: [embed],
      components: [],
      allowed_mentions: { parse: [] },
    })
    const createdLobby = await createLobby(kv, {
      mode,
      guildId: input.guildId,
      hostId: identity.userId,
      channelId: draftChannelId,
      messageId: createdMessage.id,
      steamLobbyLink,
      queueEntries: [hostEntry],
      db,
      sessionNamespace: env.SessionDO,
    })
    const { lobby: reconciledLobby, reusedExisting } = await reconcileHostedOpenLobbyCreation(
      env.DISCORD_TOKEN,
      db,
      kv,
      identity.userId,
      createdLobby,
    )
    const lobby = reusedExisting && steamLobbyLink !== null
      ? (await setLobbySteamLobbyLink(kv, reconciledLobby.id, steamLobbyLink, reconciledLobby, { db, sessionNamespace: env.SessionDO }) ?? reconciledLobby)
      : reconciledLobby

    if (!reusedExisting) {
      await upsertLobbyMessage(kv, env.DISCORD_TOKEN, lobby, {
        embeds: [embed],
        components: lobbyComponents(mode, lobby.id),
      }, { db, sessionNamespace: env.SessionDO })
    }

    if (reusedExisting) {
      return {
        kind: 'message',
        message: steamLobbyLink !== null
          ? `You already had an open ${formatModeLabel(lobby.mode)} lobby in <#${lobby.channelId}>. Updated its Steam lobby link.`
          : `You already had an open ${formatModeLabel(lobby.mode)} lobby in <#${lobby.channelId}>.`,
        tone: 'info',
      }
    }

    if (interactionChannelId === draftChannelId) return { kind: 'clear' }

    return {
      kind: 'message',
      message: steamLobbyLink !== null
        ? `Created ${formatModeLabel(mode)} lobby in <#${draftChannelId}> with the Steam lobby link set.`
        : `Created ${formatModeLabel(mode)} lobby in <#${draftChannelId}>.`,
      tone: 'info',
    }
  }
  catch (error) {
    console.error('Failed to create lobby message:', error)
    if (createdMessage) {
      try {
        await deleteChannelMessage(env.DISCORD_TOKEN, draftChannelId, createdMessage.id)
      }
      catch (deleteError) {
        console.error(`Failed to delete abandoned lobby message ${createdMessage.id}:`, deleteError)
      }
    }
    if (isSessionAdmissionError(error)) {
      return { kind: 'message', message: formatSessionAdmissionError(error), tone: 'error' }
    }
    return { kind: 'message', message: 'Failed to create lobby message. Please try again.', tone: 'error' }
  }
}

async function sendDeferredMatchCreateOutcome(c: DeferredMatchCreateContext, outcome: MatchCreateOutcome): Promise<void> {
  if (outcome.kind === 'clear') {
    await clearDeferredEphemeralResponse(c)
    return
  }

  await sendTransientEphemeralResponse(c, outcome.message, outcome.tone)
}

async function getLobbyRosterEntriesForRender(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  fallbackEntries: QueueEntry[] = [],
): Promise<QueueEntry[]> {
  const record = await getSessionRecord(namespace, lobby.id).catch(() => null)
  return record ? buildSessionRosterQueueEntries(record) : filterQueueEntriesForLobby(lobby, fallbackEntries)
}

async function buildLobbyBumpRenderPayload(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  lobby: LobbyState,
  sessionNamespace?: DurableObjectNamespace | null,
): Promise<{ embeds: unknown[], components?: unknown } | { error: string }> {
  if (lobby.status === 'open') {
    const entries = mapLobbySlotsToEntries(lobby.slots, await getLobbyRosterEntriesForRender(sessionNamespace, lobby))
    return buildOpenLobbyRenderPayload(kv, lobby, entries, {
      reservedSlotLabels: await buildTournamentReservedSlotLabels(db, lobby),
    })
  }

  if (lobby.status === 'drafting') {
    const draftRoster = await getLobbyRosterEntriesForRender(sessionNamespace, lobby)
    return {
      embeds: [lobbyDraftingEmbed(lobby.mode, buildDraftSeatsFromLobby(lobby, draftRoster), lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz)],
      components: lobbyComponents(lobby.mode, lobby.id),
    }
  }

  if (lobby.status === 'active') {
    if (!lobby.matchId) return { error: 'This match no longer has a tracked lobby message.' }

    const [match] = await db
      .select({ draftData: matches.draftData })
      .from(matches)
      .where(eq(matches.id, lobby.matchId))
      .limit(1)

    const participants = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, lobby.matchId))

    if (participants.length === 0) {
      return { error: 'Could not load the current match participants for this lobby.' }
    }

    return {
      embeds: [lobbyDraftCompleteEmbed(lobby.mode, orderLobbyParticipantsBySlots(lobby, participants), getMapVoteResultFromDraftData(match?.draftData ?? null), lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath, lobby.draftConfig.civBlitz)],
      components: lobbyComponents(lobby.mode, lobby.id),
    }
  }

  return { error: 'Only open, drafting, or active lobbies can be bumped.' }
}

function getMapVoteResultFromDraftData(draftData: string | null | undefined): ResolvedMapVoteResult | null {
  if (!draftData) return null
  try {
    const parsed = JSON.parse(draftData) as { mapVoteResult?: unknown }
    const result = parsed.mapVoteResult
    if (!result || typeof result !== 'object') return null
    const candidate = result as Partial<ResolvedMapVoteResult>
    if (typeof candidate.mapType !== 'string' || typeof candidate.mapScript !== 'string' || typeof candidate.winningSeatCount !== 'number') return null
    return candidate as ResolvedMapVoteResult
  }
  catch {
    return null
  }
}

function buildDraftSeatsFromLobby(
  lobby: LobbyState,
  draftRoster: QueueEntry[],
): DraftSeat[] {
  const rosterByPlayerId = new Map(draftRoster.map(entry => [entry.playerId, entry]))
  const seats: DraftSeat[] = []

  for (let slot = 0; slot < lobby.slots.length; slot++) {
    const playerId = lobby.slots[slot]
    if (!playerId) continue

    const entry = rosterByPlayerId.get(playerId)
    seats.push({
      playerId,
      displayName: entry?.displayName ?? 'Unknown',
      avatarUrl: entry?.avatarUrl ?? null,
      team: getLobbyDraftSeatTeam(lobby, slot) ?? undefined,
    })
  }

  return seats
}

function getLobbyDraftSeatTeam(lobby: LobbyState, slot: number): number | null {
  return slotToTeamIndex(lobby.mode, slot, lobby.slots.length)
}

function orderLobbyParticipantsBySlots<T extends { playerId: string }>(
  lobby: LobbyState,
  participants: T[],
): T[] {
  const slotIndexByPlayerId = new Map<string, number>()
  for (let slot = 0; slot < lobby.slots.length; slot++) {
    const playerId = lobby.slots[slot]
    if (!playerId || slotIndexByPlayerId.has(playerId)) continue
    slotIndexByPlayerId.set(playerId, slot)
  }

  return [...participants].sort((left, right) => {
    const leftSlot = slotIndexByPlayerId.get(left.playerId)
    const rightSlot = slotIndexByPlayerId.get(right.playerId)
    if (leftSlot != null && rightSlot != null && leftSlot !== rightSlot) return leftSlot - rightSlot
    if (leftSlot != null) return -1
    if (rightSlot != null) return 1
    return left.playerId.localeCompare(right.playerId)
  })
}

function buildMatchJoinRequest(
  c: {
    interaction: {
      member?: { user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null } }
      user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null }
      data?: unknown
    }
  },
  mode: GameMode,
  identity: { userId: string, displayName: string, avatarUrl: string },
):
  | { entries: MatchJoinEntry[] }
  | { error: string } {
  void c
  void mode
  return {
    entries: [{
      playerId: identity.userId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    }],
  }
}

async function findHostedOpenLobby(db: ReturnType<typeof createDb>, hostId: string) {
  return getOpenSessionLobbyProjectionHostedBy(db, hostId)
}

async function findHostedEditableLobbies(db: ReturnType<typeof createDb>, hostId: string): Promise<LobbyState[]> {
  const lobbies = await getLiveSessionLobbyProjectionsHostedBy(db, hostId)
  return lobbies.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })
}

async function findMemberLiveLobbies(db: ReturnType<typeof createDb>, userId: string): Promise<LobbyState[]> {
  const lobbies = await getLiveSessionLobbyProjectionsForUser(db, userId)
  return lobbies.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })
}

async function resolveLobbyBumpTarget(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  userId: string,
  targetId: string | null,
): Promise<{ lobby: LobbyState } | { error: string }> {
  if (targetId) {
    const lobbyById = await getLobbyById(kv, targetId)
    const lobby = lobbyById ?? await getSessionLobbyProjectionByMatch(db, targetId)
    if (!lobby) return { error: 'Could not find that lobby or match.' }
    if (!isLiveLobbyStatus(lobby.status)) return { error: 'Only open, drafting, or active lobbies can be bumped.' }
    if (!lobby.memberPlayerIds.includes(userId)) return { error: 'You can only bump a lobby or match you are currently in.' }
    return { lobby }
  }

  const memberLobbies = await findMemberLiveLobbies(db, userId)
  if (memberLobbies.length === 0) {
    return { error: 'You are not in an open or live lobby right now.' }
  }
  if (memberLobbies.length > 1) {
    return { error: 'You are in multiple open or live lobbies. Pass `match_id` to pick the right one.' }
  }
  return { lobby: memberLobbies[0]! }
}

async function resolveHostedSteamLobbyTarget(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  hostId: string,
  targetId: string | null,
): Promise<{ lobby: LobbyState } | { error: string }> {
  if (targetId) {
    const lobbyById = await getLobbyById(kv, targetId)
    const lobby = lobbyById ?? await getSessionLobbyProjectionByMatch(db, targetId)
    if (!lobby) return { error: 'Could not find that hosted lobby or match.' }
    if (lobby.hostId !== hostId) return { error: 'You can only update the Steam lobby link on your own hosted lobby or match.' }
    if (!isLiveLobbyStatus(lobby.status)) {
      return { error: 'Steam lobby links can only be managed while the lobby is open or the match is live.' }
    }
    return { lobby }
  }

  const hostedLobbies = await findHostedEditableLobbies(db, hostId)
  if (hostedLobbies.length === 0) {
    return { error: 'No hosted open or live lobby found. Pass `match_id` to target a specific lobby or match.' }
  }
  if (hostedLobbies.length > 1) {
    return { error: 'You are hosting multiple open or live lobbies. Pass `match_id` to pick the right one.' }
  }
  return { lobby: hostedLobbies[0]! }
}

function isLiveLobbyStatus(status: LobbyState['status']): boolean {
  return status === 'open' || status === 'drafting' || status === 'active'
}

function describeEditableLobbyTarget(lobby: LobbyState): string {
  if (lobby.status === 'open') return `${formatModeLabel(lobby.mode)} lobby`
  if (lobby.status === 'drafting') return `${formatModeLabel(lobby.mode)} draft`
  return `${formatModeLabel(lobby.mode)} match`
}

async function reconcileHostedOpenLobbyCreation(
  token: string,
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  hostId: string,
  createdLobby: Awaited<ReturnType<typeof createLobby>>,
): Promise<{ lobby: Awaited<ReturnType<typeof createLobby>>, reusedExisting: boolean }> {
  const canonicalLobby = await getOpenSessionLobbyProjectionHostedBy(db, hostId)
  if (!canonicalLobby || canonicalLobby.status !== 'open' || canonicalLobby.id === createdLobby.id) {
    return { lobby: createdLobby, reusedExisting: false }
  }

  try {
    await deleteChannelMessage(token, createdLobby.channelId, createdLobby.messageId)
  }
  catch (error) {
    console.error(`Failed to delete duplicate hosted lobby message ${createdLobby.messageId}:`, error)
  }

  return { lobby: canonicalLobby, reusedExisting: true }
}

async function cancelHostedOpenLobby(
  token: string,
  kv: KVNamespace,
  lobby: LobbyState,
  options?: {
    db?: ReturnType<typeof createDb> | null
    sessionNamespace?: DurableObjectNamespace | null
  },
): Promise<void> {
  const lobbyQueueEntries = await getLobbyRosterEntriesForRender(options?.sessionNamespace, lobby)

  const cancelledLobby = await setLobbyStatus(kv, lobby.id, 'cancelled', lobby, {
    ...options,
    queueEntries: lobbyQueueEntries,
  }) ?? lobby
  try {
    await upsertLobbyMessage(kv, token, cancelledLobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, buildCancelledLobbyParticipants(lobby, lobbyQueueEntries), 'cancel', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath, undefined, lobby.draftConfig.civBlitz)],
      components: [],
    }, options)
  }
  catch (error) {
    console.error(`Failed to update cancelled open lobby embed for lobby ${lobby.id}:`, error)
  }
}

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
    .filter(participant => participant != null)
}

function formatLobbyMessageLink(guildId: string | null, channelId: string, messageId: string): string {
  if (!guildId) return `<#${channelId}>`
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

function queueReportedDiscordRepairIfNeeded(
  context: { env: { SessionDO?: DurableObjectNamespace }, executionCtx: { waitUntil: (promise: Promise<unknown>) => void } },
  matchId: string,
  errors: string[],
): void {
  if (errors.length === 0) return
  const task = (async () => {
    try {
      await queueSessionReportedDiscordSync(context.env.SessionDO, matchId, {
        matchId,
        reason: errors.join('; '),
      })
    }
    catch (error) {
      console.error(`[match-report] failed to queue reported Discord repair for ${matchId}:`, error)
    }
  })()

  try {
    context.executionCtx.waitUntil(task)
  }
  catch {
    void task
  }
}
