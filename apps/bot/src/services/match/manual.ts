import type { Database } from '@civup/db'
import type { DraftState, GameMode } from '@civup/game'
import type { CreateManualReportedMatchInput, CreateManualReportedMatchResult, ManualReportedMatchPlayerInput } from './types.ts'
import { matches, matchParticipants, players } from '@civup/db'
import { getLeaders, maxPlayerCount, playerCountOptions, slotToTeamIndex, startPlayerCountOptions, toLeaderboardMode } from '@civup/game'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { reconcileCivLeaderboardMatchContribution } from '../leaderboard/civ-snapshot.ts'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'
import { getActiveSeason } from '../season/index.ts'
import { splitValuesForD1InsertLimit } from './draft.ts'
import { recalculateGlobalRatings, recalculateLeaderboardMode } from './ratings.ts'

const MANUAL_MATCH_ID_LENGTH = 10
const MATCH_PARTICIPANT_INSERT_COLUMN_COUNT = 9
const LIVE_LEADER_IDS = new Set(getLeaders('live').map(leader => leader.id))

interface CreateManualReportedMatchOptions {
  rankedRoleGuildId?: string | null
}

export async function createManualReportedMatch(
  db: Database,
  kv: KVNamespace,
  input: CreateManualReportedMatchInput,
  options: CreateManualReportedMatchOptions = {},
): Promise<CreateManualReportedMatchResult> {
  const validationError = validateManualReportedMatchInput(input)
  if (validationError) return { error: validationError }

  const matchId = input.matchId ?? await createUniqueManualMatchId(db)
  const [existingMatch] = await db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).limit(1)
  if (existingMatch) return { error: `Match **${matchId}** already exists.` }

  const activeSeason = await getActiveSeason(db)
  const playerCount = input.players.length
  const permanentAlly = input.mode === 'ffa' && input.permanentAlly === true
  const draftData = buildManualReportedDraftData(matchId, input.mode, input.players, input.reporterId, input.reportedAt, permanentAlly)
  const participantRows = input.players.map((player, index) => {
    const team = resolveManualReportTeam(input.mode, index, playerCount)
    return {
      matchId,
      playerId: player.playerId,
      team,
      civId: player.civId,
      placement: input.mode === 'ffa' ? resolveManualFfaPlacement(index, permanentAlly) : (team ?? 0) + 1,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    }
  })

  try {
    for (const player of input.players) {
      await db.insert(players)
        .values({
          id: player.playerId,
          displayName: player.displayName,
          avatarUrl: player.avatarUrl ?? null,
          createdAt: input.reportedAt,
        })
        .onConflictDoUpdate({
          target: players.id,
          set: {
            displayName: player.displayName,
            avatarUrl: player.avatarUrl ?? null,
          },
        })
    }

    await db.insert(matches).values({
      id: matchId,
      gameMode: input.mode,
      status: 'completed',
      isOld: false,
      seasonId: activeSeason?.id ?? null,
      draftData,
      createdAt: input.reportedAt,
      completedAt: input.reportedAt,
    })

    for (const chunk of splitValuesForD1InsertLimit(participantRows, MATCH_PARTICIPANT_INSERT_COLUMN_COUNT)) {
      await db.insert(matchParticipants).values(chunk)
    }

    let recalculatedMatchIds: string[] = []
    const leaderboardMode = toLeaderboardMode(input.mode, { redDeath: false })
    if (leaderboardMode) {
      const recalculated = await recalculateLeaderboardMode(db, leaderboardMode, {
        fromMatchId: matchId,
        includeFromMatch: true,
      })
      if ('error' in recalculated) {
        await rollbackManualReportedMatch(db, matchId)
        return recalculated
      }
      const recalculatedGlobal = await recalculateGlobalRatings(db, {
        fromMatchId: matchId,
        includeFromMatch: true,
        opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
      })
      if ('error' in recalculatedGlobal) {
        await rollbackManualReportedMatch(db, matchId)
        return recalculatedGlobal
      }
      recalculatedMatchIds = recalculated.matchIds
    }

    await reconcileCivLeaderboardMatchContribution(db, matchId)

    const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
    const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
    if (!match) return { error: `Manual match **${matchId}** was not found after creation.` }

    return {
      match,
      participants,
      previousStatus: 'manual',
      recalculatedMatchIds,
    }
  }
  catch (error) {
    await rollbackManualReportedMatch(db, matchId).catch((rollbackError) => {
      console.error(`Failed to roll back manual match ${matchId}:`, rollbackError)
    })
    throw error
  }
}

function validateManualReportedMatchInput(input: CreateManualReportedMatchInput): string | null {
  const permanentAlly = input.mode === 'ffa' && input.permanentAlly === true
  const allowedCounts = input.mode === 'ffa'
    ? startPlayerCountOptions(input.mode, maxPlayerCount(input.mode), { permanentAlly })
    : playerCountOptions(input.mode)
  if (!allowedCounts.includes(input.players.length)) {
    return `${input.mode} manual reports require ${formatAllowedCounts(allowedCounts)} players.`
  }

  const playerIds = new Set<string>()
  const civIds = new Set<string>()
  for (const player of input.players) {
    if (!player.playerId.trim()) return 'Manual reports require every player slot to have a player.'
    if (!player.displayName.trim()) return `Manual report player **${player.playerId}** is missing a display name.`
    if (!LIVE_LEADER_IDS.has(player.civId)) return `Unknown leader: **${player.civId}**.`
    if (playerIds.has(player.playerId)) return `<@${player.playerId}> is listed more than once.`
    if (civIds.has(player.civId)) return `Leader **${player.civId}** is listed more than once.`
    playerIds.add(player.playerId)
    civIds.add(player.civId)
  }

  return null
}

async function createUniqueManualMatchId(db: Database): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const matchId = nanoid(MANUAL_MATCH_ID_LENGTH)
    const [existingMatch] = await db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).limit(1)
    if (!existingMatch) return matchId
  }
  throw new Error('Failed to allocate a manual match id.')
}

function buildManualReportedDraftData(
  matchId: string,
  mode: GameMode,
  players: ManualReportedMatchPlayerInput[],
  reporterId: string,
  reportedAt: number,
  permanentAlly: boolean,
): string {
  const playerCount = players.length
  const state: DraftState = {
    matchId,
    formatId: 'manual-report',
    seats: players.map((player, index) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl ?? null,
      team: resolveManualReportTeam(mode, index, playerCount) ?? undefined,
    })),
    steps: [],
    currentStepIndex: -1,
    submissions: {},
    bans: [],
    picks: players.map((player, index) => ({
      civId: player.civId,
      seatIndex: index,
      stepIndex: index,
    })),
    availableCivIds: [],
    duplicateFactions: false,
    status: 'complete',
    cancelReason: null,
    pendingBlindBans: [],
  }

  return JSON.stringify({
    manualReport: true,
    completedAt: reportedAt,
    hostId: players[0]?.playerId ?? reporterId,
    reportedById: reporterId,
    mapVoteResult: null,
    redDeath: false,
    permanentAlly,
    hiddenDraft: false,
    state,
  })
}

function resolveManualFfaPlacement(index: number, permanentAlly: boolean): number {
  return permanentAlly ? Math.floor(index / 2) + 1 : index + 1
}

function resolveManualReportTeam(mode: GameMode, slot: number, playerCount: number): number | null {
  return mode === 'ffa' ? null : slotToTeamIndex(mode, slot, playerCount)
}

async function rollbackManualReportedMatch(db: Database, matchId: string): Promise<void> {
  await db.delete(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  await db.delete(matches).where(eq(matches.id, matchId))
}

function formatAllowedCounts(counts: readonly number[]): string {
  if (counts.length === 1) return String(counts[0])
  return `${counts.slice(0, -1).join(', ')} or ${counts[counts.length - 1]}`
}

async function loadCurrentRankedRoleTierByPlayerId(kv: KVNamespace, guildId: string | null | undefined): Promise<Map<string, string>> {
  if (!guildId) return new Map()
  const assignments = await getCurrentRankAssignments(kv, guildId)
  return new Map(Object.entries(assignments.byPlayerId).map(([playerId, assignment]) => [playerId, assignment.tier]))
}
