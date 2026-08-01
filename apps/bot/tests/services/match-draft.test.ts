import type { DraftInput, DraftSeat, DraftState } from '@civup/game'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { civBlitz2v2, cloneOfficialAppliedSettings, createDraft, default2v2, getCivBlitzRegistry, isDraftError, processDraftInput, swapSeatPicks } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { splitValuesForD1InsertLimit } from '../../src/services/match/draft.ts'
import { activateDraftMatch, cancelDraftMatch, createDraftMatch } from '../../src/services/match/index.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'

const GUILD_ID = '111111111111111111'
const MATCH_SCOPE = { guildId: GUILD_ID, primaryGuildId: GUILD_ID } as const

describe('draft match activation', () => {
  test('activates a drafting match and stores the completed roster', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const matchId = 'match-draft-activation'
      const seats = create2v2Seats()
      const completedState = buildCompleted2v2DraftState(matchId, seats)
      const gameSettings = cloneOfficialAppliedSettings()
      gameSettings.profile.base.hutFrequencyMultiplier = 2
      gameSettings.preset = { kind: 'custom', id: null, name: 'Match settings', revision: null }

      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '2v2',
        seats,
        gameSettings,
      })

      const [draftingMatch] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
      expect(JSON.parse(draftingMatch?.draftData ?? '{}').gameSettings).toEqual(gameSettings)

      const result = await activateDraftMatch(db, {
        state: completedState,
        completedAt: 1_700_000_000_000,
        hostId: seats[0]?.playerId ?? 'p1',
        leaderDataVersion: 'beta',
        gameSettings,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.alreadyActive).toBe(false)
      expect(result.match.status).toBe('active')
      expect(result.participants).toHaveLength(4)

      const [storedMatch] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      expect(storedMatch?.status).toBe('active')
      expect(storedMatch?.guildId).toBe(GUILD_ID)
      expect(storedMatch?.draftCompletedAt).toBe(1_700_000_000_000)
      const storedDraftData = storedMatch?.draftData ? JSON.parse(storedMatch.draftData) as { leaderDataVersion?: string, gameSettings?: typeof gameSettings } : null
      expect(storedDraftData?.leaderDataVersion).toBe('beta')
      expect(storedDraftData?.gameSettings).toEqual(gameSettings)

      const storedParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
      expect(storedParticipants.every(participant => participant.sourceGuildId === GUILD_ID && participant.sourceKind === 'joined')).toBe(true)

      const storedBans = await db
        .select()
        .from(matchBans)
        .where(eq(matchBans.matchId, matchId))
      expect(storedBans.length).toBeGreaterThan(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('activation replaces provisional participant teams with the final draft teams', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const matchId = 'match-final-formation-teams'
      const provisionalSeats = create2v2Seats()
      const formedSeats = provisionalSeats.map(seat => ({
        ...seat,
        team: seat.playerId === 'p3' ? 1 : seat.playerId === 'p4' ? 0 : seat.team,
      }))
      await createDraftMatch(db, { ...MATCH_SCOPE, matchId, mode: '2v2', seats: provisionalSeats })

      const result = await activateDraftMatch(db, {
        state: buildCompleted2v2DraftState(matchId, formedSeats),
        completedAt: 1_700_000_000_000,
        hostId: 'p1',
      })
      if ('error' in result) throw new Error(result.error)

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
      expect(Object.fromEntries(participants.map(participant => [participant.playerId, participant.team]))).toEqual({
        p1: 0,
        p2: 1,
        p3: 1,
        p4: 0,
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('stores double-pick metrics in draft data when provided', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const matchId = 'match-draft-double-pick-metrics'
      const seats = create2v2Seats()
      const completedState = buildCompleted2v2DraftState(matchId, seats)

      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '2v2',
        seats,
      })

      const metrics = {
        groups: 1,
        fallbackStarted: 1,
        fallbackResolved: 1,
        bothMissedTimeouts: 0,
        fallbackTimeouts: 0,
      }
      const result = await activateDraftMatch(db, {
        state: completedState,
        completedAt: 1_700_000_000_000,
        hostId: seats[0]?.playerId ?? 'p1',
        doublePickMetrics: metrics,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const [storedMatch] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      const storedDraftData = storedMatch?.draftData ? JSON.parse(storedMatch.draftData) as { doublePickMetrics?: typeof metrics } : null

      expect(storedDraftData?.doublePickMetrics).toEqual(metrics)
    }
    finally {
      sqlite.close()
    }
  })

  test('records draft cancellation lifecycle fields without marking the match completed', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const matchId = 'match-draft-cancelled'
      const seats = create2v2Seats()
      await createDraftMatch(db, { ...MATCH_SCOPE, matchId, mode: '2v2', seats })

      const result = await cancelDraftMatch(db, {
        state: buildCompleted2v2DraftState(matchId, seats),
        cancelledAt: 1_700_000_000_000,
        reason: 'cancel',
        hostId: seats[0]!.playerId,
      })

      expect('error' in result).toBe(false)
      const [storedMatch] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
      expect(storedMatch).toMatchObject({
        status: 'cancelled',
        completedAt: null,
        cancelledAt: 1_700_000_000_000,
        resultRevision: 1,
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('repairs final teams when cancellation is retried after the match was already cancelled', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      const matchId = 'match-cancelled-team-repair'
      const provisionalSeats = create2v2Seats()
      const formedSeats = provisionalSeats.map(seat => ({
        ...seat,
        team: seat.playerId === 'p3' ? 1 : seat.playerId === 'p4' ? 0 : seat.team,
      }))
      await createDraftMatch(db, { ...MATCH_SCOPE, matchId, mode: '2v2', seats: provisionalSeats })
      await db.update(matches).set({ status: 'cancelled', cancelledAt: 10 }).where(eq(matches.id, matchId))

      const result = await cancelDraftMatch(db, {
        state: buildCompleted2v2DraftState(matchId, formedSeats),
        cancelledAt: 10,
        reason: 'cancel',
        hostId: 'p1',
      })
      if ('error' in result) throw new Error(result.error)

      expect(Object.fromEntries(result.participants.map(participant => [participant.playerId, participant.team]))).toEqual({
        p1: 0,
        p2: 1,
        p3: 1,
        p4: 0,
      })
      const stored = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
      expect(Object.fromEntries(stored.map(participant => [participant.playerId, participant.team]))).toEqual({
        p1: 0,
        p2: 1,
        p3: 1,
        p4: 0,
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('stores CivBlitz leader ability source leaders on activation', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const matchId = 'match-draft-civblitz-leaders'
      const seats = create2v2Seats()
      const registry = getCivBlitzRegistry('live')
      const leaderAbilityComponents = registry.components
        .filter(component => component.category === 'leaderAbility')
        .slice(0, seats.length)
      const lockedKits: NonNullable<DraftState['civBlitz']>['lockedKits'] = {}
      expect(leaderAbilityComponents).toHaveLength(seats.length)

      leaderAbilityComponents.forEach((component, index) => {
        lockedKits[index] = { leaderAbility: component.id }
      })

      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '2v2',
        seats,
      })

      const result = await activateDraftMatch(db, {
        state: {
          matchId,
          formatId: civBlitz2v2.id,
          seats,
          steps: civBlitz2v2.getSteps(seats.length),
          currentStepIndex: 0,
          submissions: {},
          bans: [],
          picks: [],
          availableCivIds: [],
          civBlitz: {
            optionCount: 4,
            excludeBbgExpanded: true,
            componentPools: registry.componentPools,
            optionsBySeat: {},
            submissions: {},
            lockedKits,
            reveal: null,
            conflictBans: [],
            maxRedrafts: 1,
          },
          status: 'complete',
          cancelReason: null,
          pendingBlindBans: [],
        },
        completedAt: 1_700_000_000_000,
        hostId: seats[0]?.playerId ?? 'p1',
        leaderDataVersion: 'live',
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const expectedLeaderByPlayer = new Map(leaderAbilityComponents.map((component, index) => [
        seats[index]!.playerId,
        component.sourceLeaderId,
      ]))
      const civByPlayer = new Map(result.participants.map(participant => [participant.playerId, participant.civId]))
      for (const seat of seats) {
        expect(civByPlayer.get(seat.playerId)).toBe(expectedLeaderByPlayer.get(seat.playerId))
      }

      const storedParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
      const storedCivByPlayer = new Map(storedParticipants.map(participant => [participant.playerId, participant.civId]))
      for (const seat of seats) {
        expect(storedCivByPlayer.get(seat.playerId)).toBe(expectedLeaderByPlayer.get(seat.playerId))
      }

      const [storedMatch] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
      const storedDraftData = storedMatch?.draftData ? JSON.parse(storedMatch.draftData) as { civBlitz?: boolean } : null
      expect(storedDraftData?.civBlitz).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('re-syncs an active match after a swap without rewriting the whole draft', async () => {
    const { db, sqlite } = await createTestDatabase()
    const sqlTracker = trackSqlite(sqlite)

    try {
      const matchId = 'match-draft-sync'
      const seats = create2v2Seats()
      const completedState = buildCompleted2v2DraftState(matchId, seats)

      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '2v2',
        seats,
      })

      const activated = await activateDraftMatch(db, {
        state: completedState,
        completedAt: 1_700_000_000_000,
        hostId: seats[0]?.playerId ?? 'p1',
      })
      if ('error' in activated) throw new Error(activated.error)
      const bansBeforeSync = await db
        .select()
        .from(matchBans)
        .where(eq(matchBans.matchId, matchId))

      const swappedPicks = swapSeatPicks(completedState, 0, 2)
      if ('error' in swappedPicks) throw new Error(swappedPicks.error)

      sqlTracker.reset()

      const synced = await activateDraftMatch(db, {
        state: {
          ...completedState,
          picks: swappedPicks,
        },
        completedAt: 1_700_000_005_000,
        hostId: seats[0]?.playerId ?? 'p1',
      })

      expect('error' in synced).toBe(false)
      if ('error' in synced) return

      expect(synced.alreadyActive).toBe(true)
      expect(sqlTracker.counts.rowsWritten).toBe(3)

      const storedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, matchId))
      const bansAfterSync = await db
        .select()
        .from(matchBans)
        .where(eq(matchBans.matchId, matchId))
      const civByPlayer = new Map(storedParticipants.map(participant => [participant.playerId, participant.civId]))

      expect(bansAfterSync).toEqual(bansBeforeSync)
      expect(civByPlayer.get('p1')).toBe(completedState.picks.find(pick => pick.seatIndex === 2)?.civId ?? null)
      expect(civByPlayer.get('p3')).toBe(completedState.picks.find(pick => pick.seatIndex === 0)?.civId ?? null)
      expect(civByPlayer.get('p2')).toBe(completedState.picks.find(pick => pick.seatIndex === 1)?.civId ?? null)
      expect(civByPlayer.get('p4')).toBe(completedState.picks.find(pick => pick.seatIndex === 3)?.civId ?? null)

      const [storedMatch] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      const storedDraftData = storedMatch?.draftData ? JSON.parse(storedMatch.draftData) as { state?: { picks?: DraftState['picks'] } } : null
      expect(storedDraftData?.state?.picks).toEqual(swappedPicks)
    }
    finally {
      sqlTracker.restore()
      sqlite.close()
    }
  })

  test('splits 12 participant inserts to stay under the D1 variable limit', () => {
    const chunks = splitValuesForD1InsertLimit(Array.from({ length: 12 }, (_value, index) => index), 11)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(9)
    expect(chunks[1]).toHaveLength(3)
  })

  test('restarts a cancelled session match with the new draft roster', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const matchId = 'match-draft-restart-cancelled'
      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '1v1',
        seats: [
          { playerId: 'p1', displayName: 'P1', sourceGuild: { id: GUILD_ID } },
          { playerId: 'p2', displayName: 'P2', sourceGuild: { id: GUILD_ID } },
        ],
      })
      await db.update(matches).set({
        status: 'cancelled',
        cancelledAt: 1_700_000_000_000,
        draftData: '{"old":true}',
      }).where(eq(matches.id, matchId))
      await db.update(matchParticipants).set({ civId: 'old-civ' }).where(eq(matchParticipants.matchId, matchId))
      await db.insert(matchBans).values({
        matchId,
        civId: 'old-ban',
        bannedBy: 'p1',
        phase: 0,
      })

      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '1v1',
        seats: [
          { playerId: 'p2', displayName: 'P2', sourceGuild: { id: GUILD_ID } },
          { playerId: 'p3', displayName: 'P3', sourceGuild: { id: GUILD_ID } },
        ],
      })

      const [storedMatch] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
      const storedParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
      const storedBans = await db.select().from(matchBans).where(eq(matchBans.matchId, matchId))

      expect(storedMatch).toMatchObject({
        status: 'drafting',
        completedAt: null,
        cancelledAt: null,
      })
      expect(JSON.parse(storedMatch?.draftData ?? '{}').gameSettings?.preset?.kind).toBe('official')
      expect(storedParticipants.map(participant => participant.playerId).sort()).toEqual(['p2', 'p3'])
      expect(storedParticipants.every(participant => participant.civId == null)).toBe(true)
      expect(storedBans).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('creates a 6v6 draft match', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const matchId = 'match-draft-6v6'
      const seats = createBigTeamSeats(12)

      await createDraftMatch(db, {
        ...MATCH_SCOPE,
        matchId,
        mode: '6v6',
        seats,
      })

      const storedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, matchId))

      expect(storedParticipants).toHaveLength(12)
      expect(storedParticipants.filter(participant => participant.team === 0)).toHaveLength(6)
      expect(storedParticipants.filter(participant => participant.team === 1)).toHaveLength(6)
    }
    finally {
      sqlite.close()
    }
  })
})

function create2v2Seats(): DraftSeat[] {
  return [
    { playerId: 'p1', displayName: 'P1', team: 0, sourceGuild: { id: GUILD_ID } },
    { playerId: 'p2', displayName: 'P2', team: 1, sourceGuild: { id: GUILD_ID } },
    { playerId: 'p3', displayName: 'P3', team: 0, sourceGuild: { id: GUILD_ID } },
    { playerId: 'p4', displayName: 'P4', team: 1, sourceGuild: { id: GUILD_ID } },
  ]
}

function createBigTeamSeats(playerCount: 10 | 12): DraftSeat[] {
  const playersPerTeam = playerCount / 2
  const seats: DraftSeat[] = []

  for (let index = 0; index < playerCount; index++) {
    seats.push({
      playerId: `p${index + 1}`,
      displayName: `P${index + 1}`,
      team: index < playersPerTeam ? 0 : 1,
      sourceGuild: { id: GUILD_ID },
    })
  }

  return seats
}

function createTestCivPool(): string[] {
  return Array.from({ length: 24 }, (_value, index) => `civ-${index + 1}`)
}

function buildCompleted2v2DraftState(matchId: string, seats: DraftSeat[]): DraftState {
  let state = createDraft(matchId, default2v2, seats, createTestCivPool())
  state = applyDraftInput(state, { type: 'START' }, default2v2.blindBans)

  while (state.status !== 'complete') {
    const step = state.steps[state.currentStepIndex]
    if (!step) throw new Error('Expected an active draft step')

    const activeSeatIndices = step.seats === 'all'
      ? Array.from({ length: state.seats.length }, (_value, index) => index)
      : [...step.seats]

    if (step.action === 'ban') {
      const reserved = new Set<string>()
      for (const seatIndex of activeSeatIndices) {
        if (state.submissions[seatIndex]) continue
        const civIds = pickAvailableCivs(state.availableCivIds, step.count, reserved)
        for (const civId of civIds) reserved.add(civId)
        state = applyDraftInput(state, { type: 'BAN', seatIndex, civIds }, default2v2.blindBans)
      }
      continue
    }

    const currentStepIndex = state.currentStepIndex
    for (const seatIndex of activeSeatIndices) {
      const picksMade = state.submissions[seatIndex]?.length ?? 0
      if (picksMade >= step.count) continue

      const alreadyChosen = new Set(Object.values(state.submissions).flat())
      const [civId] = pickAvailableCivs(state.availableCivIds, 1, alreadyChosen)
      if (!civId) throw new Error('Expected an available civ for the next pick')

      state = applyDraftInput(state, { type: 'PICK', seatIndex, civId }, default2v2.blindBans)
      if (state.status === 'complete' || state.currentStepIndex !== currentStepIndex) break
    }
  }

  return state
}

function applyDraftInput(state: DraftState, input: DraftInput, blindBans: boolean): DraftState {
  const result = processDraftInput(state, input, blindBans)
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

function pickAvailableCivs(availableCivIds: string[], count: number, blocked: Set<string>): string[] {
  const picked: string[] = []

  for (const civId of availableCivIds) {
    if (blocked.has(civId)) continue
    picked.push(civId)
    if (picked.length >= count) return picked
  }

  throw new Error(`Expected ${count} available civs, found ${picked.length}`)
}
