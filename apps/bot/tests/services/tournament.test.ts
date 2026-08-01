import type { LobbyState } from '../../src/services/lobby/index.ts'
import type { TournamentStage } from '../../src/services/tournament/index.ts'
import { leaderboardMessageStates, matchCivStatContributions, matches, matchParticipants, playerRatingEvents, playerRatings, players, tournamentCutPairings, tournamentMatches, tournamentPlayers, tournaments } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { backfillCivLeaderboardStatsFromHistory } from '../../src/services/leaderboard/civ-snapshot.ts'
import { cancelMatchByModerator, recalculateGlobalRatings, recalculateLeaderboardMode, reportMatch, resolveMatchByModerator } from '../../src/services/match/index.ts'
import { renderTournamentLeaderboardPng, renderTournamentLeaderboardSvg, renderTournamentOpponentsPng, renderTournamentResultPng, renderTournamentResultSvg } from '../../src/services/tournament/image.ts'
import {
  buildTournamentLeaderboardImageData,
  buildTournamentLobbySnapshot,
  buildTournamentOpponentCardData,
  buildTournamentReservedSlotLabels,
  buildTournamentResultImageData,
  buildTournamentStandings,
  claimTournamentQualifierOpponentEntry,
  createTournament,
  createTournamentCut,
  createTournamentMatchLink,
  importTournamentPlayers,
  importTournamentPlayersCsv,
  leaveTournament,
  markTournamentMatchDrafting,
  resolveTournamentOpenLobbyTarget,
  refreshTournamentLeaderboard,
  startTournament,
  syncTournamentMatchAfterCancel,
  syncTournamentMatchAfterReport,
  validateTournamentLobbyJoin,
} from '../../src/services/tournament/index.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const PLAYER_1 = '1000000000000001'
const PLAYER_2 = '1000000000000002'
const PLAYER_3 = '1000000000000003'
const PLAYER_4 = '1000000000000004'
const PLAYER_5 = '1000000000000005'
const PLAYER_6 = '1000000000000006'
const PLAYER_7 = '1000000000000007'
const PLAYER_8 = '1000000000000008'
const originalFetch = globalThis.fetch

describe('tournament service', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('renders configured display name emoji as inline tournament icons', async () => {
    const leaderboardData = {
      tournamentName: 'Emoji Cup',
      status: 'qualifier',
      minGames: 1,
      standings: [
        {
          playerId: 'player-emoji',
          displayName: 'Sam 🎧',
          avatarUrl: null,
          seed: 1,
          games: 1,
          wins: 1,
          losses: 0,
          winRate: 1,
          eligible: true,
        },
        {
          playerId: 'player-long-name',
          displayName: 'VeryLongTournamentPlayerNameThatCannotFit',
          avatarUrl: null,
          seed: 2,
          games: 1,
          wins: 0,
          losses: 1,
          winRate: 0,
          eligible: true,
        },
      ],
      pairings: [],
      champion: null,
    } as const
    const svg = await renderTournamentLeaderboardSvg(leaderboardData)

    expect(svg).toContain('Emoji Cup')
    expect(svg).toContain('Sam ')
    expect(svg).toContain('Very')
    expect(svg).toContain('tournament-emoji-')
    expect(svg).not.toContain('Sam 🎧')
    expect(svg).not.toMatch(/>\.\.\.<\/text>/)

    expect((await renderTournamentLeaderboardPng(leaderboardData)).byteLength).toBeGreaterThan(0)

    const resultData = {
      tournamentName: 'Emoji Cup',
      stage: 'qualifier',
      matchLabel: 'Qualifier match',
      players: [
        { playerId: 'p1', displayName: '🐒Monkey Style🐒', avatarUrl: null, civId: null, placement: 1 },
        { playerId: 'p2', displayName: 'Sn0w🦦', avatarUrl: null, civId: null, placement: 2 },
      ],
    } as const
    const resultSvg = await renderTournamentResultSvg(resultData)
    expect(resultSvg).toContain('Monkey Style')
    expect(resultSvg).toContain('Sn0w')
    expect(resultSvg).not.toContain('🐒')
    expect(resultSvg).not.toContain('🦦')
    expect((await renderTournamentResultPng(resultData)).byteLength).toBeGreaterThan(0)
  })

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
      expect(tournament.status).toBe('setup')
    }
    finally {
      sqlite.close()
    }
  })

  test('imports resolved tournament member names and avatars', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Resolved Cup', createdById: 'admin' })
      const result = await importTournamentPlayers(db, tournament.id, [{
        seed: 1,
        displayName: 'Resolved Nick',
        confirmed: true,
        playerId: PLAYER_1,
        avatarUrl: 'https://cdn.discordapp.com/avatars/player/avatar.png?size=128',
      }])

      expect('error' in result).toBe(false)
      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings[0]?.displayName).toBe('Resolved Nick')

      const imageData = await buildTournamentLeaderboardImageData(db, tournament.id, standings, [])
      expect(imageData?.standings[0]?.displayName).toBe('Resolved Nick')
      expect(imageData?.standings[0]?.avatarUrl).toBe('https://cdn.discordapp.com/avatars/player/avatar.png?size=128')
    }
    finally {
      sqlite.close()
    }
  })

  test('rejects duplicate tournament CSV seeds and Discord IDs before replacing players', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Duplicate Cup', createdById: 'admin' })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))

      await expect(importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['1', 'Carol', PLAYER_3],
      ]))).resolves.toEqual({ error: 'Duplicate seeds: #1 (Alice, Carol)' })

      await expect(importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Alias Alice', PLAYER_1],
      ]))).resolves.toEqual({ error: `Duplicate Discord user IDs: ${PLAYER_1} (Alice, Alias Alice)` })

      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings.map(row => ({ name: row.displayName, playerId: row.playerId, seed: row.seed }))).toEqual([
        { name: 'Alice', playerId: PLAYER_1, seed: 1 },
        { name: 'Bob', playerId: PLAYER_2, seed: 2 },
      ])
    }
    finally {
      sqlite.close()
    }
  })

  test('imports large tournament player CSVs in D1-safe batches', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Large Cup', createdById: 'admin' })
      const rows = Array.from({ length: 60 }, (_value, index) => [
        String(index + 1),
        `Player ${index + 1}`,
        `100000000000${String(index + 1).padStart(4, '0')}`,
      ])

      const result = await importTournamentPlayersCsv(db, tournament.id, playersCsv(rows))

      expect(result).toEqual({ imported: 60, linked: 60, pending: 0, duplicateDisplayNames: [] })
      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings).toHaveLength(60)
      expect(standings[0]?.displayName).toBe('Player 1')
      expect(standings[59]?.displayName).toBe('Player 60')
    }
    finally {
      sqlite.close()
    }
  })

  test('preserves imported display names for linked tournament players', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Alias Cup', createdById: 'admin' })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Seeded Alias', PLAYER_1],
      ]))
      await startTournament(db, tournament.id)

      const data = await buildTournamentOpponentCardData(db, {
        userId: PLAYER_1,
        displayName: 'Discord Name',
        avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
      })

      expect('error' in data).toBe(false)
      if ('error' in data) return
      expect(data.player.displayName).toBe('Seeded Alias')
      expect(data.player.avatarUrl).toBe('https://cdn.discordapp.com/embed/avatars/0.png')

      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings[0]?.displayName).toBe('Seeded Alias')
    }
    finally {
      sqlite.close()
    }
  })

  test('builds tournament stats for another linked player without auto-linking pending entries', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Lookup Cup', createdById: 'admin' })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Pending Carol', ''],
      ]))
      await startTournament(db, tournament.id)

      const data = await buildTournamentOpponentCardData(db, { userId: PLAYER_2, displayName: 'Discord Bob', avatarUrl: null }, { autoLink: false })
      expect('error' in data).toBe(false)
      if ('error' in data) return
      expect(data.player.displayName).toBe('Bob')

      const pending = await buildTournamentOpponentCardData(db, { userId: PLAYER_3, displayName: 'Pending Carol', avatarUrl: null }, { autoLink: false })
      expect(pending).toEqual({ error: 'That player is not linked to an active tournament entry.' })
      const [pendingRow] = await db
        .select({ playerId: tournamentPlayers.playerId })
        .from(tournamentPlayers)
        .where(and(eq(tournamentPlayers.tournamentId, tournament.id), eq(tournamentPlayers.displayName, 'Pending Carol')))
        .limit(1)
      expect(pendingRow?.playerId).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('recommends qualifier opponents by closest record before standings rank', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Closest Cup', createdById: 'admin', minGames: 1 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Target', PLAYER_1],
        ['2', 'Four Zero', PLAYER_2],
        ['3', 'Three Zero', PLAYER_3],
        ['4', 'Two Zero', PLAYER_4],
        ['5', 'Same Record', PLAYER_5],
      ]))
      await startTournament(db, tournament.id)

      await reportTournamentMatch(db, tournament.id, 'closest-session-1', 'closest-match-1', [[PLAYER_1, 1], [PLAYER_2, 2]])
      await reportTournamentMatch(db, tournament.id, 'closest-session-2', 'closest-match-2', [[PLAYER_1, 1], [PLAYER_3, 2]])
      await reportTournamentMatch(db, tournament.id, 'closest-session-3', 'closest-match-3', [[PLAYER_4, 1], [PLAYER_1, 2]])
      await reportTournamentMatch(db, tournament.id, 'closest-session-4', 'closest-match-4', [[PLAYER_5, 1], [PLAYER_2, 2]])
      await reportTournamentMatch(db, tournament.id, 'closest-session-5', 'closest-match-5', [[PLAYER_5, 1], [PLAYER_3, 2]])
      await reportTournamentMatch(db, tournament.id, 'closest-session-6', 'closest-match-6', [[PLAYER_4, 1], [PLAYER_5, 2]])

      const data = await buildTournamentOpponentCardData(db, { userId: PLAYER_1, displayName: 'Target', avatarUrl: null })
      expect('error' in data).toBe(false)
      if ('error' in data) return
      expect(data.player.wins).toBe(2)
      expect(data.player.losses).toBe(1)
      expect(data.opponents[0]?.displayName).toBe('Same Record')
    }
    finally {
      sqlite.close()
    }
  })

  test('left players cannot create or join tournament lobbies', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Leave Cup', createdById: 'admin' })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await expect(resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_1, displayName: 'Alice', avatarUrl: null })).resolves.toEqual({ error: 'No active tournament is accepting lobbies.' })
      await expect(startTournament(db, tournament.id)).resolves.toEqual({ ok: true })

      const leaveResult = await leaveTournament(db, tournament.id, { userId: PLAYER_1, displayName: 'Alice', avatarUrl: null })
      expect(leaveResult).toMatchObject({ ok: true, entry: { status: 'withdrawn' } })

      const target = await resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_1, displayName: 'Alice', avatarUrl: null })
      expect(target).toEqual({ error: 'You are not linked as a player in the active tournament.' })

      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'qualifier-session-1', hostId: PLAYER_2 })
      const join = await validateTournamentLobbyJoin(db, buildLobby('qualifier-session-1', [PLAYER_2, null]), {
        userId: PLAYER_1,
        displayName: 'Alice',
        avatarUrl: null,
      })
      expect(join).toEqual({ ok: false, error: 'You are not linked as a player in the active tournament.' })
    }
    finally {
      sqlite.close()
    }
  })

  test('syncs qualifier reported matches into standings', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Test Cup', createdById: 'admin', minGames: 1 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'session-1', hostId: PLAYER_1, playerOneId: PLAYER_1, playerTwoId: PLAYER_2 })
      await markTournamentMatchDrafting(db, 'session-1', 'match-1')
      await insertReportedMatch(db, 'match-1', [
        [PLAYER_1, 1],
        [PLAYER_2, 2],
      ])

      await syncTournamentMatchAfterReport(db, 'match-1')
      await db.insert(tournamentMatches).values({
        sessionId: 'quarter-session',
        tournamentId: tournament.id,
        matchId: 'quarter-match',
        stage: 'quarterfinal',
        status: 'reported',
        playerOneId: PLAYER_1,
        playerTwoId: PLAYER_2,
        winnerId: PLAYER_2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

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
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'tournament-report', hostId: PLAYER_1, playerOneId: PLAYER_1, playerTwoId: PLAYER_2 })
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
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'tournament-mod', hostId: PLAYER_1, playerOneId: PLAYER_1, playerTwoId: PLAYER_2 })
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

      const [link] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, 'tournament-mod'))
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
      await startTournament(db, blockedTournament.id)
      await createTournamentMatchLink(db, { tournamentId: blockedTournament.id, sessionId: 'old-block-session', hostId: PLAYER_1, playerOneId: PLAYER_1, playerTwoId: PLAYER_2 })
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
      expect(blocked).toEqual({ ok: false, error: 'These entries already played in the tournament.' })

      await db.update(tournaments).set({ status: 'completed' }).where(eq(tournaments.id, blockedTournament.id))
      const warnTournament = await createTournament(db, { name: 'Warn Cup', createdById: 'admin', rematchPolicy: 'warn' })
      await importTournamentPlayersCsv(db, warnTournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
      ]))
      await startTournament(db, warnTournament.id)
      await createTournamentMatchLink(db, { tournamentId: warnTournament.id, sessionId: 'old-warn-session', hostId: PLAYER_1, playerOneId: PLAYER_1, playerTwoId: PLAYER_2 })
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
      expect(allowed).toMatchObject({ ok: true, expectedSlot: 1, needsClaim: true })
      if (allowed.ok) await claimTournamentQualifierOpponentEntry(db, 'new-warn-session', allowed.entryId)

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
      await startTournament(db, tournament.id)
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

  test('creates fresh top-cut bracket without editing qualifier standings', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:tournament-leaderboard', 'channel-tournament')

    const posts: string[] = []
    const patches: string[] = []
    let messageCounter = 0
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-tournament/messages')) {
        messageCounter += 1
        posts.push(url)
        return new Response(JSON.stringify({ id: `message-${messageCounter}` }), { status: 200 })
      }
      if (init?.method === 'PATCH' && url.includes('/channels/channel-tournament/messages/')) {
        patches.push(url)
        return new Response('{}', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      const tournament = await createTournament(db, { name: 'Fresh Image Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await startTournament(db, tournament.id)
      await reportTournamentMatch(db, tournament.id, 'fresh-image-qualifier-1', 'fresh-image-match-1', [[PLAYER_1, 1], [PLAYER_4, 2]])
      await reportTournamentMatch(db, tournament.id, 'fresh-image-qualifier-2', 'fresh-image-match-2', [[PLAYER_2, 1], [PLAYER_3, 2]])

      await refreshTournamentLeaderboard(db, kv, 'token')
      await createTournamentCut(db, tournament.id)
      await refreshTournamentLeaderboard(db, kv, 'token')

      expect(posts).toHaveLength(2)
      expect(patches).toHaveLength(0)

      const states = await db.select().from(leaderboardMessageStates)
      const messageIdByScope = new Map(states.map(row => [row.scope, row.messageId]))
      expect(messageIdByScope.get('tournament:active')).toBe('message-1')
      expect(messageIdByScope.has(`tournament:${tournament.id}:top-cut`)).toBe(false)
      expect(messageIdByScope.get(`tournament:${tournament.id}:bracket`)).toBe('message-2')

      await refreshTournamentLeaderboard(db, kv, 'token')
      expect(posts).toHaveLength(2)
      expect(patches).toHaveLength(1)
      expect(patches.some(url => url.endsWith('/messages/message-1'))).toBe(false)
    }
    finally {
      sqlite.close()
    }
  })

  test('rejects persisted unsupported top cut sizes', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Unsupported Cut Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await db.update(tournaments).set({ topCut: 6 }).where(eq(tournaments.id, tournament.id))
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await startTournament(db, tournament.id)
      await reportTournamentMatch(db, tournament.id, 'unsupported-session-1', 'unsupported-match-1', [[PLAYER_1, 1], [PLAYER_4, 2]])
      await reportTournamentMatch(db, tournament.id, 'unsupported-session-2', 'unsupported-match-2', [[PLAYER_2, 1], [PLAYER_3, 2]])

      await expect(createTournamentCut(db, tournament.id)).resolves.toEqual({ error: 'Top cut must be one of: 2, 4, 8.' })
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
      await startTournament(db, tournament.id)
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
      expect(target.creatorEntry.members[0]?.playerId).toBe(PLAYER_4)
      expect(target.opponentEntry?.members[0]?.playerId).toBe(PLAYER_1)
      expect(target.opponentDisplayName).toBe('Alice')
      expect(target.existingSessionId).toBeNull()

      await createTournamentMatchLink(db, {
        tournamentId: target.tournamentId,
        sessionId: 'cut-session-1',
        hostId: PLAYER_4,
        stage: target.stage,
        cutPairingId: target.cutPairingId,
        entryOneId: target.entryOneId,
        entryTwoId: target.entryTwoId,
      })

      const labels = await buildTournamentReservedSlotLabels(db, buildLobby('cut-session-1', [PLAYER_4, null]))
      expect(labels).toEqual([null, 'Alice'])

      const pairedJoin = await validateTournamentLobbyJoin(db, buildLobby('cut-session-1', [PLAYER_4, null]), {
        userId: PLAYER_1,
        displayName: 'Alice',
        avatarUrl: null,
      })
      expect(pairedJoin).toMatchObject({ ok: true, expectedSlot: 1, needsClaim: false })

      const unpairedJoin = await validateTournamentLobbyJoin(db, buildLobby('cut-session-1', [PLAYER_4, null]), {
        userId: PLAYER_2,
        displayName: 'Bob',
        avatarUrl: null,
      })
      expect(unpairedJoin).toEqual({ ok: false, error: 'This playoff lobby is reserved for its paired entries.' })

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

  test('advances completed quarterfinal branches using bracket seed order', async () => {
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
      await startTournament(db, tournament.id)
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-1', 'quarter-qualifier-match-1', [[PLAYER_1, 1], [PLAYER_8, 2]])
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-2', 'quarter-qualifier-match-2', [[PLAYER_2, 1], [PLAYER_7, 2]])
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-3', 'quarter-qualifier-match-3', [[PLAYER_3, 1], [PLAYER_6, 2]])
      await reportTournamentMatch(db, tournament.id, 'quarter-qualifier-4', 'quarter-qualifier-match-4', [[PLAYER_4, 1], [PLAYER_5, 2]])
      await createTournamentCut(db, tournament.id)

      const quarterfinals = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      const oneVsEight = findPairing(quarterfinals, 1, 8)
      await reportTopCutPairing(db, tournament.id, oneVsEight, 'quarter-session-1a', 'quarter-match-1a', PLAYER_1)
      let pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      const pendingOneVsEight = findPairing(pairings, 1, 8)
      expect(pendingOneVsEight.status).toBe('scheduled')
      expect(pendingOneVsEight.winnerId).toBeNull()
      expect(pendingOneVsEight.sessionId).toBeNull()
      expect(pairings.filter(pairing => pairing.round === 'semifinal')).toHaveLength(0)
      const imageData = await buildTournamentLeaderboardImageData(db, tournament.id)
      const imagePairing = imageData?.pairings.find(pairing => pairing.seedOne === 1 && pairing.seedTwo === 8)
      expect(imagePairing).toMatchObject({ playerOneScore: 1, playerTwoScore: 0, requiredWins: 2, playerOneId: PLAYER_1, playerTwoId: PLAYER_8 })
      const pendingSeriesSvg = await renderTournamentLeaderboardSvg(imageData!)
      expect(pendingSeriesSvg).toContain('avatar-1000000000000001')
      expect(pendingSeriesSvg).not.toContain('SEMIFINALS')

      await reportTopCutPairing(db, tournament.id, oneVsEight, 'quarter-session-1b', 'quarter-match-1b', PLAYER_1)
      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'semifinal')).toHaveLength(0)
      const projectedSvg = await renderTournamentLeaderboardSvg((await buildTournamentLeaderboardImageData(db, tournament.id))!)
      expect(projectedSvg).toContain('SEMIFINALS')
      expect(projectedSvg).toContain('TBD')

      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 4, 5), 'quarter-session-2a', 'quarter-match-2a', PLAYER_4)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 4, 5), 'quarter-session-2b', 'quarter-match-2b', PLAYER_4)

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      let semifinals = pairings
        .filter(pairing => pairing.round === 'semifinal')
        .sort((left, right) => left.seedOne - right.seedOne)
      expect(semifinals.map(pairing => [pairing.seedOne, pairing.playerOneId, pairing.seedTwo, pairing.playerTwoId])).toEqual([
        [1, PLAYER_1, 4, PLAYER_4],
      ])

      const earlyTarget = await resolveTournamentOpenLobbyTarget(db, { userId: PLAYER_4, displayName: 'Dave', avatarUrl: null })
      expect('error' in earlyTarget).toBe(false)
      if ('error' in earlyTarget) return
      expect(earlyTarget.stage).toBe('semifinal')
      expect(earlyTarget.opponentEntry?.members[0]?.playerId).toBe(PLAYER_1)

      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 2, 7), 'quarter-session-3a', 'quarter-match-3a', PLAYER_2)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 2, 7), 'quarter-session-3b', 'quarter-match-3b', PLAYER_2)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 3, 6), 'quarter-session-4a', 'quarter-match-4a', PLAYER_3)
      await reportTopCutPairing(db, tournament.id, findPairing(quarterfinals, 3, 6), 'quarter-session-4b', 'quarter-match-4b', PLAYER_3)

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      semifinals = pairings
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
      await startTournament(db, tournament.id)
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
      const semifinalImageData = await buildTournamentLeaderboardImageData(db, tournament.id)
      expect(semifinalImageData?.pairings.filter(pairing => pairing.round === 'semifinal').every(pairing => pairing.requiredWins === 2)).toBe(true)

      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'advance-semi-session-1a', 'advance-semi-match-1a', PLAYER_1)
      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(0)
      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'advance-semi-session-1b', 'advance-semi-match-1b', PLAYER_1)
      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(0)

      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'advance-semi-session-2a', 'advance-semi-match-2a', PLAYER_3)
      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(0)
      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'advance-semi-session-2b', 'advance-semi-match-2b', PLAYER_3)
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
      expect(finalTarget.opponentEntry?.members[0]?.playerId).toBe(PLAYER_1)
      expect(finalTarget.opponentDisplayName).toBe('Alice')
      const finalImageData = await buildTournamentLeaderboardImageData(db, tournament.id)
      expect(finalImageData?.pairings.find(pairing => pairing.round === 'final')?.requiredWins).toBe(3)

      await reportTopCutPairing(db, tournament.id, finals[0]!, 'advance-final-session-1', 'advance-final-match-1', PLAYER_3)
      let pendingTournament = (await db.select().from(tournaments).where(eq(tournaments.id, tournament.id)))[0]
      expect(pendingTournament?.status).toBe('top_cut')

      await reportTopCutPairing(db, tournament.id, finals[0]!, 'advance-final-session-2', 'advance-final-match-2', PLAYER_3)
      pendingTournament = (await db.select().from(tournaments).where(eq(tournaments.id, tournament.id)))[0]
      expect(pendingTournament?.status).toBe('top_cut')

      await reportTopCutPairing(db, tournament.id, finals[0]!, 'advance-final-session-3', 'advance-final-match-3', PLAYER_3)
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

  test('updates an unstarted downstream pairing after a top-cut result correction', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Corrected Cup', createdById: 'admin', minGames: 1, topCut: 4 })
      await importTournamentPlayersCsv(db, tournament.id, playersCsv([
        ['1', 'Alice', PLAYER_1],
        ['2', 'Bob', PLAYER_2],
        ['3', 'Carol', PLAYER_3],
        ['4', 'Dave', PLAYER_4],
      ]))
      await startTournament(db, tournament.id)
      await reportTournamentMatch(db, tournament.id, 'correct-qualifier-1', 'correct-qualifier-match-1', [[PLAYER_1, 1], [PLAYER_4, 2]])
      await reportTournamentMatch(db, tournament.id, 'correct-qualifier-2', 'correct-qualifier-match-2', [[PLAYER_2, 1], [PLAYER_3, 2]])
      await createTournamentCut(db, tournament.id)

      let pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      const semifinals = pairings.filter(pairing => pairing.round === 'semifinal').sort((left, right) => left.seedOne - right.seedOne)
      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'correct-semi-session-1a', 'correct-semi-match-1a', PLAYER_1)
      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'correct-semi-session-1b', 'correct-semi-match-1b', PLAYER_1)
      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'correct-semi-session-2a', 'correct-semi-match-2a', PLAYER_3)
      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'correct-semi-session-2b', 'correct-semi-match-2b', PLAYER_3)

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      let finals = pairings.filter(pairing => pairing.round === 'final')
      expect(finals).toHaveLength(1)
      expect(finals[0]?.playerTwoId).toBe(PLAYER_3)

      for (const matchId of ['correct-semi-match-2a', 'correct-semi-match-2b']) {
        await db.update(matchParticipants)
          .set({ placement: 1 })
          .where(and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.playerId, PLAYER_2)))
        await db.update(matchParticipants)
          .set({ placement: 2 })
          .where(and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.playerId, PLAYER_3)))
        await syncTournamentMatchAfterReport(db, matchId)
      }

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      finals = pairings.filter(pairing => pairing.round === 'final')
      expect(finals).toHaveLength(1)
      expect(finals[0]?.status).toBe('scheduled')
      expect(finals[0]?.sessionId).toBeNull()
      expect(finals[0]?.seedOne).toBe(1)
      expect(finals[0]?.playerOneId).toBe(PLAYER_1)
      expect(finals[0]?.seedTwo).toBe(2)
      expect(finals[0]?.playerTwoId).toBe(PLAYER_2)
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
      await startTournament(db, tournament.id)
      await reportTournamentMatch(db, tournament.id, 'reset-qualifier-1', 'reset-qualifier-match-1', [[PLAYER_1, 1], [PLAYER_4, 2]])
      await reportTournamentMatch(db, tournament.id, 'reset-qualifier-2', 'reset-qualifier-match-2', [[PLAYER_2, 1], [PLAYER_3, 2]])
      await createTournamentCut(db, tournament.id)

      let pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      const semifinals = pairings.filter(pairing => pairing.round === 'semifinal').sort((left, right) => left.seedOne - right.seedOne)
      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'reset-semi-session-1a', 'reset-semi-match-1a', PLAYER_1)
      await reportTopCutPairing(db, tournament.id, semifinals[0]!, 'reset-semi-session-1b', 'reset-semi-match-1b', PLAYER_1)
      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'reset-semi-session-2a', 'reset-semi-match-2a', PLAYER_3)
      await reportTopCutPairing(db, tournament.id, semifinals[1]!, 'reset-semi-session-2b', 'reset-semi-match-2b', PLAYER_3)

      pairings = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id))
      expect(pairings.filter(pairing => pairing.round === 'final')).toHaveLength(1)

      await syncTournamentMatchAfterCancel(db, 'reset-semi-match-2b')

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
      expect(target.opponentEntry?.members[0]?.playerId).toBe(PLAYER_3)
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
      await startTournament(db, tournament.id)
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
  await createTournamentMatchLink(db, { tournamentId, sessionId, hostId: participants[0]![0], playerOneId: participants[0]![0], playerTwoId: participants[1]![0] })
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
