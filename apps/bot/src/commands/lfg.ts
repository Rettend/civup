import type { GameMode } from '@civup/game'
import type { Embed } from 'discord-hono'
import { createDb, matches, matchParticipants } from '@civup/db'
import { Button, Command, Option, SubCommand } from 'discord-hono'
import { eq } from 'drizzle-orm'
import { lobbyComponents, lobbyDraftingEmbed, lobbyOpenEmbed } from '../embeds/lfg.ts'
import {
  clearActivityMappings,
  createDraftRoom,
  getChannelForMatch,
  getMatchForUser,
  storeMatchMapping,
  storeUserMatchMappings,
} from '../services/activity.ts'
import { createChannelMessage } from '../services/discord.ts'
import { attachLobbyMatch, clearLobby, createLobby, getLobby } from '../services/lobby.ts'
import { upsertLobbyMessage } from '../services/lobby-message.ts'
import { createDraftMatch } from '../services/match.ts'
import { addToQueue, checkQueueFull, clearQueue, getPlayerQueueMode, getQueueState, removeFromQueue } from '../services/queue.ts'
import { factory } from '../setup.ts'

const GAME_MODE_CHOICES = [
  { name: 'FFA', value: 'ffa' },
  { name: 'Duel', value: 'duel' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' },
] as const

interface Var {
  mode?: string
  player?: string
}

// ── /lfg ... ────────────────────────────────────────────────

export const command_lfg = factory.command<Var>(
  new Command('lfg', 'Looking for game — queue management').options(
    new SubCommand('create', 'Create a lobby and auto-join as host').options(
      new Option('mode', 'Game mode for the lobby')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
    new SubCommand('join', 'Join the queue for a game mode').options(
      new Option('mode', 'Game mode to queue for')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
    new SubCommand('leave', 'Leave the current queue'),
    new SubCommand('status', 'Show all active lobbies'),
    new SubCommand('kick', 'Remove a player from the queue (admin)').options(
      new Option('player', 'Player to remove', 'User').required(),
    ),
    new SubCommand('recover', 'Force-clear stuck lobby state (admin)').options(
      new Option('mode', 'Lobby mode to recover')
        .required()
        .choices(...GAME_MODE_CHOICES),
    ),
  ),
  async (c) => {
    switch (c.sub.string) {
      // ── create ──────────────────────────────────────────
      case 'create': {
        const mode = c.var.mode as GameMode
        const identity = getIdentity(c)
        const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
        if (!identity || !channelId) return c.flags('EPHEMERAL').res('Could not identify you or this channel.')

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const existingLobby = await getLobby(kv, mode)
          if (existingLobby) {
            if (existingLobby.status === 'open') {
              const queue = await getQueueState(kv, mode)
              const embed = lobbyOpenEmbed(mode, queue.entries, queue.targetSize)
              try {
                await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, existingLobby, {
                  embeds: [embed],
                  components: lobbyComponents(mode, 'open'),
                })
              }
              catch (error) {
                console.error('Failed to refresh existing lobby embed:', error)
              }
              await c.followup(`A ${mode.toUpperCase()} lobby is already active in <#${existingLobby.channelId}>.`)
              return
            }

            if (!existingLobby.matchId) {
              await clearLobby(kv, mode)
            }
            else {
              const db = createDb(c.env.DB)
              const [existingMatch] = await db
                .select({ status: matches.status })
                .from(matches)
                .where(eq(matches.id, existingLobby.matchId))
                .limit(1)

              if (!existingMatch || existingMatch.status === 'completed' || existingMatch.status === 'cancelled') {
                await clearLobby(kv, mode)
              }
              else {
                await c.followup(`A ${mode.toUpperCase()} lobby is already active in <#${existingLobby.channelId}>.`)
                return
              }
            }
          }

          const staleQueue = await getQueueState(kv, mode)
          if (staleQueue.entries.length > 0) {
            await clearQueue(kv, mode, staleQueue.entries.map(entry => entry.playerId))
          }

          const result = await addToQueue(kv, mode, {
            playerId: identity.userId,
            displayName: identity.displayName,
            joinedAt: Date.now(),
          })

          if (result.error) {
            await c.followup(result.error)
            return
          }

          const queue = await getQueueState(kv, mode)
          const embed = lobbyOpenEmbed(mode, queue.entries, queue.targetSize)

          try {
            const message = await createChannelMessage(c.env.DISCORD_TOKEN, channelId, {
              embeds: [embed],
              components: lobbyComponents(mode, 'open'),
            })
            await createLobby(kv, {
              mode,
              hostId: identity.userId,
              channelId,
              messageId: message.id,
            })
            await c.followup(`Created ${mode.toUpperCase()} lobby in <#${channelId}>.`)
          }
          catch (error) {
            console.error('Failed to create lobby message:', error)
            await removeFromQueue(kv, identity.userId)
            await c.followup('Failed to create lobby message. Please try again.')
          }
        })
      }

      // ── join ────────────────────────────────────────────
      case 'join': {
        const mode = c.var.mode as GameMode
        const identity = getIdentity(c)
        if (!identity) return c.flags('EPHEMERAL').res('Could not identify you.')

        const lobby = await getLobby(c.env.KV, mode)
        if (!lobby) {
          const userMatchId = await getMatchForUser(c.env.KV, identity.userId)
          if (userMatchId) {
            c.executionCtx.waitUntil(storeUserMatchMappings(c.env.KV, [identity.userId], userMatchId))
            return c.resActivity()
          }
          return c.flags('EPHEMERAL').res(`No active ${mode.toUpperCase()} lobby. Use \`/lfg create\` first.`)
        }

        if (lobby.status !== 'open') {
          if (!lobby.matchId) {
            await clearLobby(c.env.KV, mode)
            return c.flags('EPHEMERAL').res('This lobby was stale and has been cleared. Use `/lfg create` to start a fresh lobby.')
          }

          c.executionCtx.waitUntil(storeUserMatchMappings(c.env.KV, [identity.userId], lobby.matchId))
          return c.resActivity()
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const outcome = await joinLobbyAndMaybeStartMatch(c, mode, identity.userId, identity.displayName, lobby.channelId)
          if ('error' in outcome) {
            await c.followup(outcome.error)
            return
          }

          try {
            await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
              embeds: outcome.embeds,
              components: outcome.components,
            })

            if (outcome.stage === 'drafting') {
              await c.followup('Lobby filled. Opening activity from the lobby message will place players in the draft room.')
              return
            }

            await c.followup('Joined lobby.')
          }
          catch (error) {
            console.error('Failed to update lobby message after slash join:', error)
            await c.followup('Joined queue, but failed to update lobby embed.')
          }
        })
      }

      // ── leave ───────────────────────────────────────────
      case 'leave': {
        const identity = getIdentity(c)
        if (!identity) return c.flags('EPHEMERAL').res('Could not identify you.')

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const removed = await removeFromQueue(kv, identity.userId)

          if (!removed) {
            const userMatchId = await getMatchForUser(kv, identity.userId)
            if (userMatchId) {
              await c.followup('You are not in queue right now. If you need back in, use `/lfg join` for the active mode to reopen the activity.')
              return
            }

            await c.followup('You are not in any queue.')
            return
          }

          const lobby = await getLobby(kv, removed)
          if (lobby?.status === 'open') {
            const queue = await getQueueState(kv, removed)
            try {
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyOpenEmbed(removed, queue.entries, queue.targetSize)],
                components: lobbyComponents(removed, 'open'),
              })
            }
            catch (error) {
              console.error('Failed to update lobby message after leave:', error)
            }
          }

          await c.followup(`Left ${removed.toUpperCase()} lobby.`)
        })
      }

      // ── status ──────────────────────────────────────────
      case 'status': {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const modes: GameMode[] = ['ffa', 'duel', '2v2', '3v3']
          const lines: string[] = []

          for (const mode of modes) {
            const lobby = await getLobby(kv, mode)
            if (!lobby) continue

            const label = LOBBY_STATUS_LABELS[lobby.status]
            if (lobby.status === 'open') {
              const queue = await getQueueState(kv, mode)
              lines.push(`- ${mode.toUpperCase()} - ${label} in <#${lobby.channelId}> (${queue.entries.length}/${queue.targetSize})`)
            }
            else {
              lines.push(`- ${mode.toUpperCase()} - ${label} in <#${lobby.channelId}>`)
            }
          }

          if (lines.length === 0) {
            await c.followup('No active lobbies. Use `/lfg create` to start one.')
            return
          }

          await c.followup(lines.join('\n'))
        })
      }

      // ── kick ────────────────────────────────────────────
      case 'kick': {
        const targetId = c.var.player
        if (!targetId) return c.res('Please specify a player.')

        // Basic admin check — guild-level manage_guild permission
        const permissions = BigInt(c.interaction.member?.permissions ?? '0')
        const MANAGE_GUILD = 1n << 5n
        if ((permissions & MANAGE_GUILD) === 0n) {
          return c.flags('EPHEMERAL').res('You need Manage Server permission to kick from queue.')
        }

        return c.flags('EPHEMERAL').resDefer(async (c) => {
          const kv = c.env.KV
          const removed = await removeFromQueue(kv, targetId)

          if (!removed) {
            await c.followup(`<@${targetId}> is not in any queue.`)
            return
          }

          const lobby = await getLobby(kv, removed)
          if (lobby?.status === 'open') {
            const queue = await getQueueState(kv, removed)
            try {
              await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
                embeds: [lobbyOpenEmbed(removed, queue.entries, queue.targetSize)],
                components: lobbyComponents(removed, 'open'),
              })
            }
            catch (error) {
              console.error('Failed to update lobby message after kick:', error)
            }
          }

          await c.followup(`<@${targetId}> was removed from the ${removed.toUpperCase()} lobby.`)
        })
      }

      // ── recover ─────────────────────────────────────────
      case 'recover': {
        const mode = c.var.mode as GameMode

        const permissions = BigInt(c.interaction.member?.permissions ?? '0')
        const MANAGE_GUILD = 1n << 5n
        if ((permissions & MANAGE_GUILD) === 0n) {
          return c.flags('EPHEMERAL').res('You need Manage Server permission to recover lobby state.')
        }

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
          await c.followup(`Recovered ${mode.toUpperCase()} lobby state.${suffix}`)
        })
      }

      default:
        return c.res('Unknown subcommand.')
    }
  },
)

// ── LFG Button Handlers ─────────────────────────────────────

export const component_lfg_join = factory.component(
  new Button('lfg-join', 'Join', 'Primary'),
  async (c) => {
    const mode = c.var.custom_id as GameMode | undefined
    const identity = getIdentity(c)
    if (!identity || !mode) return c.flags('EPHEMERAL').res('Something went wrong.')

    const lobby = await getLobby(c.env.KV, mode)
    if (!lobby) {
      const userMatchId = await getMatchForUser(c.env.KV, identity.userId)
      if (userMatchId) {
        c.executionCtx.waitUntil(storeUserMatchMappings(c.env.KV, [identity.userId], userMatchId))
        return c.resActivity()
      }
      return c.flags('EPHEMERAL').res(`No active ${mode.toUpperCase()} lobby. Use \`/lfg create\` first.`)
    }

    if (lobby.status !== 'open') {
      if (!lobby.matchId) {
        await clearLobby(c.env.KV, mode)
        return c.flags('EPHEMERAL').res('This lobby was stale and has been cleared. Use `/lfg create` to start a fresh lobby.')
      }
      c.executionCtx.waitUntil(storeUserMatchMappings(c.env.KV, [identity.userId], lobby.matchId))
      return c.resActivity()
    }

    const outcome = await joinLobbyAndMaybeStartMatch(c, mode, identity.userId, identity.displayName, lobby.channelId)
    if ('error' in outcome) {
      return c.flags('EPHEMERAL').res(outcome.error)
    }

    c.executionCtx.waitUntil((async () => {
      try {
        await upsertLobbyMessage(c.env.KV, c.env.DISCORD_TOKEN, lobby, {
          embeds: outcome.embeds,
          components: outcome.components,
        })
      }
      catch (error) {
        console.error('Failed to update lobby message after button join:', error)
      }
    })())

    return c.resActivity()
  },
)

export const component_draft_activity = factory.component(
  new Button('draft-activity', 'Open Draft Activity', 'Primary'),
  c => c.resActivity(),
)

export const component_lfg_leave = factory.component(
  new Button('lfg-leave', 'Leave Queue', 'Secondary'),
  (c) => {
    const identity = getIdentity(c)
    if (!identity) return c.flags('EPHEMERAL').res('Something went wrong.')

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const kv = c.env.KV
      const removed = await removeFromQueue(kv, identity.userId)

      if (!removed) {
        await c.followup('You are not in any queue.')
        return
      }

      const lobby = await getLobby(kv, removed)
      if (lobby?.status === 'open') {
        const queue = await getQueueState(kv, removed)
        try {
          await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
            embeds: [lobbyOpenEmbed(removed, queue.entries, queue.targetSize)],
            components: lobbyComponents(removed, 'open'),
          })
        }
        catch (error) {
          console.error('Failed to update lobby message after leave button:', error)
        }
      }

      await c.followup('You left the lobby queue.')
    })
  },
)

const LOBBY_STATUS_LABELS = {
  open: 'Lobby Open',
  drafting: 'Draft Ready',
  active: 'Draft Complete',
  completed: 'Result Reported',
} as const

function getIdentity(c: {
  interaction: {
    member?: { user?: { id?: string, global_name?: string | null, username?: string } }
    user?: { id?: string, global_name?: string | null, username?: string }
  }
}): { userId: string, displayName: string } | null {
  const userId = c.interaction.member?.user?.id ?? c.interaction.user?.id
  if (!userId) return null

  const displayName = c.interaction.member?.user?.global_name
    ?? c.interaction.member?.user?.username
    ?? c.interaction.user?.global_name
    ?? c.interaction.user?.username
    ?? 'Unknown'

  return { userId, displayName }
}

async function joinLobbyAndMaybeStartMatch(
  c: {
    env: {
      DB: D1Database
      KV: KVNamespace
      PARTY_HOST?: string
      BOT_HOST?: string
      DRAFT_WEBHOOK_SECRET?: string
    }
  },
  mode: GameMode,
  userId: string,
  displayName: string,
  channelId: string,
): Promise<
  | {
    stage: 'open'
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | {
    stage: 'drafting'
    matchId: string
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | { error: string }
> {
  const kv = c.env.KV
  const existingMode = await getPlayerQueueMode(kv, userId)
  if (existingMode && existingMode !== mode) {
    return { error: `You're already in the ${existingMode.toUpperCase()} queue. Leave it first with \`/lfg leave\`.` }
  }

  let shouldJoinQueue = !existingMode
  if (existingMode === mode) {
    const queue = await getQueueState(kv, mode)
    shouldJoinQueue = !queue.entries.some(entry => entry.playerId === userId)
  }

  if (shouldJoinQueue) {
    const joined = await addToQueue(kv, mode, {
      playerId: userId,
      displayName,
      joinedAt: Date.now(),
    })
    if (joined.error) return { error: joined.error }
  }

  const matchedEntries = await checkQueueFull(kv, mode)
  if (!matchedEntries) {
    const queue = await getQueueState(kv, mode)
    return {
      stage: 'open',
      embeds: [lobbyOpenEmbed(mode, queue.entries, queue.targetSize)],
      components: lobbyComponents(mode, 'open'),
    }
  }

  try {
    const { matchId, formatId: _formatId, seats } = await createDraftRoom(mode, matchedEntries, {
      partyHost: c.env.PARTY_HOST,
      botHost: c.env.BOT_HOST,
      webhookSecret: c.env.DRAFT_WEBHOOK_SECRET,
    })
    const db = createDb(c.env.DB)
    await createDraftMatch(db, { matchId, mode, seats })

    await clearQueue(kv, mode, matchedEntries.map(e => e.playerId))
    await storeMatchMapping(kv, channelId, matchId)
    await storeUserMatchMappings(kv, matchedEntries.map(e => e.playerId), matchId)
    await attachLobbyMatch(kv, mode, matchId)

    return {
      stage: 'drafting',
      matchId,
      embeds: [lobbyDraftingEmbed(mode, seats)],
      components: lobbyComponents(mode, 'drafting'),
    }
  }
  catch (error) {
    console.error('Failed to start draft match from lobby:', error)
    await removeFromQueue(kv, userId)
    return { error: 'Failed to start draft. Please try joining again.' }
  }
}
