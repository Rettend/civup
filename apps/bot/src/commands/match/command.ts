import type { GameMode, QueueEntry } from '@civup/game'
import type { MatchJoinEntry, MatchVar } from './shared.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel, isTeamMode, maxPlayerCount, minPlayerCount } from '@civup/game'
import { Command, Option, SubCommand } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyComponents, lobbyOpenEmbed, lobbyResultEmbed } from '../../embeds/match.ts'
import { clearLobbyMappings, getMatchForUser, storeUserLobbyMappings, storeUserMatchMappings } from '../../services/activity.ts'
import { createChannelMessage } from '../../services/discord.ts'
import { clearDeferredEphemeralResponse, sendEphemeralResponse, sendTransientEphemeralResponse } from '../../services/ephemeral-response.ts'
import { markLeaderboardsDirty } from '../../services/leaderboard-message.ts'
import { buildOpenLobbyRenderPayload } from '../../services/lobby-render.ts'
import { upsertLobbyMessage } from '../../services/lobby-message.ts'
import { clearLobbyById, createLobby, filterQueueEntriesForLobby, getLobbiesByMode, getLobbyById, getLobbyByMatch, getOpenLobbyForPlayer, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbyMemberPlayerIds, setLobbySlots, setLobbyStatus } from '../../services/lobby.ts'
import { storeMatchMessageMapping } from '../../services/match-message.ts'
import { cancelMatchByModerator, reportMatch } from '../../services/match.ts'
import { addToQueue, clearQueue, getPlayerQueueMode, getQueueState, removeFromQueue, removeFromQueueAndUnlinkParty } from '../../services/queue.ts'
import { createStateStore } from '../../services/state-store.ts'
import { getSystemChannel } from '../../services/system-channels.ts'
import { factory } from '../../setup.ts'
import { collectFfaPlacementUserIds, GAME_MODE_CHOICES, getIdentity, getIdentityByUserId, joinLobbyAndMaybeStartMatch, LOBBY_STATUS_LABELS } from './shared.ts'

export const command_match = factory.command<MatchVar>(
  new Command('match', 'Looking for game, queue management').options(
    new SubCommand('create', 'Create a lobby and auto-join as host').options(
      new Option('mode', 'Game mode for the lobby')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
    new SubCommand('join', 'Join the queue for a game mode').options(
      new Option('mode', 'Game mode to queue for')
        .required()
        .choices(...GAME_MODE_CHOICES),
      new Option('teammate', 'Teammate for 2v2/3v3', 'User'),
      new Option('teammate2', 'Second teammate for 3v3', 'User'),
    ),
    new SubCommand('cancel', 'Cancel your hosted open or live lobby').options(
      new Option('match_id', 'Optional match or lobby ID override'),
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

            const queue = await getQueueState(kv, mode)

            const result = await addToQueue(kv, mode, {
              playerId: identity.userId,
              displayName: identity.displayName,
              avatarUrl: identity.avatarUrl,
              joinedAt: Date.now(),
            }, {
              currentState: queue,
            })

            if (result.error) {
              await sendTransientEphemeralResponse(c, result.error, 'error')
              return
            }

            const nextQueue = result.state ?? queue
            const previewSlots = Array.from({ length: maxPlayerCount(mode) }, (_, index) => index === 0 ? identity.userId : null)
            const previewEntries = mapLobbySlotsToEntries(previewSlots, nextQueue.entries.filter(entry => entry.playerId === identity.userId))
            const embed = lobbyOpenEmbed(mode, previewEntries, maxPlayerCount(mode))

            try {
              const message = await createChannelMessage(c.env.DISCORD_TOKEN, draftChannelId, {
                embeds: [embed],
                components: lobbyComponents(mode),
                allowed_mentions: { parse: [] },
              })
              const lobby = await createLobby(kv, {
                mode,
                guildId: c.interaction.guild_id ?? null,
                hostId: identity.userId,
                channelId: draftChannelId,
                messageId: message.id,
              })
              await storeUserLobbyMappings(kv, [identity.userId], lobby.id)
              const renderPayload = await buildOpenLobbyRenderPayload(
                kv,
                lobby,
                mapLobbySlotsToEntries(lobby.slots, filterQueueEntriesForLobby(lobby, nextQueue.entries)),
              )
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: renderPayload.embeds,
                components: renderPayload.components,
              })
              if (interactionChannelId === draftChannelId) {
                await clearDeferredEphemeralResponse(c)
              }
              else {
                await sendTransientEphemeralResponse(c, `Created ${formatModeLabel(mode)} lobby in <#${draftChannelId}>.`, 'info')
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
        const mode = c.var.mode as GameMode
        const kv = createStateStore(c.env)
        const identity = getIdentity(c)
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
            c.executionCtx.waitUntil(storeUserMatchMappings(kv, [identity.userId], userMatchId))
            return c.resActivity()
          }
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, `No active ${formatModeLabel(mode)} lobby. Use \`/match create\` first.`, 'error')
          })
        }

        if (joinRequest.teammateIds.length > 0) {
          const db = createDb(c.env.DB)
          const teammatesInLiveMatch = await findPlayersInLiveMatches(db, kv, joinRequest.teammateIds)
          if (teammatesInLiveMatch.length > 0) {
            const mentions = teammatesInLiveMatch.map(playerId => `<@${playerId}>`).join(', ')
            return c.flags('EPHEMERAL').resDefer(async (c) => {
              await sendTransientEphemeralResponse(c, `${mentions} ${teammatesInLiveMatch.length === 1 ? 'is' : 'are'} already in a live match.`, 'error')
            })
          }
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const outcome = await joinLobbyAndMaybeStartMatch(
            c,
            mode,
            joinRequest.entries,
          )
          if ('error' in outcome) {
            await sendTransientEphemeralResponse(c, outcome.error, 'error')
            return
          }

          try {
            await storeUserLobbyMappings(kv, joinRequest.entries.map(entry => entry.playerId), outcome.lobby.id)
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
                embeds: [lobbyCancelledEmbed(lobby.mode, result.participants, 'cancel')],
                components: [],
              })
              await storeMatchMessageMapping(db, lobby.messageId, matchId)
            }
            catch (error) {
              console.error(`Failed to update cancelled lobby embed for match ${matchId}:`, error)
            }

            await clearLobbyMappings(kv, lobby.memberPlayerIds)
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
          await clearLobbyMappings(kv, [identity.userId])

          const lobby = currentLobby?.mode === removedMode ? currentLobby : await getOpenLobbyForPlayer(kv, identity.userId, removedMode)
          if (lobby?.status === 'open') {
            const queue = await getQueueState(kv, removedMode)
            const nextMemberIds = lobby.memberPlayerIds.filter(playerId => playerId !== identity.userId)
            let nextLobby = await setLobbyMemberPlayerIds(kv, lobby.id, nextMemberIds, lobby) ?? lobby
            const lobbyQueueEntries = filterQueueEntriesForLobby({ ...nextLobby, memberPlayerIds: nextMemberIds }, queue.entries)
            const slots = normalizeLobbySlots(removedMode, nextLobby.slots, lobbyQueueEntries)
            const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
            if (!sameLobbySlots(slots, nextLobby.slots)) {
              nextLobby = await setLobbySlots(kv, nextLobby.id, slots, nextLobby) ?? nextLobby
            }
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

      // ── status ──────────────────────────────────────────
      case 'status': {
        return c.resDefer(async (c) => {
          const kv = createStateStore(c.env)
          const modes: GameMode[] = ['ffa', '1v1', '2v2', '3v3']
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
                const target = mode === 'ffa'
                  ? `${minPlayerCount(mode)}-${maxPlayerCount(mode)}`
                  : String(maxPlayerCount(mode))
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

          if (result.idempotent) {
            console.log('[idempotency] slash report deduplicated after race', {
              matchId: result.match.id,
              reporterId: identity.userId,
            })
            await sendTransientEphemeralResponse(c, `Match **${result.match.id}** was already reported.`, 'info')
            return
          }

          const reportedMode = normalizeMatchMode(result.match.gameMode)

          const lobby = await getLobbyByMatch(kv, result.match.id)
          if (lobby) {
            await setLobbyStatus(kv, lobby.id, 'completed', lobby)
            try {
              const updatedLobby = await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyResultEmbed(lobby.mode, result.participants)],
                components: [],
              })
              await storeMatchMessageMapping(db, updatedLobby.messageId, result.match.id)
            }
            catch (error) {
              console.error(`Failed to update lobby result embed for match ${result.match.id}:`, error)
            }
            await clearLobbyById(kv, lobby.id)
            await clearLobbyMappings(kv, lobby.memberPlayerIds)
          }

          const archiveChannelId = await getSystemChannel(kv, 'archive')
          if (archiveChannelId) {
            try {
              const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
                embeds: [lobbyResultEmbed(reportedMode, result.participants)],
              })
              await storeMatchMessageMapping(db, archiveMessage.id, result.match.id)
            }
            catch (error) {
              console.error(`Failed to post archive result for match ${result.match.id}:`, error)
            }
          }

          try {
            await markLeaderboardsDirty(db, `match-report:${result.match.id}`)
          }
          catch (error) {
            console.error(`Failed to mark leaderboards dirty after match ${result.match.id}:`, error)
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

function buildMatchJoinRequest(
  c: {
    var: Pick<MatchVar, 'teammate' | 'teammate2'>
    interaction: {
      member?: { user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null } }
      user?: { id?: string, global_name?: string | null, username?: string, avatar?: string | null }
      data?: unknown
    }
  },
  mode: GameMode,
  identity: { userId: string, displayName: string, avatarUrl: string },
):
  | { entries: MatchJoinEntry[], teammateIds: string[] }
  | { error: string } {
  const rawTeammateIds = [c.var.teammate, c.var.teammate2]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const teammateLimit = maxTeammatesForMode(mode)

  if (rawTeammateIds.length > teammateLimit) {
    if (teammateLimit === 0) {
      return { error: 'Teammate options are only available for 2v2 and 3v3.' }
    }
    return {
      error: `${formatModeLabel(mode)} supports up to ${teammateLimit} teammate option${teammateLimit === 1 ? '' : 's'}.`,
    }
  }

  const teammateIds: string[] = []
  const seen = new Set<string>([identity.userId])
  for (const teammateId of rawTeammateIds) {
    if (teammateId === identity.userId) {
      return { error: 'You cannot select yourself as a teammate.' }
    }
    if (seen.has(teammateId)) {
      return { error: 'Duplicate teammate selected. Please choose distinct users.' }
    }
    seen.add(teammateId)
    teammateIds.push(teammateId)
  }

  const identityByPlayerId = new Map<string, { userId: string, displayName: string, avatarUrl: string }>([
    [identity.userId, identity],
  ])
  for (const teammateId of teammateIds) {
    const teammateIdentity = getIdentityByUserId(c, teammateId)
    if (!teammateIdentity) {
      return { error: `Could not resolve teammate <@${teammateId}> from this command payload. Re-select the user and try again.` }
    }
    identityByPlayerId.set(teammateId, teammateIdentity)
  }

  const playerIds = [identity.userId, ...teammateIds]
  const entries: MatchJoinEntry[] = []
  for (const playerId of playerIds) {
    const joinedIdentity = identityByPlayerId.get(playerId)
    if (!joinedIdentity) {
      return { error: `Could not load player data for <@${playerId}>.` }
    }

    const partyIds = playerIds.filter(candidateId => candidateId !== playerId)
    entries.push({
      playerId,
      displayName: joinedIdentity.displayName,
      avatarUrl: joinedIdentity.avatarUrl,
      partyIds: partyIds.length > 0 ? partyIds : undefined,
    })
  }

  return { entries, teammateIds }
}

function maxTeammatesForMode(mode: GameMode): number {
  if (mode === '2v2') return 1
  if (mode === '3v3') return 2
  return 0
}

async function findPlayersInLiveMatches(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  playerIds: string[],
): Promise<string[]> {
  const uniquePlayerIds = [...new Set(playerIds)]
  const livePlayers = new Set<string>()
  const unresolvedPlayerIds: string[] = []

  for (const playerId of uniquePlayerIds) {
    const mappedMatchId = await getMatchForUser(kv, playerId)
    if (mappedMatchId) {
      livePlayers.add(playerId)
      continue
    }
    unresolvedPlayerIds.push(playerId)
  }

  if (unresolvedPlayerIds.length > 0) {
    const rows = await db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(
        inArray(matchParticipants.playerId, unresolvedPlayerIds),
        inArray(matches.status, ['drafting', 'active']),
      ))

    for (const row of rows) {
      livePlayers.add(row.playerId)
    }
  }

  return uniquePlayerIds.filter(playerId => livePlayers.has(playerId))
}

async function findHostedOpenLobby(kv: KVNamespace, hostId: string) {
  const modes: GameMode[] = ['ffa', '1v1', '2v2', '3v3']
  for (const mode of modes) {
    const lobby = (await getLobbiesByMode(kv, mode)).find(candidate => candidate.status === 'open' && candidate.hostId === hostId)
    if (lobby) return lobby
  }
  return null
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

  await clearLobbyMappings(kv, lobby.memberPlayerIds)
  try {
    await upsertLobbyMessage(kv, token, lobby, {
      embeds: [lobbyCancelledEmbed(lobby.mode, buildCancelledLobbyParticipants(lobby, lobbyQueueEntries), 'cancel')],
      components: [],
    })
  }
  catch (error) {
    console.error(`Failed to update cancelled open lobby embed for lobby ${lobby.id}:`, error)
  }

  await clearLobbyById(kv, lobby.id)
}

function buildCancelledLobbyParticipants(lobby: { mode: GameMode, slots: (string | null)[] }, entries: QueueEntry[]) {
  const entryByPlayerId = new Map(entries.map(entry => [entry.playerId, entry]))
  return lobby.slots
    .map((playerId, slot) => {
      if (!playerId) return null
      const entry = entryByPlayerId.get(playerId)
      return {
        playerId,
        team: toLobbyTeam(lobby.mode, slot),
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

function toLobbyTeam(mode: GameMode, slot: number): number | null {
  if (mode === '1v1') return slot
  if (mode === '2v2') return slot < 2 ? 0 : 1
  if (mode === '3v3') return slot < 3 ? 0 : 1
  return null
}

function formatLobbyMessageLink(guildId: string | null, channelId: string, messageId: string): string {
  if (!guildId) return `<#${channelId}>`
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}
