import type { LobbyState } from '../../src/services/lobby/index.ts'
import type { TournamentStage } from '../../src/services/tournament/index.ts'
import { describe, expect, test } from 'bun:test'
import { matchCivStatContributions, matchParticipants, matches, playerRatingEvents, playerRatings, tournamentCutPairings, tournamentMatches, tournaments } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { eq } from 'drizzle-orm'
import { backfillCivLeaderboardStatsFromHistory } from '../../src/services/leaderboard/civ-snapshot.ts'
import { cancelMatchByModerator, recalculateGlobalRatings, recalculateLeaderboardMode, reportMatch, resolveMatchByModerator } from '../../src/services/match/index.ts'
import {
  buildTournamentLobbySnapshot,
  buildTournamentLeaderboardImageData,
  buildTournamentOpponentCardData,
  buildTournamentReservedSlotLabels,
  buildTournamentResultImageData,
  buildTournamentStandings,
  createTournament,
  createTournamentCut,
  createTournamentMatchLink,
  importTournamentPlayersCsv,
  markTournamentMatchDrafting,
  resolveTournamentOpenLobbyTarget,
  syncTournamentMatchAfterCancel,
  syncTournamentMatchAfterReport,
  validateTournamentLobbyJoin,
} from '../../src/services/tournament/index.ts'
import { renderTournamentLeaderboardPng, renderTournamentOpponentsPng, renderTournamentResultPng } from '../../src/services/tournament/image.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const PLAYER_1 = '1000000000000001'
const PLAYER_2 = '1000000000000002'
const PLAYER_3 = '1000000000000003'
const PLAYER_4 = '1000000000000004'
const PLAYER_5 = '1000000000000005'
const PLAYER_6 = '1000000000000006'
const PLAYER_7 = '1000000000000007'
const PLAYER_8 = '1000000000000008'

describe('tournament service', () => {
  test('imports tournament players from CSV and links Discord IDs', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Test Cup', createdById: 'admin' })
      const result = await importTournamentPlayersCsv(db, tournament.id, [
        'seed,display_name,confirmed,discord_user_id',
        `1,Alice,true,${PLAYER_1}`,
        '2,Bob,true,',
        `3,Carol,false,${PLAYER_3}`,
      ].join('\n'))

      expect(result).toEqual({ imported: 3, linked: 2, pending: 1, duplicateDisplayNames: [] })
      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings.map(row => ({ name: row.displayName, playerId: row.playerId, seed: row.seed }))).toEqual([
        { name: 'Alice', playerId: PLAYER_1, seed: 1 },
        { name: 'Bob', playerId: null, seed: 2 },
      ])
    }
    finally {
      sqlite.close()
    }
  })

  test('syncs reported matches into standings', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Test Cup', createdById: 'admin', minGames: 1 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'session-1', hostId: PLAYER_1 })
      await markTournamentMatchDrafting(db, 'session-1', 'match-1')
      await insertReportedMatch(db, 'match-1', [
        [PLAYER_1, 1],
        [PLAYER_2, 2],
      ])

      await syncTournamentMatchAfterReport(db, 'match-1')

      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings.map(row => ({ name: row.displayName, games: row.games, wins: row.wins, losses: row.losses, eligible: row.eligible }))).toEqual([
        { name: 'Alice', games: 1, wins: 1, losses: 0, eligible: true },
        { name: 'Bob', games: 1, wins: 0, losses: 1, eligible: true },
      ])
    }
    finally {
      sqlite.close()
    }
  })

  test('reports tournament matches without normal rating or civ leaderboard effects', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      const tournament = await createTournament(db, { name: 'No Elo Cup', createdById: 'admin', minGames: 1 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'tournament-report', hostId: PLAYER_1 })
      await insertActiveMatch(db, 'tournament-report')

      const result = await reportMatch(db, kv, {
        matchId: 'tournament-report',
        reporterId: PLAYER_1,
        placements: `<@${PLAYER_1}>`,
      }, { allowDirectTerminalWriteForTests: true })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('completed')
      expect(result.participants.every(participant => participant.ratingBeforeMu == null && participant.ratingAfterMu == null)).toBe(true)

      const [link] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, 'tournament-report'))
      expect(link?.status).toBe('reported')
      expect(link?.winnerId).toBe(PLAYER_1)

      expect(await db.select().from(playerRatings)).toHaveLength(0)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
      expect(await db.select().from(matchCivStatContributions)).toHaveLength(0)

      expect(await recalculateLeaderboardMode(db, 'duel')).toEqual({ matchIds: [] })
      expect(await recalculateGlobalRatings(db)).toEqual({ matchIds: [] })
      expect(await db.select().from(playerRatings)).toHaveLength(0)
      expect((await backfillCivLeaderboardStatsFromHistory(db)).snapshot.completedMatchCount).toBe(0)
      expect(await db.select().from(matchCivStatContributions)).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('moderator resolve and cancel keep tournament matches unrated', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      const tournament = await createTournament(db, { name: 'Mod Cup', createdById: 'admin', minGames: 1 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'tournament-mod', hostId: PLAYER_1 })
      await insertActiveMatch(db, 'tournament-mod')

      const reported = await reportMatch(db, kv, {
        matchId: 'tournament-mod',
        reporterId: PLAYER_1,
        placements: `<@${PLAYER_1}>`,
      }, { allowDirectTerminalWriteForTests: true })
      expect('error' in reported).toBe(false)
      if ('error' in reported) return

      const resolved = await resolveMatchByModerator(db, kv, {
        matchId: 'tournament-mod',
        placements: `<@${PLAYER_2}>`,
        resolvedAt: Date.now(),
      }, { allowDirectTerminalWriteForTests: true })
      expect('error' in resolved).toBe(false)
      if ('error' in resolved) return
      expect(resolved.recalculatedMatchIds).toEqual([])

      let [link] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, 'tournament-mod'))
      expect(link?.status).toBe('reported')
      expect(link?.winnerId).toBe(PLAYER_2)
      expect(await db.select().from(playerRatings)).toHaveLength(0)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)

      const cancelled = await cancelMatchByModerator(db, kv, {
        matchId: 'tournament-mod',
        cancelledAt: Date.now(),
      }, { allowDirectTerminalWriteForTests: true })
      expect('error' in cancelled).toBe(false)
      if ('error' in cancelled) return
      expect(cancelled.recalculatedMatchIds).toEqual([])

      const [cancelledLink] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, 'tournament-mod'))
      expect(cancelledLink?.status).toBe('cancelled')
      expect(cancelledLink?.winnerId).toBeNull()
      expect(await db.select().from(playerRatings)).toHaveLength(0)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
      expect(await db.select().from(matchCivStatContributions)).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('enforces block rematch policy and exposes warn rematch snapshots', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const blockedTournament = await createTournament(db, { name: 'Block Cup', createdById: 'admin', rematchPolicy: 'block' })
      await importTournamentPlayersCsv(db, blockedTournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await createTournamentMatchLink(db, { tournamentId: blockedTournament.id, sessionId: 'old-block-session', hostId: PLAYER_1 })
      await markTournamentMatchDrafting(db, 'old-block-session', 'old-block-match')
      await insertReportedMatch(db, 'old-block-match', [
        [PLAYER_1, 1],
        [PLAYER_2, 2],
      ])
      await syncTournamentMatchAfterReport(db, 'old-block-match')
      await createTournamentMatchLink(db, { tournamentId: blockedTournament.id, sessionId: 'new-block-session', hostId: PLAYER_1 })

      const blocked = await validateTournamentLobbyJoin(db, buildLobby('new-block-session', [PLAYER_1, null]), {
        userId: PLAYER_2,
        displayName: 'Bob',
        avatarUrl: null,
      })
      expect(blocked).toEqual({ ok: false, error: 'You already played this opponent in the tournament.' })

      await db.update(tournaments).set({ status: 'completed' }).where(eq(tournaments.id, blockedTournament.id))
      const warnTournament = await createTournament(db, { name: 'Warn Cup', createdById: 'admin', rematchPolicy: 'warn' })
      await importTournamentPlayersCsv(db, warnTournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await createTournamentMatchLink(db, { tournamentId: warnTournament.id, sessionId: 'old-warn-session', hostId: PLAYER_1 })
      await markTournamentMatchDrafting(db, 'old-warn-session', 'old-warn-match')
      await insertReportedMatch(db, 'old-warn-match', [
        [PLAYER_1, 1],
        [PLAYER_2, 2],
      ])
      await syncTournamentMatchAfterReport(db, 'old-warn-match')
      await createTournamentMatchLink(db, { tournamentId: warnTournament.id, sessionId: 'new-warn-session', hostId: PLAYER_1 })

      const allowed = await validateTournamentLobbyJoin(db, buildLobby('new-warn-session', [PLAYER_1, null]), {
        userId: PLAYER_2,
        displayName: 'Bob',
        avatarUrl: null,
      })
      expect(allowed).toEqual({ ok: true })

      const snapshot = await buildTournamentLobbySnapshot(db, 'new-warn-session', [PLAYER_1, PLAYER_2])
      expect(snapshot?.rematchPolicy).toBe('warn')
      expect(snapshot?.rematchWarning).toContain('already played')
    }
    finally {
      sqlite.close()
    }
  })

  test('creates top cut pairings from eligible standings', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Cut Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await reportTournamentMatch(db, tournament.id, 'session-1', 'match-1', [
        [PLAYER_1, 1],
        [PLAYER_4, 2],
      ])
      await reportTournamentMatch(db, tournament.id, 'session-2', 'match-2', [
        [PLAYER_2, 1],
        [PLAYER_3, 2],
      ])

      const result = await createTournamentCut(db, tournament.id)
      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.round).toBe('semifinal')
      expect(result.pairings.map(pairing => [pairing.seedOne, pairing.playerOneDisplayName, pairing.seedTwo, pairing.playerTwoDisplayName])).toEqual([
        [1, 'Alice', 4, 'Dave'],
        [2, 'Bob', 3, 'Carol'],
      ])

      const storedPairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(storedPairings).toHaveLength(2)
      const [updatedTournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournament.id))
      expect(updatedTournament?.status).toBe('top_cut')
    }
    finally {
      sqlite.close()
    }
  })

  test('targets top-cut lobbies and reserves paired opponent labels', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Target Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await reportTournamentMatch(db, tournament.id, 'target-session-1', 'target-match-1', [
        [PLAYER_1, 1],
        [PLAYER_4, 2],
      ])
      await reportTournamentMatch(db, tournament.id, 'target-session-2', 'target-match-2', [
        [PLAYER_2, 1],
        [PLAYER_3, 2],
      ])
      await createTournamentCut(db, tournament.id)

      const target = await resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_4, displayName: 'Dave', avatarUrl: null })
      expect('error' in target).toBe(false)
      if ('error' in target) return
      expect(target.stage).toBe('semifinal')
      expect(target.playerOneId).toBe(PLAYER_1)
      expect(target.playerTwoId).toBe(PLAYER_4)
      expect(target.opponentId).toBe(PLAYER_1)
      expect(target.opponentDisplayName).toBe('Alice')
      expect(target.existingSessionId).toBeNull()

      await createTournamentMatchLink(db, {
        tournamentId: target.tournamentId,
        sessionId: 'cut-session-1',
        hostId: PLAYER_4,
        stage: target.stage,
        cutPairingId: target.cutPairingId,
        playerOneId: target.playerOneId,
        playerTwoId: target.playerTwoId,
      })

      const labels = await buildTournamentReservedSlotLabels(db, buildLobby('cut-session-1', [PLAYER_4, null]))
      expect(labels).toEqual([null, 'Alice'])

      const pairedJoin = await validateTournamentLobbyJoin(db, buildLobby('cut-session-1', [PLAYER_4, null]), {
        userId: PLAYER_1,
        displayName: 'Alice',
        avatarUrl: null,
      })
      expect(pairedJoin).toEqual({ ok: true })

      const unpairedJoin = await validateTournamentLobbyJoin(db, buildLobby('cut-session-1', [PLAYER_4, null]), {
        userId: PLAYER_2,
        displayName: 'Bob',
        avatarUrl: null,
      })
      expect(unpairedJoin).toEqual({ ok: false, error: 'This top-cut lobby is reserved for its paired players.' })

      const existingTarget = await resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_1, displayName: 'Alice', avatarUrl: null })
      expect('error' in existingTarget).toBe(false)
      if ('error' in existingTarget) return
      expect(existingTarget.existingSessionId).toBe('cut-session-1')

      const [pairing] = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.id, target.cutPairingId!))
      expect(pairing?.status).toBe('open')
      expect(pairing?.sessionId).toBe('cut-session-1')
    }
    finally {
      sqlite.close()
    }
  })

  test('advances quarterfinal winners using bracket seed order', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Quarter Cup', createdById: 'admin', minGames: 1, topCut: 8 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
        ['5', 'Eve', PLAYER_5],
        ['6', 'Frank', PLAYER_6],
        ['7', 'Grace', PLAYER_7],
        ['8', 'Heidi', PLAYER_8],
      ]))
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-1', 'quarter-qualifier-match-1', [[PLAYER_1, 1], [PLAYER_8, 2]])
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-2', 'quarter-qualifier-match-2', [[PLAYER_2, 1], [PLAYER_7, 2]])
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-3', 'quarter-qualifier-match-3', [[PLAYER_3, 1], [PLAYER_6, 2]])
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-4', 'quarter-qualifier-match-4', [[PLAYER_4, 1], [PLAYER_5, 2]])
      await createTournamentCut(db, tournament.id)

      const quarterfinals = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 1, 8), 'quarter-session-1', 'quarter-match-1', PLAYER_1)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 4, 5), 'quarter-session-2', 'quarter-match-2', PLAYER_4)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 2, 7), 'quarter-session-3', 'quarter-match-3', PLAYER_2)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 3, 6), 'quarter-session-4', 'quarter-match-4', PLAYER_3)

      const semifinals = (await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id)))
        .filter(pairing => pairing.round === 'semifinal')
        .sort((left, right) => left.seedOne - right.seedOne)
      expect(semifinals.map(pairing => [pairing.seedOne, pairing.playerOneId, pairing.seedTwo, pairing.playerTwoId])).toEqual([
        [1, PLAYER_1, 4, PLAYER_4],
        [2, PLAYER_2, 3, PLAYER_3],
      ])
    }
    finally {
      sqlite.close()
    }
  })

  test('advances top-cut winners into the final and completes the tournament', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Advance Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await reportTournamentMatch(db, tournament.id, 'advance-qualifier-1', 'advance-qualifier-match-1', [
        [PLAYER_1, 1],
        [PLAYER_4, 2],
      ])
      await reportTournamentMatch(db, tournament.id, 'advance-qualifier-2', 'advance-qualifier-match-2', [
        [PLAYER_2, 1],
        [PLAYER_3, 2],
      ])
      await createTournamentCut(db, tournament.id)

      let pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      const semifinals = pairings.filter(pairing => pairing.round === 'semifinal').sort((left, right) => left.seedOne - right.seedOne)
      expect(semifinals).toHaveLength(2)

      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'advance-semi-session-1', 'advance-semi-match-1', PLAYER_1)
      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(0)

      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'advance-semi-session-2', 'advance-semi-match-2', PLAYER_3)
      await syncTournamentMatchAfterReport(db, 'advance-semi-match-2')
      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      let finals = pairings.filter(pairing => pairing.round === 'final')
      expect(finals).toHaveLength(1)
      expect(finals[0]?.status).toBe('scheduled')
      expect(finals[0]?.seedOne).toBe(1)
      expect(finals[0]?.playerOneId).toBe(PLAYER_1)
      expect(finals[0]?.seedTwo).toBe(3)
      expect(finals[0]?.playerTwoId).toBe(PLAYER_3)

      const finalTarget = await resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_3, displayName: 'Carol', avatarUrl: null })
      expect('error' in finalTarget).toBe(false)
      if ('error' in finalTarget) return
      expect(finalTarget.stage).toBe('final')
      expect(finalTarget.opponentId).toBe(PLAYER_1)
      expect(finalTarget.opponentDisplayName).toBe('Alice')

      await reportTopCutPairing(db, tournament.id, finals[0]!, 'advance-final-session', 'advance-final-match', PLAYER_3)
      const [completedTournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournament.id))
      expect(completedTournament?.status).toBe('completed')

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      finals = pairings.filter(pairing => pairing.round === 'final')
      expect(finals).toHaveLength(1)
      expect(finals[0]?.status).toBe('reported')
      expect(finals[0]?.winnerId).toBe(PLAYER_3)
    }
    finally {
      sqlite.close()
    }
  })

  test('resets a cancelled top-cut pairing before the downstream lobby starts', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Reset Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await reportTournamentMatch(db, tournament.id, 'reset-qualifier-1', 'reset-qualifier-match-1', [[PLAYER_1, 1], [PLAYER_4, 2]])
      await reportTournamentMatch(db, tournament.id, 'reset-qualifier-2', 'reset-qualifier-match-2', [[PLAYER_2, 1], [PLAYER_3, 2]])
      await createTournamentCut(db, tournament.id)

      let pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      const semifinals = pairings.filter(pairing => pairing.round === 'semifinal').sort((left, right) => left.seedOne - right.seedOne)
      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'reset-semi-session-1', 'reset-semi-match-1', PLAYER_1)
      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'reset-semi-session-2', 'reset-semi-match-2', PLAYER_3)

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(1)

      await syncTournamentMatchAfterCancel(db, 'reset-semi-match-2')

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(0)
      const resetPairing = pairings.find(pairing => pairing.id === semifinals[1]!.id)
      expect(resetPairing?.status).toBe('scheduled')
      expect(resetPairing?.sessionId).toBeNull()
      expect(resetPairing?.matchId).toBeNull()
      expect(resetPairing?.winnerId).toBeNull()

      const target = await resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_2, displayName: 'Bob', avatarUrl: null })
      expect('error' in target).toBe(false)
      if ('error' in target) return
      expect(target.stage).toBe('semifinal')
      expect(target.existingSessionId).toBeNull()
      expect(target.opponentId).toBe(PLAYER_3)
    }
    finally {
      sqlite.close()
    }
  })

  test('builds top-cut opponent card data and renders a PNG', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Card Cup', createdById: 'admin', minGames: 1, topCut: 2 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await reportTournamentMatch(db, tournament.id, 'card-session-1', 'card-match-1', [
        [PLAYER_1, 1],
        [PLAYER_2, 2],
      ])
      await createTournamentCut(db, tournament.id)

      const data = await buildTournamentOpponentCardData(db, { userId: PLAYER_1, displayName: 'Alice', avatarUrl: null })
      expect('error' in data).toBe(false)
      if ('error' in data) return
      expect(data.pairing?.round).toBe('final')
      expect(data.pairing?.playerOne.displayName).toBe('Alice')
      expect(data.pairing?.playerTwo.displayName).toBe('Bob')
      expect(data.opponents).toEqual([])

      const png = await renderTournamentOpponentsPng(data)
      expect(png.length).toBeGreaterThan(1024)
      expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

      const leaderboardData = await buildTournamentLeaderboardImageData(db, tournament.id)
      expect(leaderboardData).not.toBeNull()
      if (!leaderboardData) return
      const leaderboardPng = await renderTournamentLeaderboardPng(leaderboardData)
      expect(Array.from(leaderboardPng.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

      const resultData = await buildTournamentResultImageData(db, 'card-match-1', [
        { matchId: 'card-match-1', playerId: PLAYER_1, team: null, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'card-match-1', playerId: PLAYER_2, team: null, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])
      expect(resultData).not.toBeNull()
      if (!resultData) return
      const resultPng = await renderTournamentResultPng(resultData)
      expect(Array.from(resultPng.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
    finally {
      sqlite.close()
    }
  })
})

function playersCsv(rows: [seed: string, displayName: string, playerId: string][]): string {
  return [
    'seed,display_name,confirmed,discord_user_id',
    ...rows.map(row => `${row[0]},${row[1]},true,${row[2]}`),
  ].join('\n')
}

async function reportTournamentMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  tournamentId: string,
  sessionId: string,
  matchId: string,
  participants: [playerId: string, placement: number][],
) {
  await createTournamentMatchLink(db, { tournamentId, sessionId, hostId: participants[0]![0] })
  await markTournamentMatchDrafting(db, sessionId, matchId)
  await insertReportedMatch(db, matchId, participants)
  await syncTournamentMatchAfterReport(db, matchId)
}

async function reportTopCutPairing(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  tournamentId: string,
  pairing: typeof tournamentCutPairings.$inferSelect,
  sessionId: string,
  matchId: string,
  winnerId: string,
) {
  if (!pairing.playerOneId || !pairing.playerTwoId) throw new Error('Top-cut pairing is missing players')
  const loserId = pairing.playerOneId === winnerId ? pairing.playerTwoId : pairing.playerOneId
  await createTournamentMatchLink(db, {
    tournamentId,
    sessionId,
    hostId: winnerId,
    stage: pairing.round as TournamentStage,
    cutPairingId: pairing.id,
    playerOneId: pairing.playerOneId,
    playerTwoId: pairing.playerTwoId,
  })
  await markTournamentMatchDrafting(db, sessionId, matchId)
  await insertReportedMatch(db, matchId, [
    [winnerId, 1],
    [loserId, 2],
  ])
  await syncTournamentMatchAfterReport(db, matchId)
}

function findPairing(pairings: Array<typeof tournamentCutPairings.$inferSelect>, seedOne: number, seedTwo: number): typeof tournamentCutPairings.$inferSelect {
  const pairing = pairings.find(pairing => pairing.seedOne === seedOne && pairing.seedTwo === seedTwo)
  if (!pairing) throw new Error(`Missing pairing #${seedOne} vs #${seedTwo}`)
  return pairing
}

async function insertReportedMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  participants: [playerId: string, placement: number][],
) {
  await db.insert(matches).values({
    id: matchId,
    gameMode: '1v1',
    status: 'completed',
    isOld: false,
    seasonId: null,
    draftData: null,
    createdAt: Date.now(),
    completedAt: Date.now(),
  })
  await db.insert(matchParticipants).values(participants.map(([playerId, placement]) => ({
    matchId,
    playerId,
    team: null,
    civId: null,
    placement,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  })))
}

async function insertActiveMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
) {
  await db.insert(matches).values({
    id: matchId,
    gameMode: '1v1',
    status: 'active',
    isOld: false,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: Date.now() }),
    createdAt: Date.now(),
    completedAt: null,
  })
  await db.insert(matchParticipants).values([
    {
      matchId,
      playerId: PLAYER_1,
      team: 0,
      civId: allLeaderIds[0]!,
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    },
    {
      matchId,
      playerId: PLAYER_2,
      team: 1,
      civId: allLeaderIds[1]!,
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    },
  ])
}

function buildLobby(id: string, slots: (string | null)[]): LobbyState {
  const now = Date.now()
  const memberPlayerIds = slots.filter((slot): slot is string => slot != null)
  return {
    id,
    mode: '1v1',
    status: 'open',
    guildId: 'guild',
    hostId: memberPlayerIds[0] ?? 'host',
    channelId: 'channel',
    messageId: 'message',
    matchId: null,
    steamLobbyLink: null,
    minRole: null,
    maxRole: null,
    lastArrange: null,
    lastActivityAt: now,
    memberPlayerIds,
    slots,
    draftConfig: {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      mapVoteEnabled: false,
      blindBans: true,
      simultaneousPick: false,
      permanentAlly: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      hiddenDraft: false,
      duplicateFactions: false,
    },
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
}
