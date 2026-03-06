import type { GameMode } from '@civup/game'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Button } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getMatchForUser, storeUserMatchMappings } from '../../services/activity.ts'
import { sendTransientEphemeralResponse } from '../../services/ephemeral-response.ts'
import { upsertLobbyMessage } from '../../services/lobby-message.ts'
import { clearLobby, getLobby } from '../../services/lobby.ts'
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

    // Keep component response fast so Discord doesn't time out launch-activity interactions.
    c.executionCtx.waitUntil((async () => {
      const outcome = await joinLobbyAndMaybeStartMatch(
        c,
        mode,
        [{
          playerId: identity.userId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        }],
        lobby.channelId,
      )
      if ('error' in outcome) {
        console.warn('[match-join] join failed after activity launch', {
          mode,
          userId: identity.userId,
          error: outcome.error,
        })
        return
      }

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
