import type { LobbyState } from '../../src/services/lobby/index.ts'
import { describe, expect, test } from 'bun:test'
import { matchParticipants, matches, tournamentCutPairings, tournaments } from '@civup/db'
import { eq } from 'drizzle-orm'
import {
  buildTournamentLobbySnapshot,
  buildTournamentStandings,
  createTournament,
  createTournamentCut,
  createTournamentMatchLink,
  importTournamentPlayersCsv,
  markTournamentMatchDrafting,
  syncTournamentMatchAfterReport,
  validateTournamentLobbyJoin,
} from '../../src/services/tournament/index.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const PLAYER_1 = '1000000000000001'
const PLAYER_2 = '1000000000000002'
const PLAYER_3 = '1000000000000003'
const PLAYER_4 = '1000000000000004'

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
      expect(snapshot?.rematchWarning).toContain('already have a reported match')
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
