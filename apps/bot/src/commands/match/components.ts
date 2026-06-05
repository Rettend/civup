import type { GameMode } from '@civup/game'
import type { LobbyState } from '../../services/lobby/types.ts'
import { createDb } from '@civup/db'
import { Button } from 'discord-hono'
import { getMatchForUser } from '../../services/activity/index.ts'
import { storeActivityLaunchTargetSelection } from '../../services/activity/launch-target.ts'
import { getKvStore } from '../../services/kv/batch.ts'
import { upsertLobbyMessage } from '../../services/lobby/message.ts'
import { findPersistedBlockingDraftMatchIdsForPlayers, findPersistedLiveMatchIds } from '../../services/match/live.ts'
import { getMatchIdForMessage } from '../../services/match/message.ts'
import { sendTransientEphemeralResponse } from '../../services/response/ephemeral.ts'
import { getSessionLobbyProjectionByMatch } from '../../services/session/index.ts'
import { getTournamentMatchBySessionId, updateTournamentMatchRoster, validateTournamentLobbyJoin } from '../../services/tournament/index.ts'
import { queueSessionReportedDiscordSync } from '../../session-runtime/session-do-client.ts'
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
    const kv = getKvStore(env)
    const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const interactionMessageId = c.interaction.message?.id ?? null
    const db = createDb(env.DB)
    const clickedLobby = await getSessionLobbyProjectionByMatch(db, lobbyId).catch(() => null)
    const clickedTournamentMatch = clickedLobby ? await getTournamentMatchBySessionId(db, clickedLobby.id) : null
    if (clickedLobby?.status === 'completed' && clickedLobby.matchId) {
      await storeActivityLaunchTargetSelection(env.Activity, env.CIVUP_SECRET, interactionChannelId ?? clickedLobby.channelId, identity.userId, {
        kind: 'match',
        id: clickedLobby.matchId,
      })
      queueBackgroundTask(c, async () => {
        await queueSessionReportedDiscordSync(env.SessionDO, clickedLobby.id, {
          matchId: clickedLobby.matchId ?? clickedLobby.id,
          reason: 'stale completed join button clicked',
        })
      }, '[match-join] failed to queue completed match Discord repair:')

      return c.resActivity()
    }

    const clickedMatchId = clickedLobby
      ? clickedLobby.status === 'open'
        ? null
        : clickedLobby.matchId ?? clickedLobby.id
      : await resolveJoinButtonLiveMatchId(env.DB, identity.userId, interactionMessageId, db)

    await storeActivityLaunchTargetSelection(env.Activity, env.CIVUP_SECRET, interactionChannelId ?? clickedLobby?.channelId ?? null, identity.userId, clickedLobby?.status === 'open'
      ? { kind: 'lobby', id: clickedLobby.id }
      : clickedMatchId
        ? { kind: 'match', id: clickedMatchId }
        : { kind: 'lobby', id: lobbyId })

    queueBackgroundTask(c, async () => {
      const db = createDb(env.DB)
      const lobby = clickedLobby ?? await getSessionLobbyProjectionByMatch(db, lobbyId)
      if (!lobby) {
        const userMatchId = clickedMatchId ?? await resolveJoinButtonLiveMatchId(env.DB, identity.userId, interactionMessageId)

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
      if (!shouldJoinOpenLobbyFromActivityButton(lobby, identity.userId)) return
      if (clickedTournamentMatch) {
        const validation = await validateTournamentLobbyJoin(db, lobby, identity)
        if (!validation.ok) return
      }

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
          includeTournamentLobbies: clickedTournamentMatch != null,
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
        if (clickedTournamentMatch) await updateTournamentMatchRoster(db, outcome.lobby.id, outcome.lobby.memberPlayerIds)
        await upsertLobbyMessage(kv, env.DISCORD_TOKEN, outcome.lobby, {
          embeds: outcome.embeds,
          components: outcome.components,
        }, { db, sessionNamespace: env.SessionDO })
      }
      catch (error) {
        console.error('Failed to update lobby message after button join:', error)
      }
    }, '[match-join] failed after activity launch:')

    return c.resActivity()
  },
)

export const component_match_browse = factory.component(
  new Button('match-browse', 'Browse', 'Secondary'),
  async (c) => {
    const identity = getIdentity(c)
    if (identity) {
      const channelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
      await storeActivityLaunchTargetSelection(c.env.Activity, c.env.CIVUP_SECRET, channelId, identity.userId, { kind: 'overview' })
    }
    return c.resActivity()
  },
)

export const component_draft_activity = factory.component(
  new Button('draft-activity', 'Open Draft Activity', 'Primary'),
  async (c) => {
    const identity = getIdentity(c)
    const channelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const messageId = c.interaction.message?.id ?? null
    if (identity && channelId && messageId) {
      const matchId = await getMatchIdForMessage(createDb(c.env.DB), messageId).catch(() => null)
      if (matchId) {
        await storeActivityLaunchTargetSelection(c.env.Activity, c.env.CIVUP_SECRET, channelId, identity.userId, { kind: 'match', id: matchId })
      }
    }
    return c.resActivity()
  },
)

export async function resolveJoinButtonLiveMatchId(
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

  userMatchId = await getMatchForUser(db, userId)
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

export function shouldJoinOpenLobbyFromActivityButton(lobby: Pick<LobbyState, 'memberPlayerIds' | 'slots'>, userId: string): boolean {
  return lobby.memberPlayerIds.includes(userId)
    || lobby.slots.includes(userId)
    || lobby.slots.some(slot => slot == null)
}
