import type { GameMode } from '@civup/game'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Button } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getMatchForUser, storeMatchActivityState, storeUserActivityTarget, storeUserLobbyState, storeUserMatchMappings } from '../../services/activity/index.ts'
import { clearLobbyById, filterInactiveOpenLobbies, getLobbyById, LOBBY_TIMEOUT_MESSAGE } from '../../services/lobby/index.ts'
import { upsertLobbyMessage } from '../../services/lobby/message.ts'
import { sendTransientEphemeralResponse } from '../../services/response/ephemeral.ts'
import { createStateStore } from '../../services/state/store.ts'
import { factory } from '../../setup.ts'
import { getIdentity, joinLobbyAndMaybeStartMatch } from './shared.ts'

export const component_match_join = factory.component(
  new Button('match-join', 'Join', 'Primary'),
  async (c) => {
    const [modeRaw, lobbyId] = (c.var.custom_id ?? '').split(':')
    const mode = modeRaw as GameMode | undefined
    const kv = createStateStore(c.env)
    const identity = getIdentity(c)
    if (!identity || !mode || !lobbyId) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Something went wrong.', 'error')
      })
    }

    const lobby = await getLobbyById(kv, lobbyId)
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

    if (lobby.status === 'open') {
      const [activeLobby] = await filterInactiveOpenLobbies(kv, [lobby])
      if (!activeLobby) {
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, `${LOBBY_TIMEOUT_MESSAGE} The embed will update shortly.`, 'error')
        })
      }
    }

    if (lobby.status !== 'open') {
      if (!lobby.matchId) {
        await clearLobbyById(kv, lobby.id, lobby)
        return c.flags('EPHEMERAL').resDefer(async (c) => {
          await sendTransientEphemeralResponse(c, 'This lobby was stale and has been cleared. Use `/match create` to start a fresh lobby.', 'error')
        })
      }
      await storeMatchActivityState(kv, lobby.channelId, [identity.userId], {
        matchId: lobby.matchId,
        lobbyId: lobby.id,
        mode: lobby.mode,
        steamLobbyLink: lobby.steamLobbyLink,
        activitySecret: c.env.CIVUP_SECRET,
      })
      return c.resActivity()
    }

    await storeUserLobbyState(kv, lobby.channelId, [identity.userId], lobby.id, { pendingJoin: true })

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
        {
          preferredLobbyId: lobby.id,
          skipMatchmakingRankGate: true,
        },
      )
      if ('error' in outcome) {
        await storeUserLobbyState(kv, lobby.channelId, [identity.userId], lobby.id)
        console.warn('[match-join] join failed after activity launch', {
          mode,
          userId: identity.userId,
          error: outcome.error,
        })
        return
      }

      try {
        await storeUserLobbyState(kv, outcome.lobby.channelId, [identity.userId], outcome.lobby.id)
        await upsertLobbyMessage(kv, c.env.DISCORD_TOKEN, outcome.lobby, {
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
