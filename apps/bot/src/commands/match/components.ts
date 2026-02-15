import type { GameMode } from '@civup/game'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel, maxPlayerCount } from '@civup/game'
import { Button } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { lobbyComponents, lobbyOpenEmbed } from '../../embeds/match.ts'
import { getMatchForUser, storeUserMatchMappings } from '../../services/activity.ts'
import { clearDeferredEphemeralResponse, sendTransientEphemeralResponse } from '../../services/ephemeral-response.ts'
import { upsertLobbyMessage } from '../../services/lobby-message.ts'
import { clearLobby, getLobby, mapLobbySlotsToEntries, normalizeLobbySlots, sameLobbySlots, setLobbySlots } from '../../services/lobby.ts'
import { getQueueState, removeFromQueue } from '../../services/queue.ts'
import { createStateStore } from '../../services/state-store.ts'
import { factory } from '../../setup.ts'
import { getIdentity, joinLobbyAndMaybeStartMatch } from './shared.ts'

export const component_match_join = factory.component(
  new Button('match-join', 'Join', 'Primary'),
  async (c) => {
    const mode = c.var.custom_id as GameMode | undefined
    const kv = createStateStore(c.env)
    const identity = getIdentity(c)
    if (!identity || !mode) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Something went wrong.', 'error')
      })
    }

    const lobby = await getLobby(kv, mode)
    if (!lobby) {
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

    if (lobby.status !== 'open') {
      if (!lobby.matchId) {
        await clearLobby(kv, mode)
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, 'This lobby was stale and has been cleared. Use `/match create` to start a fresh lobby.', 'error')
        })
      }
      c.executionCtx.waitUntil(storeUserMatchMappings(kv, [identity.userId], lobby.matchId))
      return c.resActivity()
    }

    const outcome = await joinLobbyAndMaybeStartMatch(
      c,
      mode,
      identity.userId,
      identity.displayName,
      identity.avatarUrl,
      lobby.channelId,
    )
    if ('error' in outcome) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, outcome.error, 'error')
      })
    }

    c.executionCtx.waitUntil((async () => {
      try {
        await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
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

export const component_match_leave = factory.component(
  new Button('match-leave', 'Leave Queue', 'Secondary'),
  (c) => {
    const identity = getIdentity(c)
    if (!identity) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Something went wrong.', 'error')
      })
    }

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const kv = createStateStore(c.env)
      const removed = await removeFromQueue(kv, identity.userId)

      if (!removed) {
        await sendTransientEphemeralResponse(c, 'You are not in any queue.', 'error')
        return
      }

      const lobby = await getLobby(kv, removed)
      if (lobby?.status === 'open') {
        const queue = await getQueueState(kv, removed)
        const slots = normalizeLobbySlots(removed, lobby.slots, queue.entries)
        const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)
        if (!sameLobbySlots(slots, lobby.slots)) {
          await setLobbySlots(kv, removed, slots)
        }
        try {
          await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, lobby, {
            embeds: [lobbyOpenEmbed(removed, slottedEntries, maxPlayerCount(removed))],
            components: lobbyComponents(removed),
          })
        }
        catch (error) {
          console.error('Failed to update lobby message after leave button:', error)
        }
      }

      await clearDeferredEphemeralResponse(c)
    })
  },
)
