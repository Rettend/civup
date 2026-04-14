import type { GameMode } from '@civup/game'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel } from '@civup/game'
import { Button } from 'discord-hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { clearLobbyMappingsIfMatchingLobby, getMatchForUser, storeMatchActivityState, storeUserActivityTarget, storeUserLobbyState, storeUserMatchMappings } from '../../services/activity/index.ts'
import { clearLobbyById, filterQueueEntriesForLobby, getLobbyById } from '../../services/lobby/index.ts'
import { upsertLobbyMessage } from '../../services/lobby/message.ts'
import { getQueueState } from '../../services/queue/index.ts'
import { sendTransientEphemeralResponse } from '../../services/response/ephemeral.ts'
import { createStateStore } from '../../services/state/store.ts'
import { factory } from '../../setup.ts'
import { findLiveMatchIdsForPlayers, getIdentity, joinLobbyAndMaybeStartMatch } from './shared.ts'
import { isQueueBackedOpenLobby } from '../../routes/lobby/snapshot.ts'

export const component_match_join = factory.component(
  new Button('match-join', 'Join', 'Primary'),
  async (c) => {
    const [modeRaw, lobbyId] = (c.var.custom_id ?? '').split(':')
    const mode = modeRaw as GameMode | undefined
    const identity = getIdentity(c)
    if (!identity || !mode || !lobbyId) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Something went wrong.', 'error')
      })
    }

    const env = c.env
    const interactionChannelId = c.interaction.channel_id ?? null
    const kv = createStateStore(env)

    if (interactionChannelId) {
      await storeUserLobbyState(kv, interactionChannelId, [identity.userId], lobbyId, { pendingJoin: true })
    }

    queueBackgroundTask(c, async () => {
      const lobby = await getLobbyById(kv, lobbyId)
      if (!lobby) {
        let userMatchId = await getMatchForUser(kv, identity.userId)
        if (!userMatchId) {
          const db = createDb(env.DB)
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
          if (interactionChannelId) {
            await storeUserActivityTarget(kv, interactionChannelId, [identity.userId], {
              kind: 'match',
              id: userMatchId,
              activitySecret: env.CIVUP_SECRET,
            })
          }
          await storeUserMatchMappings(kv, [identity.userId], userMatchId)
          return
        }

        if (interactionChannelId) {
          await clearLobbyMappingsIfMatchingLobby(kv, [identity.userId], lobbyId, interactionChannelId)
        }
        return
      }

      if (lobby.status !== 'open') {
        if (!lobby.matchId) {
          await clearLobbyById(kv, lobby.id, lobby)
          if (interactionChannelId) {
            await clearLobbyMappingsIfMatchingLobby(kv, [identity.userId], lobby.id, interactionChannelId)
          }
          return
        }

        await storeMatchActivityState(kv, lobby.channelId, [identity.userId], {
          matchId: lobby.matchId,
          lobbyId: lobby.id,
          mode: lobby.mode,
          steamLobbyLink: lobby.steamLobbyLink,
          activitySecret: env.CIVUP_SECRET,
        })
        await storeUserMatchMappings(kv, [identity.userId], lobby.matchId)
        return
      }

      const queue = await getQueueState(kv, mode)
      if (!isQueueBackedOpenLobby(lobby, filterQueueEntriesForLobby(lobby, queue.entries))) {
        await clearLobbyById(kv, lobby.id, lobby)
        if (interactionChannelId) {
          await clearLobbyMappingsIfMatchingLobby(kv, [identity.userId], lobby.id, interactionChannelId)
        }
        return
      }

      const db = createDb(env.DB)
      const liveMatchIdByPlayer = await findLiveMatchIdsForPlayers(db, [identity.userId])
      const currentMatchId = liveMatchIdByPlayer.get(identity.userId) ?? null
      if (currentMatchId) {
        await storeMatchActivityState(kv, lobby.channelId, [identity.userId], {
          matchId: currentMatchId,
          activitySecret: env.CIVUP_SECRET,
        })
        await storeUserMatchMappings(kv, [identity.userId], currentMatchId)
        return
      }

      const outcome = await joinLobbyAndMaybeStartMatch(
        { env },
        mode,
        [{
          playerId: identity.userId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        }],
        {
          preferredLobbyId: lobby.id,
          skipMatchmakingRankGate: true,
          liveMatchPlayerIds: new Set(liveMatchIdByPlayer.keys()),
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
        await upsertLobbyMessage(kv, env.DISCORD_TOKEN, outcome.lobby, {
          embeds: outcome.embeds,
          components: outcome.components,
        })
      }
      catch (error) {
        console.error('Failed to update lobby message after button join:', error)
      }
    }, '[match-join] failed after activity launch:')

    return c.resActivity()
  },
)

export const component_draft_activity = factory.component(
  new Button('draft-activity', 'Open Draft Activity', 'Primary'),
  c => c.resActivity(),
)

function queueBackgroundTask(context: { executionCtx: { waitUntil: (promise: Promise<unknown>) => void } }, run: () => Promise<void>, errorMessage: string): void {
  const task = (async () => {
    try {
      await run()
    }
    catch (error) {
      console.error(errorMessage, error)
    }
  })()

  try {
    context.executionCtx.waitUntil(task)
  }
  catch {
    void task
  }
}
