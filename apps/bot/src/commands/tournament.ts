import type { QueueEntry } from '@civup/game'
import { createDb } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Command, Option, SubCommand } from 'discord-hono'
import { lobbyOpenEmbed } from '../embeds/match.ts'
import { ephemeralResponseEmbed, type EphemeralResponseTone } from '../embeds/response.ts'
import { storeActivityLaunchTargetSelection } from '../services/activity/launch-target.ts'
import { createChannelMessage, deleteChannelMessage } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { createLobby, mapLobbySlotsToEntries, upsertLobbyMessage } from '../services/lobby/index.ts'
import { buildOpenLobbyRenderPayload } from '../services/lobby/render.ts'
import { sendEphemeralResponse, sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { findBlockingDraftMatchIdsForPlayers, getIdentity, preflightMatchCreateSessionState } from './match/shared.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { buildTournamentStandings, createTournamentMatchLink, getActiveQualifierTournament, getActiveTournament, resolveTournamentPlayerForIdentity } from '../services/tournament/index.ts'
import { MAX_STEAM_LOBBY_LINK_LENGTH, parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../services/steam-link.ts'
import { factory } from '../setup.ts'

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
    new SubCommand('opponents', 'Show recommended tournament opponents'),
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
          const lines = standings.slice(0, 15).map((row, index) => {
            const record = `${row.wins}-${row.losses}`
            const games = `${row.games}/${tournament.minGames}`
            return `${index + 1}. ${row.displayName} - ${record} (${games})${row.eligible ? '' : ' pending'}`
          })
          await sendEphemeralResponse(c, `**${tournament.name} standings**\n${lines.join('\n') || 'No players imported yet.'}`, 'info')
        })
      }

      case 'opponents': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, '`/tournament opponents` will use the image renderer in the next implementation slice.', 'info')
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
}): Promise<{ ok: true, lobbyId: string } | { error: string, tone: EphemeralResponseTone }> {
  const db = createDb(input.env.DB)
  const tournament = await getActiveQualifierTournament(db)
  if (!tournament) return { error: 'No active tournament qualifier is accepting lobbies.', tone: 'error' }

  const player = await resolveTournamentPlayerForIdentity(db, tournament.id, input.identity)
  if (!player.ok) return { error: player.error, tone: 'error' }

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
    tournamentId: tournament.id,
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
  tournamentId: string
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
  const embed = lobbyOpenEmbed(TOURNAMENT_MODE, mapLobbySlotsToEntries(previewSlots, [hostEntry]), previewSlots.length, undefined, undefined, 'live')
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
      tournamentId: input.tournamentId,
      sessionId: lobby.id,
      hostId: input.identity.userId,
    })
    const renderPayload = await buildOpenLobbyRenderPayload(input.kv, lobby, mapLobbySlotsToEntries(lobby.slots, [hostEntry]))
    await upsertLobbyMessage(input.kv, input.env.DISCORD_TOKEN, lobby, {
      embeds: renderPayload.embeds,
      components: renderPayload.components,
    }, { db, sessionNamespace: input.env.SessionDO })
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
