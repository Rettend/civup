import type { QueueEntry } from '@civup/game'
import type { EphemeralResponseTone } from '../embeds/response.ts'
import type { TournamentOpenLobbyTarget } from '../services/tournament/index.ts'
import { createDb } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Command, Option, SubCommand } from 'discord-hono'
import { lobbyOpenEmbed } from '../embeds/match.ts'
import { ephemeralResponseEmbed } from '../embeds/response.ts'
import { storeActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import { createChannelMessage, deleteChannelMessage, editOriginalInteractionResponseWithFile } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { createLobby, mapLobbySlotsToEntries, upsertLobbyMessage } from '../services/lobby/index.ts'
import { buildOpenLobbyRenderPayload } from '../services/lobby/render.ts'
import { sendEphemeralResponse, sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { getSessionLobbyProjectionByMatch } from '../services/session/index.ts'
import { MAX_STEAM_LOBBY_LINK_LENGTH, parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../services/steam-link.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { renderTournamentLeaderboardPng, renderTournamentOpponentsPng } from '../services/tournament/image.ts'
import { buildTournamentLeaderboardImageData, buildTournamentOpponentCardData, buildTournamentReservedSlotLabels, buildTournamentStandings, createTournamentMatchLink, getActiveTournament, leaveTournament, refreshTournamentLeaderboard, resolveTournamentOpenLobbyTarget } from '../services/tournament/index.ts'
import { factory } from '../setup.ts'
import { findBlockingDraftMatchIdsForPlayers, getIdentity, getIdentityByUserId, preflightMatchCreateSessionState } from './match/shared.ts'

interface TournamentVar {
  steam_link?: string
  player?: string
}

interface BackgroundContext {
  waitUntil: (promise: Promise<unknown>) => void
}

const TOURNAMENT_MODE = '1v1'

export const command_tournament = factory.command<TournamentVar>(
  new Command('tournament', 'Tournament lobby and standings').options(
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
        const tournamentDraftChannelId = await getSystemChannel(kv, 'tournament-draft')
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
          guildId: c.interaction.guild_id ?? null,
          steamLobbyLink,
          identity,
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
          const tournament = await getActiveTournament(db)
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
          const tournament = await getActiveTournament(db)
          if (!tournament) {
            await sendTransientEphemeralResponse(c, 'No active tournament.', 'info')
            return
          }

          const result = await leaveTournament(db, tournament.id, identity)
          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          await refreshTournamentLeaderboard(db, getKvStore(c.env), c.env.DISCORD_TOKEN).catch((error) => {
            console.error('[tournament:leave] failed to refresh tournament leaderboard', error)
          })
          await sendEphemeralResponse(c, `You have left **${tournament.name}**.`, 'success')
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
)

async function createTournamentLobbyForCommand(input: {
  env: { DB: D1Database, DISCORD_TOKEN: string, SessionDO?: DurableObjectNamespace }
  kv: KVNamespace
  channelId: string
  guildId: string | null
  steamLobbyLink: string | null
  identity: { userId: string, displayName: string, avatarUrl: string }
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

  const createPreflight = await preflightMatchCreateSessionState(db, input.identity.userId)
  if (createPreflight.kind === 'reuse-hosted-open-lobby') {
    return { error: `You already have an open ${formatModeLabel(createPreflight.lobby.mode)} lobby in <#${createPreflight.lobby.channelId}>.`, tone: 'info' }
  }
  if (createPreflight.kind === 'block-open-lobby') {
    return { error: `You are already in an open ${formatModeLabel(createPreflight.lobby.mode)} lobby. Leave it first with "/match leave".`, tone: 'error' }
  }

  const blockingDraftMatchIdByPlayer = await findBlockingDraftMatchIdsForPlayers(db, [input.identity.userId])
  if (blockingDraftMatchIdByPlayer.has(input.identity.userId)) {
    return { error: 'You are already in a live match. Finish or cancel it before creating a tournament lobby.', tone: 'error' }
  }

  const result = await createTournamentLobby({
    env: input.env,
    kv: input.kv,
    target,
    channelId: input.channelId,
    guildId: input.guildId,
    steamLobbyLink: input.steamLobbyLink,
    identity: input.identity,
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
  deferPostCreateWork?: boolean
  executionCtx?: BackgroundContext
}): Promise<{ ok: true, lobbyId: string } | { error: string }> {
  const db = createDb(input.env.DB)
  const hostEntry: QueueEntry = {
    playerId: input.identity.userId,
    displayName: input.identity.displayName,
    avatarUrl: input.identity.avatarUrl,
    joinedAt: Date.now(),
  }
  const previewSlots = [input.identity.userId, null]
  const reservedLabels = [null, input.target.opponentDisplayName]
  const embed = lobbyOpenEmbed(TOURNAMENT_MODE, mapLobbySlotsToEntries(previewSlots, [hostEntry]), previewSlots.length, undefined, undefined, 'live', false, { reservedSlotLabels: reservedLabels })
  let createdMessage: Awaited<ReturnType<typeof createChannelMessage>> | null = null

  try {
    createdMessage = await createChannelMessage(input.env.DISCORD_TOKEN, input.channelId, {
      embeds: [embed],
      components: [],
      allowed_mentions: { parse: [] },
    })
    const lobby = await createLobby(input.kv, {
      mode: TOURNAMENT_MODE,
      guildId: input.guildId,
      hostId: input.identity.userId,
      channelId: input.channelId,
      messageId: createdMessage.id,
      steamLobbyLink: input.steamLobbyLink,
      queueEntries: [hostEntry],
      db,
      sessionNamespace: input.env.SessionDO,
    })
    await createTournamentMatchLink(db, {
      tournamentId: input.target.tournamentId,
      sessionId: lobby.id,
      hostId: input.identity.userId,
      stage: input.target.stage,
      cutPairingId: input.target.cutPairingId,
      playerOneId: input.target.playerOneId ?? input.identity.userId,
      playerTwoId: input.target.playerTwoId,
    })
    if (input.deferPostCreateWork) {
      queueTournamentCreatePostWork(input, db, lobby, hostEntry)
    }
    else {
      await updateTournamentCreatePostWork(input, db, lobby, hostEntry)
    }
    return { ok: true, lobbyId: lobby.id }
  }
  catch (error) {
    console.error('[tournament:create] failed to create lobby', error)
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
  hostEntry: QueueEntry,
): Promise<void> {
  const renderPayload = await buildOpenLobbyRenderPayload(input.kv, lobby, mapLobbySlotsToEntries(lobby.slots, [hostEntry]), {
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
  hostEntry: QueueEntry,
): void {
  queueBackgroundTask(input.executionCtx, updateTournamentCreatePostWork(input, db, lobby, hostEntry), '[tournament:create] failed to finish auto-open post-create work')
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
