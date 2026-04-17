import type { DraftSeat, GameMode, QueueEntry } from '@civup/game'
import type { LobbyState } from '../../services/lobby/index.ts'
import type { MatchJoinEntry, MatchVar } from './shared.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { defaultPlayerCount, formatModeLabel, GAME_MODE_CHOICES, GAME_MODES, isTeamMode, maxPlayerCount, minPlayerCount, parseGameMode, slotToTeamIndex, startPlayerCountOptions } from '@civup/game'
import { Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyComponents, lobbyDraftCompleteEmbed, lobbyDraftingEmbed, lobbyOpenEmbed } from '../../embeds/match.ts'
import { clearLobbyMappings, clearLobbyMappingsIfMatchingLobby, clearUserLobbyMappings, getMatchForUser, storeUserActivityTarget, storeUserLobbyState, storeUserMatchMappings } from '../../services/activity/index.ts'
import { createChannelMessage, deleteChannelMessage } from '../../services/discord/index.ts'
import { markLeaderboardsDirty } from '../../services/leaderboard/message.ts'
import { clearLobbyById, createLobby, filterQueueEntriesForLobby, getCurrentLobbyHostedBy, getLobbiesByMode, getLobbyBumpCooldownRemainingMs, getLobbyById, getLobbyByMatch, getLobbyDraftRoster, getOpenLobbyForPlayer, mapLobbySlotsToEntries, markLobbyBumped, normalizeLobbySlots, repostLobbyMessage, sameLobbySlots, setLobbyLastActivityAt, setLobbyMemberPlayerIds, setLobbySlots, setLobbySteamLobbyLink } from '../../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { upsertLobbyMessage } from '../../services/lobby/message.ts'
import { buildOpenLobbyRenderPayload } from '../../services/lobby/render.ts'
import { cancelMatchByModerator, getStoredGameModeContext, reportMatch } from '../../services/match/index.ts'
import { clearMatchMessageMapping, storeMatchMessageMapping } from '../../services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../../services/match/report-discord.ts'
import { addToQueue, clearQueue, getPlayerQueueMode, getQueueState, getQueueStateWithPlayerQueueModes, removeFromQueue, removeFromQueueAndUnlinkParty } from '../../services/queue/index.ts'
import { listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles } from '../../services/ranked/role-sync.ts'
import { clearDeferredEphemeralResponse, sendEphemeralResponse, sendTransientEphemeralResponse } from '../../services/response/ephemeral.ts'
import { syncSeasonPeaksForPlayers } from '../../services/season/index.ts'
import { createStateStore } from '../../services/state/store.ts'
import { MAX_STEAM_LOBBY_LINK_LENGTH, parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../../services/steam-link.ts'
import { getSystemChannel } from '../../services/system/channels.ts'
import { factory } from '../../setup.ts'
import { buildFfaPlacementOptions, collectFfaPlacementUserIds, findActiveMatchIdsForPlayers, findLiveMatchIdsForPlayers, getIdentity, joinLobbyAndMaybeStartMatch, LOBBY_STATUS_LABELS } from './shared.ts'

const MATCH_MODE_CHOICES = GAME_MODE_CHOICES
const MATCH_BUMP_RESPONSE_DELETE_MS = 5_000

export const command_match = factory.command<MatchVar>(
  new Command('match', 'Looking for game, queue management').options(
    new SubCommand('create', 'Create a lobby and auto-join as host').options(
      new Option('mode', 'Game mode for the lobby')
        .required()
        .choices(...MATCH_MODE_CHOICES),
      new Option('steam_link', 'Optional Civ 6 Steam lobby link').max_length(MAX_STEAM_LOBBY_LINK_LENGTH),
    ),
    new SubCommand('join', 'Join the queue for a game mode').options(
      new Option('mode', 'Game mode to queue for')
        .required()
        .choices(...MATCH_MODE_CHOICES),
    ),
    new SubCommand('activity', 'Open the activity for this channel'),
    new SubCommand('cancel', 'Cancel your hosted open or live lobby').options(
      new Option('match_id', 'Optional match or lobby ID override'),
    ),
    new SubCommand('leave', 'Leave the current queue'),
    new SubCommand('bump', 'Repost the embed for your current lobby').options(
      new Option('match_id', 'Optional match or lobby ID override'),
    ),
    new SubCommand('status', 'Show all active lobbies'),
    new SubCommand('report', 'Report your active match result').options(
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
        const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id
        const identity = getIdentity(c)
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
        if (steamLobbyLink === undefined) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, STEAM_LOBBY_LINK_ERROR, 'error')
          })
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          try {
            const kv = createStateStore(c.env)
            const draftChannelId = await getSystemChannel(kv, 'draft')
            if (!draftChannelId) {
              await sendTransientEphemeralResponse(
                c,
                'Draft channel is not configured. Run `/admin setup target:Draft` to set up this channel.',
                'error',
              )
              return
            }

            const currentHostedLobby = await getCurrentLobbyHostedBy(kv, identity.userId)
            if (currentHostedLobby?.status === 'open') {
              const updatedLobby = steamLobbyLink !== null
                ? (await setLobbySteamLobbyLink(kv, currentHostedLobby.id, steamLobbyLink, currentHostedLobby) ?? currentHostedLobby)
                : currentHostedLobby

              await storeUserLobbyState(kv, updatedLobby.channelId, [identity.userId], updatedLobby.id)
              await sendTransientEphemeralResponse(
                c,
                steamLobbyLink !== null
                  ? `You already have an open ${formatModeLabel(updatedLobby.mode)} lobby in <#${updatedLobby.channelId}>. Updated its Steam lobby link.`
                  : `You already have an open ${formatModeLabel(updatedLobby.mode)} lobby in <#${updatedLobby.channelId}>.`,
                'info',
              )
              return
            }

            if (currentHostedLobby) {
              await sendTransientEphemeralResponse(
                c,
                'You are already in a live match. Finish or cancel it before creating a new lobby.',
                'error',
              )
              return
            }

            const { queue, queueModeByPlayerId } = await getQueueStateWithPlayerQueueModes(
              kv,
              mode,
              [identity.userId],
              { fallbackToQueueScan: false },
            )
            const existingQueueMode = queueModeByPlayerId.get(identity.userId) ?? null
            if (existingQueueMode) {
              await sendTransientEphemeralResponse(
                c,
                `You are already in an open ${formatModeLabel(existingQueueMode)} lobby. Leave it first with \`/match leave\`.`,
                'error',
              )
              return
            }

            const db = createDb(c.env.DB)
            const liveMatchIdByPlayer = await findLiveMatchIdsForPlayers(db, [identity.userId])
            if (liveMatchIdByPlayer.has(identity.userId)) {
              await sendTransientEphemeralResponse(
                c,
                'You are already in a live match. Finish or cancel it before creating a new lobby.',
                'error',
              )
              return
            }

            const result = await addToQueue(kv, mode, {
              playerId: identity.userId,
              displayName: identity.displayName,
              avatarUrl: identity.avatarUrl,
              joinedAt: Date.now(),
            }, {
              existingMode: existingQueueMode,
              currentState: queue,
            })

            if (result.error) {
              await sendTransientEphemeralResponse(c, result.error, 'error')
              return
            }

            const nextQueue = result.state ?? queue
            const previewSlots = Array.from({ length: defaultPlayerCount(mode) }, (_, index) => index === 0 ? identity.userId : null)
            const previewEntries = mapLobbySlotsToEntries(previewSlots, nextQueue.entries.filter(entry => entry.playerId === identity.userId))
            const embed = lobbyOpenEmbed(mode, previewEntries, previewSlots.length, undefined, undefined, 'live')

            try {
              const message = await createChannelMessage(c.env.DISCORD_TOKEN, draftChannelId, {
                embeds: [embed],
                components: [],
                allowed_mentions: { parse: [] },
              })
              const createdLobby = await createLobby(kv, {
                mode,
                guildId: c.interaction.guild_id ?? null,
                hostId: identity.userId,
                channelId: draftChannelId,
                messageId: message.id,
                steamLobbyLink,
                queueEntries: nextQueue.entries,
              })
              const { lobby: reconciledLobby, reusedExisting } = await reconcileHostedOpenLobbyCreation(
                c.env.DISCORD_TOKEN,
                kv,
                identity.userId,
                createdLobby,
              )
              const lobby = steamLobbyLink !== null
                ? (await setLobbySteamLobbyLink(kv, reconciledLobby.id, steamLobbyLink, reconciledLobby) ?? reconciledLobby)
                : reconciledLobby
              if ((lobby.id === createdLobby.id && lobby.revision !== createdLobby.revision)
                || (lobby.id === reconciledLobby.id && lobby.revision !== reconciledLobby.revision)) { await syncLobbyDerivedState(kv, lobby) }

              await storeUserLobbyState(kv, lobby.channelId, [identity.userId], lobby.id)
              if (!reusedExisting) {
                const renderPayload = await buildOpenLobbyRenderPayload(
                  kv,
                  lobby,
                  mapLobbySlotsToEntries(lobby.slots, filterQueueEntriesForLobby(lobby, nextQueue.entries)),
                )
                await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                  embeds: renderPayload.embeds,
                  components: renderPayload.components,
                })
              }
              if (reusedExisting) {
                await sendTransientEphemeralResponse(
                  c,
                  steamLobbyLink !== null
                    ? `You already had an open ${formatModeLabel(lobby.mode)} lobby in <#${lobby.channelId}>. Updated its Steam lobby link.`
                    : `You already had an open ${formatModeLabel(lobby.mode)} lobby in <#${lobby.channelId}>.`,
                  'info',
                )
              }
              else if (interactionChannelId === draftChannelId) {
                await clearDeferredEphemeralResponse(c)
              }
              else {
                await sendTransientEphemeralResponse(
                  c,
                  steamLobbyLink !== null
                    ? `Created ${formatModeLabel(mode)} lobby in <#${draftChannelId}> with the Steam lobby link set.`
                    : `Created ${formatModeLabel(mode)} lobby in <#${draftChannelId}>.`,
                  'info',
                )
              }
            }
            catch (error) {
              console.error('Failed to create lobby message:', error)
              await removeFromQueue(kv, identity.userId)
              await sendTransientEphemeralResponse(c, 'Failed to create lobby message. Please try again.', 'error')
            }
          }
          catch (error) {
            console.error('[match:create] unexpected failure', {
              mode,
              interactionChannelId,
              userId: identity.userId,
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
        const kv = createStateStore(c.env)
        const identity = getIdentity(c)
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

        const openLobbies = (await getLobbiesByMode(kv, mode)).filter(lobby => lobby.status === 'open')
        if (openLobbies.length === 0) {
          if (joinRequest.entries.length > 1) {
            return c.flags('EPHEMERAL').resDefer(async (c) => {
              await sendTransientEphemeralResponse(c, `No active ${formatModeLabel(mode)} lobby. Use \`/match create\` first.`, 'error')
            })
          }

          let userMatchId = await getMatchForUser(kv, identity.userId)
          if (!userMatchId) {
            const db = createDb(c.env.DB)
            const [active] = await db
              .select({ matchId: matchParticipants.matchId })
              .from(matchParticipants)
              .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
              .where(and(
                eq(matchParticipants.playerId, identity.userId),
                inArray(matches.status, ['drafting', 'active']),
              ))
              .orderBy(desc(matches.createdAt))
              .limit(1)

            userMatchId = active?.matchId ?? null
          }

          if (userMatchId) {
            const interactionChannelId = c.interaction.channel_id ?? null
            if (interactionChannelId) {
              await storeUserActivityTarget(kv, interactionChannelId, [identity.userId], {
                kind: 'match',
                id: userMatchId,
                activitySecret: c.env.CIVUP_SECRET,
              })
            }
            c.executionCtx.waitUntil(storeUserMatchMappings(kv, [identity.userId], userMatchId))
            return c.resActivity()
          }
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, `No active ${formatModeLabel(mode)} lobby. Use \`/match create\` first.`, 'error')
          })
        }

        const db = createDb(c.env.DB)
        const liveMatchIdByPlayer = await findLiveMatchIdsForPlayers(db, joinRequest.entries.map(entry => entry.playerId))
        if (liveMatchIdByPlayer.size > 0) {
          const playersInLiveMatch = joinRequest.entries
            .map(entry => entry.playerId)
            .filter(playerId => liveMatchIdByPlayer.has(playerId))
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
            { liveMatchPlayerIds: new Set(liveMatchIdByPlayer.keys()) },
          )
          if ('error' in outcome) {
            await sendTransientEphemeralResponse(c, outcome.error, 'error')
            return
          }

          try {
            await storeUserLobbyState(
              kv,
              outcome.lobby.channelId,
              joinRequest.entries.map(entry => entry.playerId),
              outcome.lobby.id,
            )
            await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, outcome.lobby, {
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
          const kv = createStateStore(c.env)
          const targetId = c.var.match_id?.trim() ?? null

          if (targetId) {
            const lobbyById = await getLobbyById(kv, targetId)
            if (lobbyById?.hostId !== identity.userId) {
              const lobbyByMatch = await getLobbyByMatch(kv, targetId)
              if (!lobbyByMatch || lobbyByMatch.hostId !== identity.userId) {
                await sendTransientEphemeralResponse(c, 'You can only cancel your own hosted lobby or match.', 'error')
                return
              }
            }

            if (lobbyById && !lobbyById.matchId) {
              await cancelHostedOpenLobby(c.env.DISCORD_TOKEN, kv, lobbyById)
              await sendTransientEphemeralResponse(c, `Cancelled hosted ${formatModeLabel(lobbyById.mode)} lobby.`, 'success')
              return
            }

            const lobby = lobbyById ?? await getLobbyByMatch(kv, targetId)
            const matchId = lobby?.matchId ?? targetId
            if (!lobby || !matchId) {
              await sendTransientEphemeralResponse(c, 'Could not find that hosted lobby or match.', 'error')
              return
            }

            const db = createDb(c.env.DB)
            const result = await cancelMatchByModerator(db, kv, {
              matchId,
              cancelledAt: Date.now(),
            })

            if ('error' in result) {
              await sendTransientEphemeralResponse(c, result.error, 'error')
              return
            }

            try {
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'cancel', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath)],
                components: [],
              })
              await storeMatchMessageMapping(db, lobby.messageId, matchId)
            }
            catch (error) {
              console.error(`Failed to update cancelled lobby embed for match ${matchId}:`, error)
            }

            await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
            await sendTransientEphemeralResponse(c, `Cancelled hosted match **${matchId}**.`, 'success')
            return
          }

          const hostedLobby = await findHostedOpenLobby(kv, identity.userId)
          if (!hostedLobby) {
            await sendTransientEphemeralResponse(c, 'No hosted open lobby found. Pass `match_id` to cancel a live match.', 'error')
            return
          }

          await cancelHostedOpenLobby(c.env.DISCORD_TOKEN, kv, hostedLobby)
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
          const kv = createStateStore(c.env)
          const currentMode = await getPlayerQueueMode(kv, identity.userId)
          const currentLobby = currentMode ? await getOpenLobbyForPlayer(kv, identity.userId, currentMode) : null

          if (currentLobby?.hostId === identity.userId) {
            await sendTransientEphemeralResponse(c, 'You are hosting this lobby. Use `/match cancel` instead.', 'error')
            return
          }

          const removed = await removeFromQueueAndUnlinkParty(kv, identity.userId)

          if (!removed.mode) {
            const userMatchId = await getMatchForUser(kv, identity.userId)
            if (userMatchId) {
              await sendTransientEphemeralResponse(c, 'You are not in queue right now. If you need back in, use `/match join` for the game mode to reopen the activity.', 'error')
              return
            }

            await sendTransientEphemeralResponse(c, 'You are not in any queue.', 'error')
            return
          }

          const removedMode = removed.mode
          await clearUserLobbyMappings(kv, [identity.userId])

          const lobby = currentLobby?.mode === removedMode ? currentLobby : await getOpenLobbyForPlayer(kv, identity.userId, removedMode)
          if (lobby?.status === 'open') {
            const queue = await getQueueState(kv, removedMode)
            const nextMemberIds = lobby.memberPlayerIds.filter(playerId => playerId !== identity.userId)
            let nextLobby = await setLobbyMemberPlayerIds(kv, lobby.id, nextMemberIds, lobby) ?? lobby
            const lobbyQueueEntries = filterQueueEntriesForLobby({ ...nextLobby, memberPlayerIds: nextMemberIds }, queue.entries)
            const slots = normalizeLobbySlots(removedMode, nextLobby.slots, lobbyQueueEntries)
            if (!sameLobbySlots(slots, nextLobby.slots)) {
              nextLobby = await setLobbySlots(kv, nextLobby.id, slots, nextLobby) ?? nextLobby
            }
            nextLobby = await setLobbyLastActivityAt(kv, nextLobby.id, Date.now(), nextLobby) ?? nextLobby
            await syncLobbyDerivedState(kv, nextLobby, {
              queueEntries: lobbyQueueEntries,
              slots,
            })
            const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
            try {
              const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries)
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, nextLobby, {
                embeds: renderPayload.embeds,
                components: renderPayload.components,
              })
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
          const kv = createStateStore(c.env)
          const targetId = c.var.match_id?.trim() ?? null
          const resolvedTarget = await resolveLobbyBumpTarget(kv, identity.userId, targetId)
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
            const db = createDb(c.env.DB)
            const renderPayload = await buildLobbyBumpRenderPayload(db, kv, currentLobby)
            if ('error' in renderPayload) {
              await sendMatchBumpResponse(c, renderPayload.error, 'error')
              return
            }

            const reposted = await repostLobbyMessage(kv, c.env.DISCORD_TOKEN, currentLobby, renderPayload)
            let updatedLobby = reposted.lobby
            if (updatedLobby.status === 'open') {
              updatedLobby = await setLobbyLastActivityAt(kv, updatedLobby.id, Date.now(), updatedLobby) ?? updatedLobby
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
          const kv = createStateStore(c.env)
          const targetId = c.var.match_id?.trim() ?? null
          const resolvedTarget = await resolveHostedSteamLobbyTarget(kv, identity.userId, targetId)
          if ('error' in resolvedTarget) {
            await sendTransientEphemeralResponse(c, resolvedTarget.error, 'error')
            return
          }

          const currentLobby = resolvedTarget.lobby
          const updatedLobby = await setLobbySteamLobbyLink(kv, currentLobby.id, nextSteamLobbyLink, currentLobby) ?? currentLobby
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
          const kv = createStateStore(c.env)
          const modes = GAME_MODES
          const lines: string[] = []
          const guildId = c.interaction.guild_id ?? null

          for (const mode of modes) {
            const lobbies = await getLobbiesByMode(kv, mode)
            if (lobbies.length === 0) continue

            const queue = await getQueueState(kv, mode)
            for (const lobby of lobbies) {
              const label = LOBBY_STATUS_LABELS[lobby.status]
              const link = formatLobbyMessageLink(guildId, lobby.channelId, lobby.messageId)
              if (lobby.status === 'open') {
                const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
                const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
                const filled = slots.filter(slot => slot != null).length
                const validCounts = startPlayerCountOptions(mode, slots.length, { redDeath: lobby.draftConfig.redDeath })
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
          const kv = createStateStore(c.env)

          let matchId = c.var.match_id?.trim() ?? null
          if (!matchId) {
            const activeMatchIds = (await findActiveMatchIdsForPlayers(db, [identity.userId])).get(identity.userId) ?? []
            if (activeMatchIds.length > 1) {
              await sendTransientEphemeralResponse(c, 'You are in multiple active matches. Pass `match_id` to pick the right one.', 'error')
              return
            }

            matchId = activeMatchIds[0] ?? null
            if (matchId) {
              c.executionCtx.waitUntil(storeUserMatchMappings(kv, [identity.userId], matchId))
            }
          }

          if (!matchId) {
            await sendTransientEphemeralResponse(c, 'Could not find an active match for you. You can pass `match_id` explicitly.', 'error')
            return
          }

          const [match] = await db
            .select({ id: matches.id, gameMode: matches.gameMode, draftData: matches.draftData, status: matches.status })
            .from(matches)
            .where(eq(matches.id, matchId))
            .limit(1)

          if (!match) {
            await sendTransientEphemeralResponse(c, `Match **${matchId}** was not found.`, 'error')
            return
          }

          if (match.status === 'completed') {
            console.log('[idempotency] duplicate slash report request', {
              matchId: match.id,
              reporterId: identity.userId,
            })
            await sendTransientEphemeralResponse(c, `Match **${match.id}** was already reported.`, 'info')
            return
          }

          if (match.status !== 'active') {
            await sendTransientEphemeralResponse(c, `Match **${match.id}** is not active (status: ${match.status}).`, 'error')
            return
          }

          const orderedFfaIds = collectFfaPlacementUserIds(c.var)
          const winnerId = c.var.winner ?? null
          const matchContext = getStoredGameModeContext(match.gameMode, match.draftData)
          if (!matchContext) {
            await sendTransientEphemeralResponse(c, `Match **${match.id}** has unsupported game mode: ${match.gameMode}.`, 'error')
            return
          }

          const mode = matchContext.mode
          const fallbackLobby = await getLobbyByMatch(kv, match.id)
          const participantRows = await db
            .select({ playerId: matchParticipants.playerId, team: matchParticipants.team })
            .from(matchParticipants)
            .where(eq(matchParticipants.matchId, match.id))
          const uniqueTeams = new Set(isTeamMode(mode)
            ? participantRows.flatMap(participant => participant.team == null ? [] : [participant.team])
            : [])

          let placements: string
          if (mode === 'ffa') {
            if (!winnerId) {
              await sendTransientEphemeralResponse(c, 'For FFA reporting, you must provide a `winner` (1st place) user.', 'error')
              return
            }
            const requiredPlacements = matchContext.redDeath ? 4 : (participantRows.length > 0 ? participantRows.length : minPlayerCount(mode))
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
            if (orderedFfaIds.length < requiredPlacements) {
              await sendTransientEphemeralResponse(c, `FFA reporting needs at least ${requiredPlacements} ordered users (\`winner\` + \`second\` to \`${lastRequiredPlacement}\`).`, 'error')
              return
            }
            placements = orderedFfaIds.map(playerId => `<@${playerId}>`).join('\n')
          }
          else {
            if (uniqueTeams.size > 2) {
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
          })

          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          const reportedContext = getStoredGameModeContext(result.match.gameMode, result.match.draftData)
          if (!reportedContext) {
            await sendTransientEphemeralResponse(c, `Match **${result.match.id}** has unsupported game mode: ${result.match.gameMode}.`, 'error')
            return
          }

          const lobby = await getLobbyByMatch(kv, result.match.id) ?? fallbackLobby
          const isRankedResult = reportedContext.ranked

          if (result.idempotent) {
            console.log('[idempotency] slash report deduplicated after race', {
              matchId: result.match.id,
              reporterId: identity.userId,
            })
            await syncReportedMatchDiscordMessages({
              db,
              kv,
              token: c.env.DISCORD_TOKEN,
              matchId: result.match.id,
              reportedMode: reportedContext.mode,
              reportedRedDeath: reportedContext.redDeath,
              participants: result.participants,
              matchDraftData: result.match.draftData,
              lobby,
              archivePolicy: 'if-missing',
            })
            if (lobby) {
              await clearLobbyById(kv, lobby.id, lobby)
            }
            await sendTransientEphemeralResponse(c, `Match **${result.match.id}** was already reported. Checked Discord result state.`, 'info')
            return
          }

          const guildId = lobby?.guildId ?? c.interaction.guild_id ?? null
          let rankedRoleLines: string[] = []
          if (isRankedResult && guildId) {
            try {
              const participantIds = result.participants.map(participant => participant.playerId)
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
              console.error(`Failed to preview ranked role changes after match ${result.match.id}:`, error)
            }
          }

          await syncReportedMatchDiscordMessages({
            db,
            kv,
            token: c.env.DISCORD_TOKEN,
            matchId: result.match.id,
            reportedMode: reportedContext.mode,
            reportedRedDeath: reportedContext.redDeath,
            participants: result.participants,
            matchDraftData: result.match.draftData,
            lobby,
            rankedRoleLines,
            reporter: {
              userId: identity.userId,
              displayName: identity.displayName,
              avatarUrl: identity.avatarUrl,
            },
            archivePolicy: 'always',
          })
          if (lobby) {
            await clearLobbyById(kv, lobby.id, lobby)
          }

          if (isRankedResult) {
            try {
              await markLeaderboardsDirty(db, `match-report:${result.match.id}`)
            }
            catch (error) {
              console.error(`Failed to mark leaderboards dirty after match ${result.match.id}:`, error)
            }

            try {
              await markRankedRolesDirty(kv, `match-report:${result.match.id}`)
            }
            catch (error) {
              console.error(`Failed to mark ranked roles dirty after match ${result.match.id}:`, error)
            }
          }

          await sendTransientEphemeralResponse(c, `Reported result for match **${result.match.id}**.`, 'success')
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
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

async function buildLobbyBumpRenderPayload(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  lobby: LobbyState,
): Promise<{ embeds: unknown[], components?: unknown } | { error: string }> {
  if (lobby.status === 'open') {
    const queue = await getQueueState(kv, lobby.mode)
    const entries = mapLobbySlotsToEntries(lobby.slots, filterQueueEntriesForLobby(lobby, queue.entries))
    return buildOpenLobbyRenderPayload(kv, lobby, entries)
  }

  if (lobby.status === 'drafting') {
    const draftRoster = await getLobbyDraftRoster(kv, lobby.id)
    return {
      embeds: [lobbyDraftingEmbed(lobby.mode, buildDraftSeatsFromLobby(lobby, draftRoster), lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath)],
      components: lobbyComponents(lobby.mode, lobby.id),
    }
  }

  if (lobby.status === 'active') {
    if (!lobby.matchId) return { error: 'This match no longer has a tracked lobby message.' }

    const participants = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, lobby.matchId))

    if (participants.length === 0) {
      return { error: 'Could not load the current match participants for this lobby.' }
    }

    return {
      embeds: [lobbyDraftCompleteEmbed(lobby.mode, orderLobbyParticipantsBySlots(lobby, participants), lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath)],
      components: lobbyComponents(lobby.mode, lobby.id),
    }
  }

  return { error: 'Only open, drafting, or active lobbies can be bumped.' }
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
      team: slotToTeamIndex(lobby.mode, slot, lobby.slots.length) ?? undefined,
    })
  }

  return seats
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

async function findHostedOpenLobby(kv: KVNamespace, hostId: string) {
  const lobbies = await findHostedOpenLobbies(kv, hostId)
  return lobbies[0] ?? null
}

async function findHostedOpenLobbies(kv: KVNamespace, hostId: string) {
  const modes = GAME_MODES
  const lobbies = [] as Awaited<ReturnType<typeof getLobbiesByMode>>[number][]
  for (const mode of modes) {
    lobbies.push(...(await getLobbiesByMode(kv, mode)).filter(candidate => candidate.status === 'open' && candidate.hostId === hostId))
  }
  return lobbies.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return left.id.localeCompare(right.id)
  })
}

async function findHostedEditableLobbies(kv: KVNamespace, hostId: string): Promise<LobbyState[]> {
  const modes = GAME_MODES
  const lobbies: LobbyState[] = []
  for (const mode of modes) {
    lobbies.push(...(await getLobbiesByMode(kv, mode)).filter(candidate => candidate.hostId === hostId && isLiveLobbyStatus(candidate.status)))
  }
  return lobbies.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })
}

async function findMemberLiveLobbies(kv: KVNamespace, userId: string): Promise<LobbyState[]> {
  const modes = GAME_MODES
  const lobbies: LobbyState[] = []
  for (const mode of modes) {
    lobbies.push(...(await getLobbiesByMode(kv, mode)).filter(candidate => candidate.memberPlayerIds.includes(userId) && isLiveLobbyStatus(candidate.status)))
  }
  return lobbies.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })
}

async function resolveLobbyBumpTarget(
  kv: KVNamespace,
  userId: string,
  targetId: string | null,
): Promise<{ lobby: LobbyState } | { error: string }> {
  if (targetId) {
    const lobbyById = await getLobbyById(kv, targetId)
    const lobby = lobbyById ?? await getLobbyByMatch(kv, targetId)
    if (!lobby) return { error: 'Could not find that lobby or match.' }
    if (!isLiveLobbyStatus(lobby.status)) return { error: 'Only open, drafting, or active lobbies can be bumped.' }
    if (!lobby.memberPlayerIds.includes(userId)) return { error: 'You can only bump a lobby or match you are currently in.' }
    return { lobby }
  }

  const memberLobbies = await findMemberLiveLobbies(kv, userId)
  if (memberLobbies.length === 0) {
    return { error: 'You are not in an open or live lobby right now.' }
  }
  if (memberLobbies.length > 1) {
    return { error: 'You are in multiple open or live lobbies. Pass `match_id` to pick the right one.' }
  }
  return { lobby: memberLobbies[0]! }
}

async function resolveHostedSteamLobbyTarget(
  kv: KVNamespace,
  hostId: string,
  targetId: string | null,
): Promise<{ lobby: LobbyState } | { error: string }> {
  if (targetId) {
    const lobbyById = await getLobbyById(kv, targetId)
    const lobby = lobbyById ?? await getLobbyByMatch(kv, targetId)
    if (!lobby) return { error: 'Could not find that hosted lobby or match.' }
    if (lobby.hostId !== hostId) return { error: 'You can only update the Steam lobby link on your own hosted lobby or match.' }
    if (!isLiveLobbyStatus(lobby.status)) {
      return { error: 'Steam lobby links can only be managed while the lobby is open or the match is live.' }
    }
    return { lobby }
  }

  const hostedLobbies = await findHostedEditableLobbies(kv, hostId)
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
  kv: KVNamespace,
  hostId: string,
  createdLobby: Awaited<ReturnType<typeof createLobby>>,
): Promise<{ lobby: Awaited<ReturnType<typeof createLobby>>, reusedExisting: boolean }> {
  const canonicalLobby = await getCurrentLobbyHostedBy(kv, hostId)
  if (!canonicalLobby || canonicalLobby.status !== 'open' || canonicalLobby.id === createdLobby.id) {
    return { lobby: createdLobby, reusedExisting: false }
  }

  await clearLobbyById(kv, createdLobby.id, createdLobby)
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
  lobby: Awaited<ReturnType<typeof findHostedOpenLobby>> extends infer T ? Exclude<T, null> : never,
): Promise<void> {
  const queue = await getQueueState(kv, lobby.mode)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  if (lobbyQueueEntries.length > 0) {
    await clearQueue(kv, lobby.mode, lobbyQueueEntries.map(entry => entry.playerId), {
      currentState: queue,
    })
  }

  await clearLobbyMappingsIfMatchingLobby(kv, lobbyQueueEntries.map(entry => entry.playerId), lobby.id, lobby.channelId)
  try {
    await upsertLobbyMessage(kv, token, lobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, buildCancelledLobbyParticipants(lobby, lobbyQueueEntries), 'cancel', undefined, lobby.draftConfig.leaderDataVersion, lobby.draftConfig.redDeath)],
      components: [],
    })
  }
  catch (error) {
    console.error(`Failed to update cancelled open lobby embed for lobby ${lobby.id}:`, error)
  }

  await clearLobbyById(kv, lobby.id, lobby)
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
