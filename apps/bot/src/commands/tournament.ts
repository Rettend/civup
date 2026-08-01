import type { QueueEntry } from '@civup/game'
import type { EphemeralResponseTone } from '../embeds/response.ts'
import type { TournamentOpenLobbyTarget } from '../services/tournament/index.ts'
import { createDb } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Command, Option, SubCommand } from 'discord-hono'
import { nanoid } from 'nanoid'
import { lobbyOpenEmbed } from '../embeds/match.ts'
import { ephemeralResponseEmbed } from '../embeds/response.ts'
import { storeActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import { createChannelMessage, deleteChannelMessage, editOriginalInteractionResponseWithFile } from '../services/discord/index.ts'
import { getKnownGuildIdentity } from '../services/discord/guild-metadata.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { createLobby, mapLobbySlotsToEntries, setLobbyStatus, upsertLobbyMessage } from '../services/lobby/index.ts'
import { buildOpenLobbyRenderPayload } from '../services/lobby/render.ts'
import { sendEphemeralResponse, sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { getSessionLobbyProjectionByMatch } from '../services/session/index.ts'
import { MAX_STEAM_LOBBY_LINK_LENGTH, parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../services/steam-link.ts'
import { getSystemChannel, primaryChannelScope } from '../services/system/channels.ts'
import { renderTournamentLeaderboardPng, renderTournamentOpponentsPng } from '../services/tournament/image.ts'
import { buildTournamentLeaderboardImageData, buildTournamentOpponentCardData, buildTournamentReservedSlotLabels, buildTournamentStandings, claimTournamentPlayoffLobby, createTournamentMatchLink, formatTournamentEntryName, getCurrentTournament, leaveTournament, refreshTournamentLeaderboard, registerTournamentEntry, releaseTournamentPlayoffLobbyClaim, resolveTournamentOpenLobbyTarget } from '../services/tournament/index.ts'
import { factory } from '../setup.ts'
import { findBlockingDraftMatchIdsForPlayers, getIdentity, getIdentityByUserId, preflightMatchCreateSessionState } from './match/shared.ts'

interface TournamentVar {
  steam_link?: string
  player?: string
  teammate_1?: string
  teammate_2?: string
  teammate_3?: string
  teammate_4?: string
  teammate_5?: string
}

interface BackgroundContext {
  waitUntil: (promise: Promise<unknown>) => void
}

export const command_tournament = factory.command<TournamentVar>(
  new Command('tournament', 'Tournament lobby and standings').options(
    new SubCommand('register', 'Register your tournament roster').options(
      new Option('teammate_1', 'First teammate', 'User'),
      new Option('teammate_2', 'Second teammate', 'User'),
      new Option('teammate_3', 'Third teammate', 'User'),
      new Option('teammate_4', 'Fourth teammate', 'User'),
      new Option('teammate_5', 'Fifth teammate', 'User'),
    ),
    new SubCommand('create', 'Create an open tournament lobby').options(
      new Option('steam_link', 'Optional Civ 6 Steam lobby link').max_length(MAX_STEAM_LOBBY_LINK_LENGTH),
    ),
    new SubCommand('standings', 'Show active tournament standings'),
    new SubCommand('stats', 'Show tournament stats and recommended opponents').options(
      new Option('player', 'Player to look up (defaults to you)', 'User'),
    ),
    new SubCommand('leave', 'Leave the active tournament'),
  ),
  async (c) => {
    switch (c.sub.string) {
      case 'register': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const caller = getIdentity(c)
          if (!caller) {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
            return
          }
          const db = createDb(c.env.DB)
          const tournament = await getCurrentTournament(db)
          if (!tournament || tournament.status !== 'setup') {
            await sendTransientEphemeralResponse(c, 'No tournament is currently accepting registration.', 'info')
            return
          }
          const teammateIds = [c.var.teammate_1, c.var.teammate_2, c.var.teammate_3, c.var.teammate_4, c.var.teammate_5].filter((id): id is string => Boolean(id))
          const teammates = teammateIds.map(id => getIdentityByUserId(c, id))
          if (teammates.some(identity => !identity)) {
            await sendTransientEphemeralResponse(c, 'Every selected teammate must resolve to a Discord user.', 'error')
            return
          }
          const result = await registerTournamentEntry(db, tournament.id, [caller, ...teammates.filter((identity): identity is NonNullable<typeof identity> => identity != null)])
          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }
          const names = result.entry.members.map(member => member.displayName).join(', ')
          await sendEphemeralResponse(c, result.idempotent
            ? `This roster is already registered for **${tournament.name}**: **${names}**.`
            : `Registered for **${tournament.name}**: **${names}**.`, 'success')
        })
      }

      case 'create': {
        const identity = getIdentity(c)
        const steamLobbyLink = parseSteamLobbyLink(c.var.steam_link)
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

        const kv = getKvStore(c.env)
        const guildId = c.interaction.guild_id ?? null
        const tournamentDraftChannelId = await getSystemChannel(kv, 'tournament-draft', { guildId, legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
        if (!tournamentDraftChannelId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            await sendTransientEphemeralResponse(c, 'Tournament Draft channel is not configured. Run `/admin setup target:Tournament Draft` in the tournament draft channel.', 'error')
          })
        }

        const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
        const createInput = {
          env: c.env,
          kv,
          channelId: tournamentDraftChannelId,
          guildId,
          steamLobbyLink,
          identity,
          sourceGuild: await getKnownGuildIdentity(kv, c.env.DISCORD_TOKEN, guildId),
        }

        if (interactionChannelId !== tournamentDraftChannelId) {
          return c.flags('EPHEMERAL').resDefer(async (c) => {
            const result = await createTournamentLobbyForCommand(createInput)
            if ('error' in result) {
              await sendTransientEphemeralResponse(c, result.error, result.tone)
              return
            }

            await sendEphemeralResponse(c, `Created tournament lobby in <#${tournamentDraftChannelId}>.`, 'success')
          })
        }

        const result = await createTournamentLobbyForCommand({
          ...createInput,
          deferPostCreateWork: true,
          executionCtx: c.executionCtx,
        })
        if ('error' in result) return immediateEphemeral(c, result.error, result.tone)

        await storeActivityLaunchTargetSelection(c.env.Activity, c.env.CIVUP_SECRET, interactionChannelId, identity.userId, {
          kind: 'lobby',
          id: result.lobbyId,
        })
        return c.resActivity()
      }

      case 'standings': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const db = createDb(c.env.DB)
          const tournament = await getCurrentTournament(db)
          if (!tournament) {
            await sendTransientEphemeralResponse(c, 'No active tournament.', 'info')
            return
          }
          const standings = await buildTournamentStandings(db, tournament.id)
          const data = await buildTournamentLeaderboardImageData(db, tournament.id, standings, [])
          if (!data) {
            await sendTransientEphemeralResponse(c, 'Could not build tournament standings.', 'error')
            return
          }
          const png = await renderTournamentLeaderboardPng(data)
          await editOriginalInteractionResponseWithFile({
            applicationId: c.env.DISCORD_APPLICATION_ID,
            interactionToken: c.interaction.token,
            filename: 'tournament-standings.png',
            contentType: 'image/png',
            data: png,
          })
        })
      }

      case 'stats': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const caller = getIdentity(c)
          const targetId = c.var.player ?? caller?.userId
          const identity = targetId ? getIdentityByUserId(c, targetId) : null
          if (!identity) {
            await sendTransientEphemeralResponse(c, c.var.player ? 'Could not identify that player.' : 'Could not identify you.', 'error')
            return
          }

          const db = createDb(c.env.DB)
          const data = await buildTournamentOpponentCardData(db, identity, { autoLink: caller?.userId === identity.userId })
          if ('error' in data) {
            await sendTransientEphemeralResponse(c, data.error, 'error')
            return
          }

          const png = await renderTournamentOpponentsPng(data)
          await editOriginalInteractionResponseWithFile({
            applicationId: c.env.DISCORD_APPLICATION_ID,
            interactionToken: c.interaction.token,
            filename: 'tournament-stats.png',
            contentType: 'image/png',
            data: png,
          })
        })
      }

      case 'leave': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const identity = getIdentity(c)
          if (!identity) {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
            return
          }

          const db = createDb(c.env.DB)
          const tournament = await getCurrentTournament(db)
          if (!tournament) {
            await sendTransientEphemeralResponse(c, 'No active tournament.', 'info')
            return
          }

          const result = await leaveTournament(db, tournament.id, identity)
          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          if (tournament.status !== 'setup') {
            await refreshTournamentLeaderboard(db, getKvStore(c.env), c.env.DISCORD_TOKEN, primaryChannelScope(c.env)).catch((error) => {
              console.error('[tournament:leave] failed to refresh tournament leaderboard', error)
            })
          }
          await sendEphemeralResponse(c, `Withdrew **${formatTournamentEntryName(result.entry)}** from **${tournament.name}**.`, 'success')
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
)

async function createTournamentLobbyForCommand(input: {
  env: { DB: D1Database, DISCORD_TOKEN: string, SessionDO?: DurableObjectNamespace, ALLOWED_DISCORD_GUILD_ID?: string }
  kv: KVNamespace
  channelId: string
  guildId: string | null
  steamLobbyLink: string | null
  identity: { userId: string, displayName: string, avatarUrl: string }
  sourceGuild?: QueueEntry['sourceGuild']
  deferPostCreateWork?: boolean
  executionCtx?: BackgroundContext
}): Promise<{ ok: true, lobbyId: string } | { error: string, tone: EphemeralResponseTone }> {
  const db = createDb(input.env.DB)
  const target = await resolveTournamentOpenLobbyTarget(db, input.identity)
  if ('error' in target) return { error: target.error, tone: 'error' }

  if (target.existingSessionId) {
    const existingLobby = await getSessionLobbyProjectionByMatch(db, target.existingSessionId).catch(() => null)
    if (existingLobby && (existingLobby.status === 'open' || existingLobby.status === 'drafting' || existingLobby.status === 'active')) {
      return { ok: true, lobbyId: existingLobby.id }
    }
    return { error: 'Your playoff pairing already has a closed lobby. Ask an admin to reset it.', tone: 'error' }
  }

  const createPreflight = await preflightMatchCreateSessionState(db, input.identity.userId, input.env.ALLOWED_DISCORD_GUILD_ID ? [input.env.ALLOWED_DISCORD_GUILD_ID] : [])
  if (createPreflight.kind === 'reuse-hosted-open-lobby') {
    return { error: `You already have an open ${formatModeLabel(createPreflight.lobby.mode)} lobby in <#${createPreflight.lobby.channelId}>.`, tone: 'info' }
  }
  if (createPreflight.kind === 'block-open-lobby') {
    return { error: `You are already in an open ${formatModeLabel(createPreflight.lobby.mode)} lobby. Leave it first with "/match leave".`, tone: 'error' }
  }

  const entryPlayerIds = target.creatorEntry.members.flatMap(member => member.playerId ? [member.playerId] : [])
  const blockingDraftMatchIdByPlayer = await findBlockingDraftMatchIdsForPlayers(db, entryPlayerIds, input.env.ALLOWED_DISCORD_GUILD_ID ? [input.env.ALLOWED_DISCORD_GUILD_ID] : [])
  if (blockingDraftMatchIdByPlayer.size > 0) {
    return { error: 'A roster member is already in a live match. Finish or cancel it before creating a tournament lobby.', tone: 'error' }
  }

  const result = await createTournamentLobby({
    env: input.env,
    kv: input.kv,
    target,
    channelId: input.channelId,
    guildId: input.guildId,
    steamLobbyLink: input.steamLobbyLink,
    identity: input.identity,
    sourceGuild: input.sourceGuild,
    deferPostCreateWork: input.deferPostCreateWork,
    executionCtx: input.executionCtx,
  })
  if ('error' in result) return { error: result.error, tone: 'error' }
  return result
}

async function createTournamentLobby(input: {
  env: { DB: D1Database, DISCORD_TOKEN: string, SessionDO?: DurableObjectNamespace }
  kv: KVNamespace
  target: TournamentOpenLobbyTarget
  channelId: string
  guildId: string | null
  steamLobbyLink: string | null
  identity: { userId: string, displayName: string, avatarUrl: string }
  sourceGuild?: QueueEntry['sourceGuild']
  deferPostCreateWork?: boolean
  executionCtx?: BackgroundContext
}): Promise<{ ok: true, lobbyId: string } | { error: string }> {
  const db = createDb(input.env.DB)
  const entryPlayerIds = input.target.creatorEntry.members.flatMap(member => member.playerId ? [member.playerId] : [])
  if (entryPlayerIds.length !== input.target.creatorEntry.members.length) return { error: 'Your tournament roster is not fully linked.' }
  const joinedAt = Date.now()
  const rosterEntries: QueueEntry[] = input.target.creatorEntry.members.map((member, index) => ({
    playerId: member.playerId!,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    ...(input.sourceGuild ? { sourceGuild: input.sourceGuild } : {}),
    joinedAt: joinedAt + index,
    partyIds: entryPlayerIds.filter(playerId => playerId !== member.playerId),
  }))
  const targetSize = input.target.creatorEntry.members.length * 2
  const previewSlots = [...entryPlayerIds, ...Array.from({ length: entryPlayerIds.length }, () => null)]
  const reservedLabels = [...Array.from({ length: entryPlayerIds.length }, () => null), ...(input.target.opponentEntry?.members.map(member => member.displayName) ?? Array.from({ length: entryPlayerIds.length }, () => null))]
  const embed = lobbyOpenEmbed(input.target.mode, mapLobbySlotsToEntries(previewSlots, rosterEntries), targetSize, undefined, undefined, 'live', false, { reservedSlotLabels: reservedLabels })
  const lobbyId = nanoid(10)
  let claimedPlayoffPairing = false
  if (input.target.cutPairingId) {
    const claim = await claimTournamentPlayoffLobby(db, input.target.cutPairingId, lobbyId)
    if (!claim.ok) return { error: claim.error }
    if (!claim.claimed) return { ok: true, lobbyId: claim.sessionId }
    claimedPlayoffPairing = true
  }
  let createdMessage: Awaited<ReturnType<typeof createChannelMessage>> | null = null
  let createdLobby: Awaited<ReturnType<typeof createLobby>> | null = null

  try {
    createdMessage = await createChannelMessage(input.env.DISCORD_TOKEN, input.channelId, {
      embeds: [embed],
      components: [],
      allowed_mentions: { parse: [] },
    })
    const lobby = await createLobby(input.kv, {
      id: lobbyId,
      mode: input.target.mode,
      guildId: input.guildId,
      hostId: input.identity.userId,
      channelId: input.channelId,
      messageId: createdMessage.id,
      steamLobbyLink: input.steamLobbyLink,
      queueEntries: rosterEntries,
      initialSlots: previewSlots,
      db,
      sessionNamespace: input.env.SessionDO,
    })
    createdLobby = lobby
    await createTournamentMatchLink(db, {
      tournamentId: input.target.tournamentId,
      sessionId: lobby.id,
      hostId: input.identity.userId,
      stage: input.target.stage,
      cutPairingId: input.target.cutPairingId,
      entryOneId: input.target.entryOneId,
      entryTwoId: input.target.entryTwoId,
    })
    if (input.deferPostCreateWork) {
      queueTournamentCreatePostWork(input, db, lobby, rosterEntries)
    }
    else {
      await updateTournamentCreatePostWork(input, db, lobby, rosterEntries)
    }
    return { ok: true, lobbyId: lobby.id }
  }
  catch (error) {
    console.error('[tournament:create] failed to create lobby', error)
    if (createdLobby) {
      await setLobbyStatus(input.kv, createdLobby.id, 'cancelled', createdLobby, {
        db,
        sessionNamespace: input.env.SessionDO,
        queueEntries: rosterEntries,
      }).catch(cancelError => console.error('[tournament:create] failed to cancel abandoned session', cancelError))
    }
    if (claimedPlayoffPairing && input.target.cutPairingId) {
      await releaseTournamentPlayoffLobbyClaim(db, input.target.cutPairingId, lobbyId)
        .catch(releaseError => console.error('[tournament:create] failed to release playoff lobby claim', releaseError))
    }
    if (createdMessage) {
      try {
        await deleteChannelMessage(input.env.DISCORD_TOKEN, input.channelId, createdMessage.id)
      }
      catch (deleteError) {
        console.error('[tournament:create] failed to delete abandoned message', deleteError)
      }
    }
    return { error: 'Failed to create tournament lobby. Please try again.' }
  }
}

async function updateTournamentCreatePostWork(
  input: {
    env: { DB: D1Database, DISCORD_TOKEN: string, SessionDO?: DurableObjectNamespace }
    kv: KVNamespace
  },
  db: ReturnType<typeof createDb>,
  lobby: Awaited<ReturnType<typeof createLobby>>,
  rosterEntries: QueueEntry[],
): Promise<void> {
  const renderPayload = await buildOpenLobbyRenderPayload(input.kv, lobby, mapLobbySlotsToEntries(lobby.slots, rosterEntries), {
    reservedSlotLabels: await buildTournamentReservedSlotLabels(db, lobby),
  })
  await upsertLobbyMessage(input.kv, input.env.DISCORD_TOKEN, lobby, {
    embeds: renderPayload.embeds,
    components: renderPayload.components,
  }, { db, sessionNamespace: input.env.SessionDO })
}

function queueTournamentCreatePostWork(
  input: {
    env: { DB: D1Database, DISCORD_TOKEN: string, SessionDO?: DurableObjectNamespace }
    kv: KVNamespace
    executionCtx?: BackgroundContext
  },
  db: ReturnType<typeof createDb>,
  lobby: Awaited<ReturnType<typeof createLobby>>,
  rosterEntries: QueueEntry[],
): void {
  queueBackgroundTask(input.executionCtx, updateTournamentCreatePostWork(input, db, lobby, rosterEntries), '[tournament:create] failed to finish auto-open post-create work')
}

function queueBackgroundTask(context: BackgroundContext | undefined, task: Promise<unknown>, errorMessage: string): void {
  const loggedTask = task.catch((error) => {
    console.error(errorMessage, error)
  })
  try {
    context?.waitUntil(loggedTask)
  }
  catch {
    void loggedTask
  }
}

function immediateEphemeral(c: any, message: string, tone: EphemeralResponseTone): Response {
  return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(message, tone)] })
}
