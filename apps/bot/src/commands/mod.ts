import type { GameMode } from '@civup/game'
import type { LfgVar } from './lfg/shared'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Command, Option, SubCommand, SubGroup } from 'discord-hono'
import { eq } from 'drizzle-orm'
import { lobbyCancelledEmbed, lobbyResultEmbed } from '../embeds/lfg'
import { clearActivityMappings, getChannelForMatch } from '../services/activity'
import { createChannelMessage } from '../services/discord'
import { sendTransientEphemeralResponse } from '../services/ephemeral-response'
import { refreshConfiguredLeaderboards } from '../services/leaderboard-message'
import { clearLobby, getLobby, getLobbyByMatch } from '../services/lobby'
import { upsertLobbyMessage } from '../services/lobby-message'
import { cancelMatchByModerator, resolveMatchByModerator } from '../services/match'
import { storeMatchMessageMapping } from '../services/match-message'
import { canUseModCommands, parseRoleIds } from '../services/permissions'
import { clearQueue, getQueueState } from '../services/queue'
import { getSystemChannel } from '../services/system-channels'
import { factory } from '../setup'
import { collectFfaPlacementUserIds } from './lfg/shared'

interface ModVar extends LfgVar {
  reason?: string
}

const MODE_CHOICES = [
  { name: '1v1', value: '1v1' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
  { name: 'FFA', value: 'ffa' },
] as const

export const command_mod = factory.command<ModVar>(
  new Command('mod', 'Moderation commands for match and lobby operations').options(
    new SubGroup('match', 'Match moderation').options(
      new SubCommand('cancel', 'Cancel a match, including completed history').options(
        new Option('match_id', 'Match ID').required(),
        new Option('reason', 'Optional short reason for cancellation').max_length(140),
      ),
      new SubCommand('resolve', 'Resolve or correct a match result').options(
        new Option('match_id', 'Match ID').required(),
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
        new Option('reason', 'Optional short reason for correction').max_length(140),
      ),
    ),
    new SubGroup('queue', 'Queue moderation').options(
      new SubCommand('recover', 'Force-clear stuck lobby state').options(
        new Option('mode', 'Lobby mode to recover')
          .required()
          .choices(...MODE_CHOICES),
      ),
    ),
  ),
  async (c) => {
    const guildId = c.interaction.guild_id
    if (!guildId) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
      })
    }

    const allowed = await canUseModCommands({
      kv: c.env.KV,
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

          const existingLobby = await getLobbyByMatch(c.env.KV, matchId)
          const result = await cancelMatchByModerator(db, c.env.KV, {
            matchId,
            cancelledAt: Date.now(),
          })

          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          const mode = normalizeMatchMode(result.match.gameMode)
          const moderation = { actorId, reason }

          if (existingLobby) {
            try {
              const updatedLobby = await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, existingLobby, {
                embeds: [lobbyCancelledEmbed(mode, result.participants, 'cancel', moderation)],
                components: [],
              })
              await storeMatchMessageMapping(c.env.KV, updatedLobby.messageId, result.match.id)
            }
            catch (error) {
              console.error(`Failed to update cancelled embed for match ${result.match.id}:`, error)
            }
          }

          const shouldArchiveCancellation = result.previousStatus === 'completed'
          const archiveChannelId = shouldArchiveCancellation ? await getSystemChannel(c.env.KV, 'archive') : null
          if (archiveChannelId && shouldArchiveCancellation) {
            try {
              const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
                embeds: [lobbyCancelledEmbed(mode, result.participants, 'cancel', moderation)],
              })
              await storeMatchMessageMapping(c.env.KV, archiveMessage.id, result.match.id)
            }
            catch (error) {
              console.error(`Failed to post archive cancellation note for match ${result.match.id}:`, error)
            }
          }

          try {
            await refreshConfiguredLeaderboards(db, c.env.KV, c.env.DISCORD_TOKEN)
          }
          catch (error) {
            console.error(`Failed to refresh leaderboard embeds after cancelling match ${result.match.id}:`, error)
          }

          const recalculated = result.recalculatedMatchIds.length
          await sendTransientEphemeralResponse(
            c,
            `Cancelled match **${result.match.id}** (was ${result.previousStatus}). Recalculated ${recalculated} completed ${formatModeLabel(mode)} matches.`,
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
          const db = createDb(c.env.DB)
          const actorId = c.interaction.member?.user?.id ?? c.interaction.user?.id
          if (!actorId) {
            await sendTransientEphemeralResponse(c, 'Could not identify moderator user.', 'error')
            return
          }

          const existingLobby = await getLobbyByMatch(c.env.KV, matchId)
          const result = await resolveMatchByModerator(db, c.env.KV, {
            matchId,
            placements,
            resolvedAt: Date.now(),
          })

          if ('error' in result) {
            await sendTransientEphemeralResponse(c, result.error, 'error')
            return
          }

          const mode = normalizeMatchMode(result.match.gameMode)
          const moderation = { actorId, reason }

          if (existingLobby) {
            try {
              const updatedLobby = await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, existingLobby, {
                embeds: [lobbyResultEmbed(mode, result.participants, moderation)],
                components: [],
              })
              await storeMatchMessageMapping(c.env.KV, updatedLobby.messageId, result.match.id)
            }
            catch (error) {
              console.error(`Failed to update resolved result embed for match ${result.match.id}:`, error)
            }
          }

          const archiveChannelId = await getSystemChannel(c.env.KV, 'archive')
          if (archiveChannelId) {
            try {
              const archiveMessage = await createChannelMessage(c.env.DISCORD_TOKEN, archiveChannelId, {
                embeds: [lobbyResultEmbed(mode, result.participants, moderation)],
              })
              await storeMatchMessageMapping(c.env.KV, archiveMessage.id, result.match.id)
            }
            catch (error) {
              console.error(`Failed to post archive resolve note for match ${result.match.id}:`, error)
            }
          }

          try {
            await refreshConfiguredLeaderboards(db, c.env.KV, c.env.DISCORD_TOKEN)
          }
          catch (error) {
            console.error(`Failed to refresh leaderboard embeds after resolving match ${result.match.id}:`, error)
          }

          const recalculated = result.recalculatedMatchIds.length
          await sendTransientEphemeralResponse(
            c,
            `Resolved match **${result.match.id}** (was ${result.previousStatus}). Recalculated ${recalculated} completed ${formatModeLabel(mode)} matches.`,
            'success',
          )
        })
      }

      // ── queue recover ───────────────────────────────────
      case 'queue recover': {
        const mode = c.var.mode as GameMode

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const queue = await getQueueState(kv, mode)
          if (queue.entries.length > 0) {
            await clearQueue(kv, mode, queue.entries.map(entry => entry.playerId))
          }

          const lobby = await getLobby(kv, mode)
          let cancelledMatchId: string | null = null

          if (lobby?.matchId) {
            const db = createDb(c.env.DB)
            const [match] = await db
              .select({ id: matches.id, status: matches.status })
              .from(matches)
              .where(eq(matches.id, lobby.matchId))
              .limit(1)

            if (match && (match.status === 'drafting' || match.status === 'active')) {
              await db
                .update(matches)
                .set({ status: 'cancelled', completedAt: Date.now() })
                .where(eq(matches.id, match.id))
              cancelledMatchId = match.id
            }

            const participants = await db
              .select({ playerId: matchParticipants.playerId })
              .from(matchParticipants)
              .where(eq(matchParticipants.matchId, lobby.matchId))

            const channelId = await getChannelForMatch(kv, lobby.matchId)
            await clearActivityMappings(
              kv,
              lobby.matchId,
              participants.map(p => p.playerId),
              channelId ?? undefined,
            )
          }

          await clearLobby(kv, mode)

          const suffix = cancelledMatchId ? ` Cancelled match \`${cancelledMatchId}\`.` : ''
          await sendTransientEphemeralResponse(c, `Recovered ${mode.toUpperCase()} lobby state.${suffix}`, 'success')
        })
      }

      default:
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, 'Unknown mod subcommand.', 'error')
        })
    }
  },
)

function normalizeMatchMode(mode: string): GameMode {
  if (mode === '1v1' || mode === '2v2' || mode === '3v3' || mode === 'ffa') return mode
  return '1v1'
}
