import type { GameMode } from '@civup/game'
import { createDb } from '@civup/db'
import { Button } from 'discord-hono'
import { getMatchForUser } from '../../services/activity/index.ts'
import { clearLobbyById, getLobbyById } from '../../services/lobby/index.ts'
import { findPersistedBlockingDraftMatchIdsForPlayers, findPersistedLiveMatchIds } from '../../services/match/live.ts'
import { getMatchIdForMessage } from '../../services/match/message.ts'
import { upsertLobbyMessage } from '../../services/lobby/message.ts'
import { sendTransientEphemeralResponse } from '../../services/response/ephemeral.ts'
import { createStateStore } from '../../services/state/store.ts'
import { factory } from '../../setup.ts'
import { findBlockingDraftMatchIdsForPlayers, getIdentity, joinLobbyAndMaybeStartMatch } from './shared.ts'

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
    const kv = createStateStore(env)

    queueBackgroundTask(c, async () => {
      const lobby = await getLobbyById(kv, lobbyId)
      if (!lobby) {
        const userMatchId = await resolveJoinButtonLiveMatchId(kv, env.DB, identity.userId, c.interaction.message?.id ?? null)

        if (userMatchId) return
        return
      }

      if (lobby.status !== 'open') {
        if (!lobby.matchId) return

        const persistedLiveMatchIds = await findPersistedLiveMatchIds(env.DB, [lobby.matchId])
        if (persistedLiveMatchIds && !persistedLiveMatchIds.has(lobby.matchId)) return
        return
      }

      if (lobby.memberPlayerIds.length === 0) return

      const db = createDb(env.DB)
      const blockingDraftMatchIdByPlayer = await findBlockingDraftMatchIdsForPlayers(db, [identity.userId])
      const currentMatchId = blockingDraftMatchIdByPlayer.get(identity.userId) ?? null
      if (currentMatchId) return

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
          liveMatchPlayerIds: new Set(blockingDraftMatchIdByPlayer.keys()),
        },
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

export async function resolveJoinButtonLiveMatchId(
  kv: KVNamespace,
  d1: D1Database,
  userId: string,
  messageId: string | null,
  db = createDb(d1),
): Promise<string | null> {
  let userMatchId = messageId ? await getMatchIdForMessage(db, messageId) : null
  if (userMatchId) {
    const persistedLiveMatchIds = await findPersistedLiveMatchIds(d1, [userMatchId])
    if (persistedLiveMatchIds?.has(userMatchId)) return userMatchId
    userMatchId = null
  }

  userMatchId = await getMatchForUser(kv, userId)
    if (userMatchId) {
      const persistedLiveMatchIds = await findPersistedLiveMatchIds(d1, [userMatchId])
      if (persistedLiveMatchIds?.has(userMatchId)) return userMatchId
    }

  const blockingDraftMatchIds = await findPersistedBlockingDraftMatchIdsForPlayers(d1, [userId])
  return blockingDraftMatchIds?.get(userId) ?? null
}

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
