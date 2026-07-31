import type { createDb } from '@civup/db'
import type { GameMode, QueueEntry, SourceGuildIdentity } from '@civup/game'
import type { Embed } from 'discord-hono'
import type { lobbyComponents } from '../../embeds/match.ts'
import type { DeferredOpenLobbyTransferSource, LobbyState } from '../../services/lobby/index.ts'
import { createDb as createCivupDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel, isTeamMode } from '@civup/game'
import { Option } from 'discord-hono'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getKvStore } from '../../services/kv/batch.ts'
import { filterQueueEntriesForLobby, finalizeDeferredOpenLobbyTransferSource, getLobbyById, leaveOpenLobbyForLobbyJoin, mapLobbySlotsToEntries, normalizeLobbySlots, restoreDeferredOpenLobbyTransferSourceAdmission, rollbackDeferredOpenLobbyTransferTarget, sameLobbySlots, setLobbyRoster } from '../../services/lobby/index.ts'
import { syncLobbyDerivedState } from '../../services/lobby/live-snapshot.ts'
import { buildOpenLobbyRenderPayload } from '../../services/lobby/render.ts'
import { getCalculatedRankGateError } from '../../services/ranked/admission.ts'
import { createStatsContext } from '../../services/stats/context.ts'
import { formatSessionAdmissionError, getCurrentSessionLobbyProjectionsForPlayers, getOpenSessionLobbyProjectionForPlayer, getOpenSessionLobbyProjectionHostedBy, getOpenSessionLobbyProjectionsByMode, isSessionAdmissionError } from '../../services/session/index.ts'
import { buildTournamentReservedSlotLabels, listOpenTournamentSessionIds } from '../../services/tournament/index.ts'
import { getSessionRecord } from '../../session-runtime/session-do-client.ts'
import { buildSessionRosterQueueEntries } from '../../session-runtime/session-record.ts'

export { getIdentity, getIdentityByUserId } from '../identity.ts'

const ALL_FFA_PLACEMENT_KEYS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'] as const
const FFA_PLACEMENT_LABELS: Record<(typeof ALL_FFA_PLACEMENT_KEYS)[number], string> = {
  second: '2nd place',
  third: '3rd place',
  fourth: '4th place',
  fifth: '5th place',
  sixth: '6th place',
  seventh: '7th place',
  eighth: '8th place',
  ninth: '9th place',
  tenth: '10th place',
  eleventh: '11th place',
  twelfth: '12th place',
}

export const FFA_PLACEMENT_KEYS = ALL_FFA_PLACEMENT_KEYS
export type FfaPlacementKey = (typeof FFA_PLACEMENT_KEYS)[number]

export const LOBBY_STATUS_LABELS = {
  open: 'Lobby Open',
  drafting: 'Drafting',
  active: 'Draft Complete',
  completed: 'Result Reported',
  cancelled: 'Draft Cancelled',
  scrubbed: 'Match Scrubbed',
} as const

export interface MatchVar {
  mode?: string
  steam_link?: string
  player?: string
  match_id?: string
  winner?: string
  second?: string
  third?: string
  fourth?: string
  fifth?: string
  sixth?: string
  seventh?: string
  eighth?: string
  ninth?: string
  tenth?: string
  eleventh?: string
  twelfth?: string
}

export interface MatchJoinEntry {
  playerId: string
  displayName: string
  avatarUrl: string
  sourceGuild?: SourceGuildIdentity
}

export function buildFfaPlacementOptions() {
  return FFA_PLACEMENT_KEYS.map(key => new Option(key, FFA_PLACEMENT_LABELS[key], 'User'))
}

export async function joinLobbyAndMaybeStartMatch(
  c: {
    env: {
      DB?: D1Database
      KV: KVNamespace
      SessionDO?: DurableObjectNamespace
      DISCORD_TOKEN?: string
      CIVUP_SECRET?: string
      ALLOWED_DISCORD_GUILD_ID?: string
    }
  },
  mode: GameMode,
  requestedEntries: MatchJoinEntry[],
  options?: {
    preferredLobbyId?: string
    liveMatchPlayerIds?: ReadonlySet<string>
    includeTournamentLobbies?: boolean
  },
): Promise<
  | {
    stage: 'open'
    lobby: LobbyState
    embeds: [Embed]
    components: ReturnType<typeof lobbyComponents>
  }
  | { error: string }
> {
  if (requestedEntries.length === 0) {
    return { error: 'No players were provided for this join request.' }
  }

  const seenPlayerIds = new Set<string>()
  for (const entry of requestedEntries) {
    if (seenPlayerIds.has(entry.playerId)) {
      return { error: 'Join request contains duplicate players.' }
    }
    seenPlayerIds.add(entry.playerId)
  }

  const kv = getKvStore(c.env)
  if (!c.env.DB) return { error: 'D1 binding is not configured.' }
  const db = createCivupDb(c.env.DB)
  let openLobbies = (await getOpenSessionLobbyProjectionsByMode(db, mode))
    .filter(lobby => lobby.memberPlayerIds.length > 0)
  if (options?.includeTournamentLobbies !== true) {
    const tournamentSessionIds = await listOpenTournamentSessionIds(db)
    openLobbies = openLobbies.filter(lobby => !tournamentSessionIds.has(lobby.id))
  }
  const currentLobbiesByPlayerId = await getCurrentSessionLobbyProjectionsForPlayers(db, requestedEntries.map(entry => entry.playerId))
  let currentOpenLobby: LobbyState | null = null

  for (const entry of requestedEntries) {
    if (options?.liveMatchPlayerIds?.has(entry.playerId)) {
      return { error: `<@${entry.playerId}> is already in a live match.` }
    }

    const currentLobby = currentLobbiesByPlayerId.get(entry.playerId) ?? null
    if (!currentLobby) continue
    if (currentLobby.status !== 'open') return { error: `<@${entry.playerId}> is already in a live match.` }
    if (currentOpenLobby && currentOpenLobby.id !== currentLobby.id) return { error: 'Requested players are already split across different open lobbies.' }
    currentOpenLobby = currentLobby
  }

  const preferredLobbyId = options?.preferredLobbyId ?? (currentOpenLobby?.mode === mode ? currentOpenLobby.id : null)

  const now = Date.now()
  const requestedRosterEntries: QueueEntry[] = requestedEntries.map((entry, index) => ({
    playerId: entry.playerId,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    ...(entry.sourceGuild ? { sourceGuild: entry.sourceGuild } : {}),
    joinedAt: now + index,
  }))

  if (openLobbies.length === 0) {
    return { error: `No open ${formatModeLabel(mode)} lobby. Use \`/match create\` first.` }
  }

  const candidateLobbies = preferredLobbyId
    ? openLobbies.filter(lobby => lobby.id === preferredLobbyId)
    : openLobbies
  const candidateResults = await Promise.all(candidateLobbies
    .map(async (lobby) => {
      const candidateLobbyMemberPlayerIds = lobby.memberPlayerIds
      const candidateRosterEntries = await getOpenLobbyRosterEntries(c.env.SessionDO, lobby)
      const candidateLobbyQueueEntries = filterQueueEntriesForLobby({
        ...lobby,
        memberPlayerIds: candidateLobbyMemberPlayerIds,
      }, candidateRosterEntries)
      const candidateCurrentSlots = normalizeLobbySlots(mode, lobby.slots, candidateLobbyQueueEntries)
      const candidateLobby = {
        ...lobby,
        memberPlayerIds: candidateLobbyMemberPlayerIds,
        slots: candidateCurrentSlots,
      }

      const gateError = await getRoleGateErrorForLobby(
        db,
        kv,
        candidateLobby,
        requestedEntries,
        c.env.ALLOWED_DISCORD_GUILD_ID ?? '',
      )
      if (gateError) {
        return { gateError }
      }

      const placement = placeRequestedEntries(mode, candidateCurrentSlots, requestedEntries)
      if ('error' in placement) return null

      return {
        lobby: candidateLobby,
        queueEntries: candidateLobbyQueueEntries,
        slots: placement.slots,
        score: scoreLobbyCandidate(candidateLobby, candidateCurrentSlots, placement.slots, requestedEntries.length),
      }
    }))

  const scoredCandidates = candidateResults
    .filter((candidate): candidate is { lobby: LobbyState, queueEntries: QueueEntry[], slots: (string | null)[], score: string } => candidate != null && 'lobby' in candidate)
    .sort((left, right) => left.score.localeCompare(right.score))

  const chosen = scoredCandidates[0]
  if (!chosen) {
    const gateError = candidateResults.find((result): result is { gateError: string } => result != null && 'gateError' in result)?.gateError
    if (gateError) return { error: gateError }
    return { error: 'No compatible open lobby could fit this join.' }
  }

  const targetLobbyBeforeTransfer = chosen.lobby
  const targetQueueEntriesBeforeTransfer = [...chosen.queueEntries]
  let transferSource: { lobby: LobbyState, queueEntries: QueueEntry[] } | null = null
  let deferredTransferSource: DeferredOpenLobbyTransferSource | null = null
  if (currentOpenLobby && currentOpenLobby.id !== chosen.lobby.id) {
    const sourceRosterEntries = await getOpenLobbyRosterEntries(c.env.SessionDO, currentOpenLobby)
    transferSource = { lobby: currentOpenLobby, queueEntries: sourceRosterEntries }
    const transferResult = await leaveOpenLobbyForLobbyJoin(
      kv,
      c.env.DISCORD_TOKEN,
      currentOpenLobby,
      requestedEntries.map(entry => entry.playerId),
      mode,
      {
        db: c.env.DB ? createCivupDb(c.env.DB) : null,
        sessionNamespace: c.env.SessionDO,
        queueEntries: sourceRosterEntries,
      },
    )
    if (!transferResult.ok) {
      return { error: transferResult.error }
    }
    deferredTransferSource = transferResult.deferredSource ?? null
  }

  let nextLobby = chosen.lobby
  const nextLobbyQueueEntriesBeforePlacement = filterQueueEntriesForLobby(nextLobby, chosen.queueEntries)
  nextLobby = {
    ...nextLobby,
    slots: normalizeLobbySlots(mode, nextLobby.slots, nextLobbyQueueEntriesBeforePlacement),
  }
  const chosenPlacement = placeRequestedEntries(mode, nextLobby.slots, requestedEntries)
  if ('error' in chosenPlacement) return { error: chosenPlacement.error }
  const nextSlots = chosenPlacement.slots
  const nextMemberPlayerIds = [...new Set([...nextLobby.memberPlayerIds, ...requestedEntries.map(entry => entry.playerId)])]
  const addedNewPlayers = nextMemberPlayerIds.length !== nextLobby.memberPlayerIds.length

  if (nextMemberPlayerIds.length !== nextLobby.memberPlayerIds.length || !sameLobbySlots(nextSlots, nextLobby.slots) || addedNewPlayers) {
    nextLobby = {
      ...nextLobby,
      memberPlayerIds: nextMemberPlayerIds,
      slots: nextSlots,
      lastActivityAt: addedNewPlayers ? now : nextLobby.lastActivityAt,
      updatedAt: now,
      revision: nextLobby.revision + 1,
    }
    try {
      nextLobby = await setLobbyRoster(kv, nextLobby.id, {
        memberPlayerIds: nextMemberPlayerIds,
        slots: nextSlots,
        lastActivityAt: addedNewPlayers ? now : nextLobby.lastActivityAt,
        now,
      }, chosen.lobby, {
        db: c.env.DB ? createCivupDb(c.env.DB) : null,
        sessionNamespace: c.env.SessionDO,
        queueEntries: requestedRosterEntries,
      }) ?? nextLobby
    }
    catch (error) {
      if (deferredTransferSource) {
        const restoredAdmission = await restoreDeferredOpenLobbyTransferSourceAdmission(deferredTransferSource, {
          db: c.env.DB ? createCivupDb(c.env.DB) : null,
          sessionNamespace: c.env.SessionDO,
          queueEntries: deferredTransferSource.queueEntries,
        })
        if (!restoredAdmission.ok) return { error: restoredAdmission.error }
      }
      if (transferSource) {
        const restored = await restoreOpenLobbyTransferSource(kv, c.env, transferSource.lobby, transferSource.queueEntries, now)
        if (!restored.ok) return { error: restored.error }
      }
      if (isSessionAdmissionError(error)) return { error: formatSessionAdmissionError(error) }
      if (isSessionVersionStaleError(error)) return { error: 'Lobby changed; please retry.' }
      throw error
    }
  }

  if (deferredTransferSource) {
    const finalized = await finalizeDeferredOpenLobbyTransferSource(kv, c.env.DISCORD_TOKEN, deferredTransferSource, {
      db: c.env.DB ? createCivupDb(c.env.DB) : null,
      sessionNamespace: c.env.SessionDO,
      queueEntries: deferredTransferSource.queueEntries,
      legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
    })
    if (!finalized.ok) {
      const rolledBack = await rollbackDeferredOpenLobbyTransferTarget(kv, deferredTransferSource, {
        lobby: targetLobbyBeforeTransfer,
        queueEntries: targetQueueEntriesBeforeTransfer,
        at: now,
      }, {
        db: c.env.DB ? createCivupDb(c.env.DB) : null,
        sessionNamespace: c.env.SessionDO,
        queueEntries: targetQueueEntriesBeforeTransfer,
        legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
      })
      if (!rolledBack.ok) return { error: `${finalized.error} Transfer rollback also failed: ${rolledBack.error}` }
      return { error: `${finalized.error} Transfer was rolled back; please try again.` }
    }
  }

  const finalQueueEntries = await getOpenLobbyRosterEntries(c.env.SessionDO, nextLobby, [...chosen.queueEntries, ...requestedRosterEntries])
  const finalSlots = normalizeLobbySlots(mode, nextLobby.slots, finalQueueEntries)
  await syncLobbyDerivedState(kv, nextLobby, {
    queueEntries: finalQueueEntries,
    slots: finalSlots,
    legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
  })

  const slottedEntries = mapLobbySlotsToEntries(finalSlots, finalQueueEntries)
  const renderPayload = await buildOpenLobbyRenderPayload(kv, nextLobby, slottedEntries, {
    reservedSlotLabels: await buildTournamentReservedSlotLabels(db, nextLobby),
  })
  return {
    stage: 'open',
    lobby: nextLobby,
    embeds: renderPayload.embeds,
    components: renderPayload.components,
  }
}

function isSessionVersionStaleError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Session version is stale')
}

async function restoreOpenLobbyTransferSource(
  kv: KVNamespace,
  env: { DB?: D1Database, SessionDO?: DurableObjectNamespace, ALLOWED_DISCORD_GUILD_ID?: string },
  sourceLobby: LobbyState,
  queueEntries: QueueEntry[],
  at: number,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const currentSource = await getLobbyById(kv, sourceLobby.id)
  if (!currentSource || currentSource.status !== 'open') {
    return { ok: false, error: 'Could not restore your previous lobby after the transfer failed. Please refresh and try again.' }
  }
  try {
    const restored = await setLobbyRoster(kv, sourceLobby.id, {
      memberPlayerIds: sourceLobby.memberPlayerIds,
      slots: sourceLobby.slots,
      lastActivityAt: Math.max(sourceLobby.lastActivityAt, at),
      now: Date.now(),
    }, currentSource, {
      db: env.DB ? createCivupDb(env.DB) : null,
      sessionNamespace: env.SessionDO,
      queueEntries,
    }) ?? currentSource
    await syncLobbyDerivedState(kv, restored, { queueEntries, legacyGuildId: env.ALLOWED_DISCORD_GUILD_ID })
    return { ok: true }
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Could not restore your previous lobby after the transfer failed: ${detail}` }
  }
}

async function getOpenLobbyRosterEntries(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  fallbackEntries: QueueEntry[] = [],
): Promise<QueueEntry[]> {
  const record = await getSessionRecord(namespace, lobby.id).catch(() => null)
  return record ? buildSessionRosterQueueEntries(record) : filterQueueEntriesForLobby(lobby, fallbackEntries)
}

const DRAFT_COMPLETED_AT_SQL = sql<number | null>`json_extract(${matches.draftData}, '$.completedAt')`

export async function findBlockingDraftMatchIdsForPlayers(
  db: ReturnType<typeof createDb>,
  playerIds: string[],
): Promise<Map<string, string>> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return new Map()

  const rows = await db
    .select({
      playerId: matchParticipants.playerId,
      matchId: matchParticipants.matchId,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(
      inArray(matchParticipants.playerId, uniquePlayerIds),
      or(
        eq(matches.status, 'drafting'),
        and(
          eq(matches.status, 'active'),
          sql`${DRAFT_COMPLETED_AT_SQL} is null`,
        ),
      ),
    ))
    .orderBy(desc(matches.createdAt))

  const blockingMatchIdByPlayerId = new Map<string, string>()
  for (const row of rows) {
    if (!blockingMatchIdByPlayerId.has(row.playerId)) {
      blockingMatchIdByPlayerId.set(row.playerId, row.matchId)
    }
  }
  return blockingMatchIdByPlayerId
}

export async function findReportableMatchIdsForPlayers(
  db: ReturnType<typeof createDb>,
  playerIds: string[],
): Promise<Map<string, string[]>> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return new Map()

  const rows = await db
    .select({
      playerId: matchParticipants.playerId,
      matchId: matchParticipants.matchId,
    })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(
      inArray(matchParticipants.playerId, uniquePlayerIds),
      eq(matches.status, 'active'),
      sql`${DRAFT_COMPLETED_AT_SQL} is not null`,
    ))
    .orderBy(desc(matches.createdAt))

  const reportableMatchIdsByPlayerId = new Map<string, string[]>()
  for (const row of rows) {
    const existing = reportableMatchIdsByPlayerId.get(row.playerId)
    if (existing) {
      existing.push(row.matchId)
      continue
    }

    reportableMatchIdsByPlayerId.set(row.playerId, [row.matchId])
  }

  return reportableMatchIdsByPlayerId
}

export async function resolveReportableMatchIdForPlayer(
  db: ReturnType<typeof createDb>,
  playerId: string,
  requestedMatchId?: string | null,
): Promise<{ matchId: string | null, error: string | null }> {
  const matchId = requestedMatchId?.trim() ?? null
  if (matchId) return { matchId, error: null }

  const reportableMatchIds = (await findReportableMatchIdsForPlayers(db, [playerId])).get(playerId) ?? []
  if (reportableMatchIds.length > 1) {
    return {
      matchId: null,
      error: 'You have multiple draft-complete matches to report. Pass `match_id` to pick the right one.',
    }
  }

  if (reportableMatchIds.length === 0) {
    return {
      matchId: null,
      error: 'Could not find a draft-complete match for you. You can pass `match_id` explicitly.',
    }
  }

  return { matchId: reportableMatchIds[0] ?? null, error: null }
}

export async function preflightMatchCreateSessionState(
  db: ReturnType<typeof createDb>,
  playerId: string,
): Promise<
  | { kind: 'continue' }
  | { kind: 'reuse-hosted-open-lobby', lobby: LobbyState }
  | { kind: 'block-open-lobby', lobby: LobbyState }
> {
  const [hostedOpenLobby, currentOpenLobby] = await Promise.all([
    getOpenSessionLobbyProjectionHostedBy(db, playerId),
    getOpenSessionLobbyProjectionForPlayer(db, playerId),
  ])
  if (hostedOpenLobby?.status === 'open') return { kind: 'reuse-hosted-open-lobby', lobby: hostedOpenLobby }
  if (!currentOpenLobby) return { kind: 'continue' }
  return {
    kind: currentOpenLobby.hostId === playerId ? 'reuse-hosted-open-lobby' : 'block-open-lobby',
    lobby: currentOpenLobby,
  }
}

async function getRoleGateErrorForLobby(
  db: ReturnType<typeof createDb>,
  kv: KVNamespace,
  lobby: LobbyState,
  requestedEntries: MatchJoinEntry[],
  primaryGuildId: string,
): Promise<string | null> {
  if (!lobby.minRole && !lobby.maxRole) return null
  if (!lobby.guildId) return 'This lobby is missing guild context, so rank gating is unavailable.'
  const playerIds = requestedEntries
    .map(entry => entry.playerId)
    .filter(playerId => !lobby.memberPlayerIds.includes(playerId))
  return getCalculatedRankGateError(db, kv, createStatsContext(lobby.guildId, primaryGuildId), lobby, playerIds)
}

export function collectFfaPlacementUserIds(vars: Record<string, any>): string[] {
  const ordered: string[] = []
  if (vars.winner) ordered.push(vars.winner)
  for (const key of FFA_PLACEMENT_KEYS) {
    const userId = vars[key as FfaPlacementKey]
    if (!userId) continue
    ordered.push(userId)
  }
  return ordered
}

function placeRequestedEntries(
  mode: GameMode,
  slots: (string | null)[],
  requestedEntries: MatchJoinEntry[],
): { slots: (string | null)[] } | { error: string } {
  const nextSlots = [...slots]
  const requestedPlayerIds = requestedEntries.map(entry => entry.playerId)
  const unslottedPlayerIds = requestedPlayerIds.filter(playerId => !nextSlots.includes(playerId))

  if (unslottedPlayerIds.length === 0) return { slots: nextSlots }

  if (!isTeamMode(mode)) {
    for (const playerId of unslottedPlayerIds) {
      const emptySlot = nextSlots.findIndex(slot => slot == null)
      if (emptySlot < 0) break
      nextSlots[emptySlot] = playerId
    }
    return { slots: nextSlots }
  }

  for (const playerId of unslottedPlayerIds) {
    const emptySlot = nextSlots.findIndex(slot => slot == null)
    if (emptySlot < 0) break
    nextSlots[emptySlot] = playerId
  }

  return { slots: nextSlots }
}

function scoreLobbyCandidate(
  lobby: LobbyState,
  currentSlots: (string | null)[],
  nextSlots: (string | null)[],
  joinedCount: number,
): string {
  const filledBefore = currentSlots.filter(slot => slot != null).length
  const filledAfter = nextSlots.filter(slot => slot != null).length
  const completionAfter = lobby.slots.length - filledAfter
  const fillGain = filledAfter - filledBefore
  const gapPenalty = countOpenGapPenalty(nextSlots)

  return [
    padNumber(completionAfter, 2),
    padNumber(-fillGain, 2),
    padNumber(gapPenalty, 2),
    padNumber(-joinedCount, 2),
    padNumber(lobby.createdAt, 14),
    lobby.id,
  ].join(':')
}

function countOpenGapPenalty(slots: (string | null)[]): number {
  let penalty = 0
  for (let index = 0; index < slots.length - 1; index++) {
    if (slots[index] == null && slots[index + 1] != null) penalty += 1
  }
  return penalty
}

function padNumber(value: number, width: number): string {
  const offset = 10 ** Math.max(width - 1, 1)
  return String(value + offset).padStart(width, '0')
}
