import type { GameMode } from '@civup/game'
import type { LobbyState } from '../../services/lobby/types.ts'
import { createDb } from '@civup/db'
import { Button } from 'discord-hono'
import { getMatchForUser } from '../../services/activity/index.ts'
import { resolveInteractionLaunchMode } from '../../services/activity/browser-access.ts'
import { privateLaunchError, respondWithPreferredLaunch } from '../../services/activity/launch-response.ts'
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
      queueBackgroundTask(c, async () => {
        await queueSessionReportedDiscordSync(env.SessionDO, clickedLobby.id, {
          matchId: clickedLobby.matchId ?? clickedLobby.id,
          reason: 'stale completed join button clicked',
        })
      }, '[match-join] failed to queue completed match Discord repair:')

      return respondWithPreferredLaunch(c, {
        destination: { kind: 'session', sessionId: clickedLobby.id },
        activityChannelId: interactionChannelId ?? clickedLobby.channelId,
        activityUserId: identity.userId,
        activityTarget: { kind: 'match', id: clickedLobby.matchId },
      })
    }

    const clickedMatchId = clickedLobby
      ? clickedLobby.status === 'open'
        ? null
        : clickedLobby.matchId ?? clickedLobby.id
      : await resolveJoinButtonLiveMatchId(env.DB, identity.userId, interactionMessageId, db)

    const launch = await resolveInteractionLaunchMode(env, c.interaction.member?.roles)
    if (!launch.ok) return privateLaunchError(c, launch.error)
    const canonicalSessionId = launch.mode === 'browser'
      ? clickedLobby?.id ?? (clickedMatchId ? await resolveCanonicalSessionId(db, clickedMatchId) : null)
      : clickedLobby?.id ?? lobbyId
    if (!canonicalSessionId) return privateLaunchError(c, 'Could not resolve this session. Please use a current lobby message and try again.')
    const activityTarget = clickedLobby?.status === 'open'
      ? { kind: 'lobby' as const, id: clickedLobby.id }
      : clickedMatchId
        ? { kind: 'match' as const, id: clickedMatchId }
        : { kind: 'lobby' as const, id: lobbyId }

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

    return respondWithPreferredLaunch(c, {
      destination: { kind: 'session', sessionId: canonicalSessionId },
      activityChannelId: interactionChannelId ?? clickedLobby?.channelId ?? null,
      activityUserId: identity.userId,
      activityTarget,
      launch,
    })
  },
)

export const component_match_browse = factory.component(
  new Button('match-browse', 'Browse', 'Secondary'),
  async (c) => {
    const identity = getIdentity(c)
    const channelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const launch = await resolveInteractionLaunchMode(c.env, c.interaction.member?.roles)
    if (!launch.ok) return privateLaunchError(c, launch.error)
    if ((!identity || !channelId) && launch.mode === 'activity') return c.resActivity()
    if (!identity || !channelId) return privateLaunchError(c, 'Could not identify this Discord channel. Please try again in the server.')
    return respondWithPreferredLaunch(c, {
      destination: { kind: 'channel', channelId },
      activityChannelId: channelId,
      activityUserId: identity.userId,
      activityTarget: { kind: 'overview' },
      launch,
    })
  },
)

export const component_draft_activity = factory.component(
  new Button('draft-activity', 'Open Draft Activity', 'Primary'),
  async (c) => {
    const launch = await resolveInteractionLaunchMode(c.env, c.interaction.member?.roles)
    if (!launch.ok) return privateLaunchError(c, launch.error)
    const identity = getIdentity(c)
    const channelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const messageId = c.interaction.message?.id ?? null
    if (identity && channelId && messageId) {
      const matchId = await getMatchIdForMessage(createDb(c.env.DB), messageId).catch(() => null)
      if (matchId) {
        const sessionId = launch.mode === 'browser'
          ? await resolveCanonicalSessionId(createDb(c.env.DB), matchId)
          : matchId
        if (!sessionId) return privateLaunchError(c, 'Could not resolve this draft session. Please use a current lobby message.')
        return respondWithPreferredLaunch(c, {
          destination: { kind: 'session', sessionId },
          activityChannelId: channelId,
          activityUserId: identity.userId,
          activityTarget: { kind: 'match', id: matchId },
          launch,
        })
      }
    }
    if (launch.mode === 'activity') return c.resActivity()
    return privateLaunchError(c, 'Could not resolve this draft. Please use a current lobby message.')
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

export async function resolveCanonicalSessionId(
  db: ReturnType<typeof createDb>,
  targetId: string,
): Promise<string | null> {
  return (await getSessionLobbyProjectionByMatch(db, targetId).catch(() => null))?.id ?? null
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
