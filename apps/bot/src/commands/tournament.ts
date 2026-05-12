import type { QueueEntry } from '@civup/game'
import type { EphemeralResponseTone } from '../embeds/response.ts'
import type { TournamentLeaderboardImageData, TournamentOpenLobbyTarget } from '../services/tournament/index.ts'
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
import { findBlockingDraftMatchIdsForPlayers, getIdentity, preflightMatchCreateSessionState } from './match/shared.ts'

interface TournamentVar {
  steam_link?: string
}

const TOURNAMENT_MODE = '1v1'

export const command_tournament = factory.command<TournamentVar>(
  new Command('tournament', 'Tournament lobby and standings').options(
    new SubCommand('create', 'Create an open tournament lobby').options(
      new Option('steam_link', 'Optional Civ 6 Steam lobby link').max_length(MAX_STEAM_LOBBY_LINK_LENGTH),
    ),
    new SubCommand('standings', 'Show active tournament standings'),
    new SubCommand('stats', 'Show your tournament stats and recommended opponents'),
    new SubCommand('leave', 'Leave the active tournament'),
    new SubCommand('demo-result', 'Preview a demo tournament leaderboard image'),
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

        const result = await createTournamentLobbyForCommand(createInput)
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
          const identity = getIdentity(c)
          if (!identity) {
            await sendTransientEphemeralResponse(c, 'Could not identify you.', 'error')
            return
          }

          const db = createDb(c.env.DB)
          const data = await buildTournamentOpponentCardData(db, identity)
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

      case 'demo-result': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const identity = getIdentity(c)
          const png = await renderTournamentLeaderboardPng(buildDemoTournamentLeaderboardImageData(identity))
          await editOriginalInteractionResponseWithFile({
            applicationId: c.env.DISCORD_APPLICATION_ID,
            interactionToken: c.interaction.token,
            filename: 'tournament-leaderboard-demo.png',
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

function buildDemoTournamentLeaderboardImageData(identity: { userId: string, displayName: string, avatarUrl: string } | null): TournamentLeaderboardImageData {
  const minGames = 6
  const self = {
    playerId: identity?.userId ?? '1000000000000001',
    displayName: identity?.displayName ?? 'Rettend',
    avatarUrl: identity?.avatarUrl ?? null,
  }
  const demoNames = [
    'Hman',
    self.displayName,
    'SamDaDeal',
    'Teej',
    'Kaiserpinguin',
    'Darth Vaper',
    'Boris',
    'Mats',
    'TGM',
    'PoppinKream',
    'Maggie',
    'Deezy',
    'Goose',
    'Helios',
    'Bonobo',
    'Cromwell',
    'Aurelius',
    'Novar',
    'Zigzag',
    'Sparrow',
    'Nebu',
    'Juno',
    'Kublai',
    'Mina',
    'Lumen',
    'Rook',
    'Caspian',
    'Nox',
    'Orion',
    'Vega',
    'Atlas',
    'Midas',
  ]
  const topGames = [7, 6, 5, 8, 6, 4, 7, 6]
  const topLosses = [1, 1, 1, 3, 2, 1, 4, 4]
  const standings = Array.from({ length: 62 }, (_, index) => {
    const games = index < topGames.length ? topGames[index]! : 4 + ((index + 2) % 6)
    const losses = index < topLosses.length ? topLosses[index]! : Math.min(games, 2 + Math.floor(index / 9) + (index % 2))
    const wins = Math.max(0, games - losses)
    const displayName = demoNames[index] ?? `Player ${String(index + 1).padStart(2, '0')}`
    const player = index === 1
      ? self
      : { playerId: `100000000000${String(index + 2).padStart(4, '0')}`, displayName, avatarUrl: null }

    return {
      ...player,
      seed: index + 1,
      games,
      wins,
      losses,
      winRate: games > 0 ? wins / games : 0,
      eligible: games >= minGames,
    }
  })
  const getName = (index: number) => standings[index]?.displayName ?? `Player ${index + 1}`

  const pairings = [
    { round: 'quarterfinal', seedOne: 3, seedTwo: 6, playerOneDisplayName: getName(2), playerTwoDisplayName: getName(5), winnerDisplayName: getName(2) },
    { round: 'quarterfinal', seedOne: 1, seedTwo: 5, playerOneDisplayName: getName(0), playerTwoDisplayName: getName(4), winnerDisplayName: getName(0) },
    { round: 'quarterfinal', seedOne: 7, seedTwo: 2, playerOneDisplayName: getName(6), playerTwoDisplayName: getName(1), winnerDisplayName: getName(1) },
    { round: 'quarterfinal', seedOne: 4, seedTwo: 8, playerOneDisplayName: getName(3), playerTwoDisplayName: getName(7), winnerDisplayName: getName(3) },
    { round: 'semifinal', seedOne: 3, seedTwo: 1, playerOneDisplayName: getName(2), playerTwoDisplayName: getName(0), winnerDisplayName: getName(0) },
    { round: 'semifinal', seedOne: 2, seedTwo: 4, playerOneDisplayName: getName(1), playerTwoDisplayName: getName(3), winnerDisplayName: null },
    { round: 'final', seedOne: 1, seedTwo: 0, playerOneDisplayName: getName(0), playerTwoDisplayName: 'TBD', winnerDisplayName: null },
  ]

  return {
    tournamentName: 'Leaderboard Preview Cup',
    status: 'top_cut',
    minGames,
    standings,
    pairings,
    champion: null,
  }
}

async function createTournamentLobbyForCommand(input: {
  env: { DB: D1Database, DISCORD_TOKEN: string, SessionDO?: DurableObjectNamespace }
  kv: KVNamespace
  channelId: string
  guildId: string | null
  steamLobbyLink: string | null
  identity: { userId: string, displayName: string, avatarUrl: string }
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
  const embed = lobbyOpenEmbed(TOURNAMENT_MODE, mapLobbySlotsToEntries(previewSlots, [hostEntry]), previewSlots.length, undefined, undefined, 'live', false, reservedLabels)
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
    const renderPayload = await buildOpenLobbyRenderPayload(input.kv, lobby, mapLobbySlotsToEntries(lobby.slots, [hostEntry]), {
      reservedSlotLabels: await buildTournamentReservedSlotLabels(db, lobby),
    })
    await upsertLobbyMessage(input.kv, input.env.DISCORD_TOKEN, lobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    }, { db, sessionNamespace: input.env.SessionDO })
    await refreshTournamentLeaderboard(db, input.kv, input.env.DISCORD_TOKEN).catch((error) => {
      console.error('[tournament:create] failed to refresh tournament leaderboard', error)
    })
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

function immediateEphemeral(c: any, message: string, tone: EphemeralResponseTone): Response {
  return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(message, tone)] })
}
