import type { LobbyState } from '../../src/services/lobby/types.ts'
import type { TournamentEntrySnapshot, TournamentIdentity, TournamentStage } from '../../src/services/tournament/index.ts'
import { matches, matchParticipants, tournamentCutPairings, tournaments } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { renderTournamentLeaderboardSvg, renderTournamentResultPng, renderTournamentResultSvg } from '../../src/services/tournament/image.ts'
import {
  buildTournamentLeaderboardImageData,
  buildTournamentReservedSlotLabels,
  buildTournamentResultImageData,
  buildTournamentStandings,
  claimTournamentPlayoffLobby,
  claimTournamentQualifierOpponentEntry,
  createTournament,
  createTournamentCut,
  createTournamentMatchLink,
  leaveTournament,
  markTournamentMatchDrafting,
  registerTournamentEntry,
  resolveTournamentOpenLobbyTarget,
  startTournament,
  syncTournamentMatchAfterCancel,
  syncTournamentMatchAfterReport,
  validateTournamentLobbyJoin,
  validateTournamentLobbyRoster,
  validateTournamentMatchMutation,
} from '../../src/services/tournament/index.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const ids = Array.from({ length: 24 }, (_, index) => `200000000000${String(index + 1).padStart(4, '0')}`)

describe('team tournament registration', () => {
  test('registers exact 1v1, 2v2, and 6v6 rosters with conflicts, idempotency, and entry withdrawal', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const duel = await createTournament(db, { name: 'Duel', createdById: 'admin', mode: '1v1' })
      const duelRegistration = await registerTournamentEntry(db, duel.id, [identity(ids[0]!, 'Duelist')])
      expect('error' in duelRegistration).toBe(false)
      const duelAgain = await registerTournamentEntry(db, duel.id, [identity(ids[0]!, 'Duelist')])
      expect(duelAgain).toMatchObject({ idempotent: true })
      await db.update(tournaments).set({ status: 'completed' }).where(eq(tournaments.id, duel.id))

      const duo = await createTournament(db, { name: 'Duo', createdById: 'admin', mode: '2v2' })
      const first = await registerTournamentEntry(db, duo.id, [identity(ids[1]!, 'Alpha'), identity(ids[2]!, 'Beta')])
      expect('error' in first).toBe(false)
      const reordered = await registerTournamentEntry(db, duo.id, [identity(ids[2]!, 'Beta'), identity(ids[1]!, 'Alpha')])
      expect(reordered).toMatchObject({ idempotent: true })
      const conflict = await registerTournamentEntry(db, duo.id, [identity(ids[1]!, 'Alpha'), identity(ids[3]!, 'Gamma')])
      expect(conflict).toEqual({ error: 'Alpha is already registered in another active entry.' })
      const duplicate = await registerTournamentEntry(db, duo.id, [identity(ids[3]!, 'Gamma'), identity(ids[3]!, 'Gamma')])
      expect(duplicate).toEqual({ error: 'A roster cannot include the same player more than once.' })
      const bot = await registerTournamentEntry(db, duo.id, [identity(ids[3]!, 'Gamma'), { ...identity(ids[4]!, 'Bot'), bot: true }])
      expect(bot).toEqual({ error: 'Bots cannot register for tournaments.' })
      const withdrawn = await leaveTournament(db, duo.id, identity(ids[2]!, 'Beta'))
      expect(withdrawn).toMatchObject({ ok: true, entry: { status: 'withdrawn' } })

      await db.update(tournaments).set({ status: 'completed' }).where(eq(tournaments.id, duo.id))
      const sixes = await createTournament(db, { name: 'Sixes', createdById: 'admin', mode: '6v6' })
      const roster = ids.slice(6, 12).map((id, index) => identity(id!, `Six ${index + 1}`))
      expect(await registerTournamentEntry(db, sixes.id, roster)).toMatchObject({ idempotent: false })
      expect(await registerTournamentEntry(db, sixes.id, roster.slice(0, 5))).toEqual({ error: '6v6 registration requires exactly 6 players.' })
      const otherRoster = ids.slice(12, 18).map((id, index) => identity(id!, `Other ${index + 1}`))
      await registerTournamentEntry(db, sixes.id, otherRoster)
      expect(await startTournament(db, sixes.id)).toEqual({ ok: true })
    }
    finally {
      sqlite.close()
    }
  })

  test('runs a coherent 2v2 registration, claim, standings, playoff, correction, cancellation, and rendering flow', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Duo Flow', createdById: 'admin', mode: '2v2', minGames: 1, topCut: 2, rematchPolicy: 'block' })
      const one = requireEntry(await registerTournamentEntry(db, tournament.id, [identity(ids[0]!, 'Alpha'), identity(ids[1]!, 'Beta')]))
      const two = requireEntry(await registerTournamentEntry(db, tournament.id, [identity(ids[2]!, 'Gamma'), identity(ids[3]!, 'Delta')]))
      const three = requireEntry(await registerTournamentEntry(db, tournament.id, [identity(ids[4]!, 'Epsilon'), identity(ids[5]!, 'Zeta')]))
      expect(await startTournament(db, tournament.id)).toEqual({ ok: true })

      const target = await resolveTournamentOpenLobbyTarget(db, identity(ids[1]!, 'Beta'))
      expect('error' in target).toBe(false)
      if ('error' in target) return
      expect(target.mode).toBe('2v2')
      expect(target.creatorEntry.members.map(member => member.displayName)).toEqual(['Alpha', 'Beta'])
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'duo-qualifier', hostId: ids[1]!, entryOneId: one.entryId })
      const openLobby = lobby('duo-qualifier', '2v2', [ids[0]!, ids[1]!, null, null])
      const admission = await validateTournamentLobbyJoin(db, openLobby, identity(ids[2]!, 'Gamma'), 2)
      expect(admission).toMatchObject({ ok: true, entryId: two.entryId, expectedSlot: 2, needsClaim: true })
      expect(await claimTournamentQualifierOpponentEntry(db, openLobby.id, two.entryId)).toEqual({ ok: true, claimed: true })
      const third = await validateTournamentLobbyJoin(db, openLobby, identity(ids[4]!, 'Epsilon'), 2)
      expect(third).toEqual({ ok: false, error: 'This lobby is already reserved for two tournament entries.' })
      expect(await buildTournamentReservedSlotLabels(db, lobby('duo-qualifier', '2v2', [ids[0]!, ids[1]!, ids[2]!, null]))).toEqual([null, null, null, 'Delta'])
      expect(await validateTournamentLobbyRoster(db, lobby('duo-qualifier', '2v2', [ids[0]!, ids[1]!, ids[2]!, ids[3]!]))).toEqual({ ok: true })
      expect(await validateTournamentLobbyRoster(db, lobby('duo-qualifier', '2v2', [ids[0]!, ids[2]!, ids[1]!, ids[3]!]))).toEqual({ ok: false, error: 'Beta must remain on their registered team side.' })

      await reportTeamMatch(db, tournament.id, 'duo-qualifier', 'duo-qualifier-match', one, two, one, 'qualifier')
      const standings = await buildTournamentStandings(db, tournament.id)
      expect(standings.find(row => row.entryId === one.entryId)).toMatchObject({ displayName: 'Alpha / Beta', games: 1, wins: 1, losses: 0, eligible: true })
      expect(standings.find(row => row.entryId === two.entryId)).toMatchObject({ displayName: 'Gamma / Delta', games: 1, wins: 0, losses: 1, eligible: true })
      expect(standings.find(row => row.entryId === three.entryId)).toMatchObject({ games: 0, eligible: false })

      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'duo-rematch', hostId: ids[0]!, entryOneId: one.entryId })
      const rematch = await validateTournamentLobbyJoin(db, lobby('duo-rematch', '2v2', [ids[0]!, ids[1]!, null, null]), identity(ids[2]!, 'Gamma'), 2)
      expect(rematch).toEqual({ ok: false, error: 'These entries already played in the tournament.' })

      const cut = await createTournamentCut(db, tournament.id)
      expect('error' in cut).toBe(false)
      if ('error' in cut) return
      expect(cut.pairings[0]).toMatchObject({ entryOneId: one.entryId, entryTwoId: two.entryId, playerOneDisplayName: 'Alpha / Beta', playerTwoDisplayName: 'Gamma / Delta' })
      const pairing = (await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, tournament.id)))[0]!
      for (let index = 1; index <= 3; index++) await reportTeamMatch(db, tournament.id, `duo-final-${index}`, `duo-final-match-${index}`, one, two, one, 'final', pairing.id)
      let storedPairing = (await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.id, pairing.id)))[0]!
      expect(storedPairing).toMatchObject({ status: 'reported', winnerEntryId: one.entryId })
      expect((await db.select().from(tournaments).where(eq(tournaments.id, tournament.id)))[0]?.status).toBe('completed')

      await db.update(matchParticipants).set({ placement: 2 }).where(and(eq(matchParticipants.matchId, 'duo-final-match-3'), inArray(matchParticipants.playerId, one.members.map(member => member.playerId!))))
      await db.update(matchParticipants).set({ placement: 1 }).where(and(eq(matchParticipants.matchId, 'duo-final-match-3'), inArray(matchParticipants.playerId, two.members.map(member => member.playerId!))))
      await syncTournamentMatchAfterReport(db, 'duo-final-match-3')
      storedPairing = (await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.id, pairing.id)))[0]!
      expect(storedPairing).toMatchObject({ status: 'scheduled', winnerEntryId: null, sessionId: null })
      expect((await db.select().from(tournaments).where(eq(tournaments.id, tournament.id)))[0]?.status).toBe('top_cut')
      await syncTournamentMatchAfterCancel(db, 'duo-final-match-2')
      expect((await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.id, pairing.id)))[0]).toMatchObject({ status: 'scheduled', winnerEntryId: null })

      const leaderboardData = await buildTournamentLeaderboardImageData(db, tournament.id)
      const svg = await renderTournamentLeaderboardSvg(leaderboardData!)
      expect(svg).toContain('Alpha')
      expect(svg).toContain('Beta')
      const resultData = await buildTournamentResultImageData(db, 'duo-qualifier-match', await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'duo-qualifier-match')))
      const resultSvg = await renderTournamentResultSvg(resultData!)
      expect(resultSvg).toContain('WINNING ENTRY')
      expect(resultSvg).toContain('Alpha')
      expect(resultSvg).toContain('Delta')
      expect((await renderTournamentResultPng(resultData!)).byteLength).toBeGreaterThan(1024)
    }
    finally {
      sqlite.close()
    }
  })

  test('uses a power-of-two cut when six entries qualify', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Six Entry Cut', createdById: 'admin', mode: '2v2', minGames: 0, topCut: 8 })
      for (let index = 0; index < 6; index++) {
        requireEntry(await registerTournamentEntry(db, tournament.id, [
          identity(ids[index * 2]!, `Cut ${index + 1}A`),
          identity(ids[index * 2 + 1]!, `Cut ${index + 1}B`),
        ]))
      }
      expect(await startTournament(db, tournament.id)).toEqual({ ok: true })

      const cut = await createTournamentCut(db, tournament.id)
      expect(cut).toMatchObject({ requestedTopCut: 8, actualTopCut: 4, round: 'semifinal' })
      expect('error' in cut ? [] : cut.pairings).toHaveLength(2)
    }
    finally {
      sqlite.close()
    }
  })

  test('claims one playoff lobby atomically and locks upstream results after the next round starts', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const tournament = await createTournament(db, { name: 'Locked Bracket', createdById: 'admin', mode: '2v2', minGames: 0, topCut: 4 })
      const entries: TournamentEntrySnapshot[] = []
      for (let index = 0; index < 4; index++) {
        entries.push(requireEntry(await registerTournamentEntry(db, tournament.id, [
          identity(ids[index * 2]!, `Bracket ${index + 1}A`),
          identity(ids[index * 2 + 1]!, `Bracket ${index + 1}B`),
        ])))
      }
      await startTournament(db, tournament.id)
      await createTournamentCut(db, tournament.id)
      const semifinals = (await db.select().from(tournamentCutPairings).where(and(
        eq(tournamentCutPairings.tournamentId, tournament.id),
        eq(tournamentCutPairings.round, 'semifinal'),
      ))).sort((left, right) => left.seedOne - right.seedOne)
      const entryById = new Map(entries.map(entry => [entry.entryId, entry]))

      for (const [pairingIndex, pairing] of semifinals.entries()) {
        const one = entryById.get(pairing.entryOneId!)!
        const two = entryById.get(pairing.entryTwoId!)!
        for (let game = 1; game <= 2; game++) {
          await reportTeamMatch(
            db,
            tournament.id,
            `locked-semi-${pairingIndex}-${game}`,
            `locked-semi-match-${pairingIndex}-${game}`,
            one,
            two,
            one,
            'semifinal',
            pairing.id,
          )
        }
      }

      const [final] = await db.select().from(tournamentCutPairings).where(and(
        eq(tournamentCutPairings.tournamentId, tournament.id),
        eq(tournamentCutPairings.round, 'final'),
      ))
      expect(final).toBeDefined()
      const claims = await Promise.all([
        claimTournamentPlayoffLobby(db, final!.id, 'final-session-a'),
        claimTournamentPlayoffLobby(db, final!.id, 'final-session-b'),
      ])
      expect(claims.filter(result => result.ok && result.claimed)).toHaveLength(1)
      expect([...new Set(claims.flatMap(result => result.ok ? [result.sessionId] : []))]).toHaveLength(1)

      await expect(validateTournamentMatchMutation(db, 'locked-semi-match-0-1')).resolves.toEqual({
        ok: false,
        error: 'This playoff result is locked because the next-round lobby has already started.',
      })
    }
    finally {
      sqlite.close()
    }
  })
})

function identity(userId: string, displayName: string): TournamentIdentity {
  return { userId, displayName, avatarUrl: null }
}

function requireEntry(result: Awaited<ReturnType<typeof registerTournamentEntry>>): TournamentEntrySnapshot {
  if ('error' in result) throw new Error(result.error)
  return result.entry
}

async function reportTeamMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  tournamentId: string,
  sessionId: string,
  matchId: string,
  one: TournamentEntrySnapshot,
  two: TournamentEntrySnapshot,
  winner: TournamentEntrySnapshot,
  stage: TournamentStage,
  cutPairingId?: string,
): Promise<void> {
  await createTournamentMatchLink(db, { tournamentId, sessionId, hostId: one.members[0]!.playerId!, stage, cutPairingId, entryOneId: one.entryId, entryTwoId: two.entryId })
  await markTournamentMatchDrafting(db, sessionId, matchId)
  await db.insert(matches).values({ id: matchId, guildId: 'guild', gameMode: '2v2', status: 'completed', isOld: false, seasonId: null, draftData: null, createdAt: Date.now(), completedAt: Date.now() })
  await db.insert(matchParticipants).values([
    ...one.members.map(member => participant(matchId, member.playerId!, 0, winner.entryId === one.entryId ? 1 : 2)),
    ...two.members.map(member => participant(matchId, member.playerId!, 1, winner.entryId === two.entryId ? 1 : 2)),
  ])
  await syncTournamentMatchAfterReport(db, matchId)
}

function participant(matchId: string, playerId: string, team: number, placement: number) {
  return { matchId, playerId, team, civId: null, placement, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null }
}

function lobby(id: string, mode: '2v2', slots: (string | null)[]): LobbyState {
  const now = Date.now()
  return {
    id, mode, status: 'open', guildId: 'guild', hostId: slots[0]!, channelId: 'channel', messageId: 'message', matchId: null,
    steamLobbyLink: null, minRole: null, maxRole: null, lastArrange: null, lastActivityAt: now,
    memberPlayerIds: slots.filter((value): value is string => Boolean(value)), slots,
    draftConfig: {
      banTimerSeconds: null, pickTimerSeconds: null, leaderPoolSize: null, leaderDataVersion: 'live', mapVoteEnabled: false,
      teamFormationEnabled: false, blindBans: true, blindPicks: false, simultaneousPick: false, permanentAlly: false,
      redDeath: false, dealOptionsSize: null, civBlitz: false, civBlitzOptionCount: null, civBlitzExcludeBbgExpanded: true,
      randomDraft: false, hiddenDraft: false, duplicateFactions: false,
    },
    createdAt: now, updatedAt: now, revision: 1,
  }
}
