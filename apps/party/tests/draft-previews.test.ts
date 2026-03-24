import type { DraftPreviewState, DraftState } from '@civup/game'
import { createDraft, default1v1, default2v2, defaultFfa, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  applyDraftPreview,
  censorDraftPreviews,
  createEmptyDraftPreviews,
  resolvePickSubmissionWithPreviews,
  resolveTimeoutWithPreviews,
  sanitizeDraftPreviews,
} from '../src/draft-previews.ts'

function create2v2Seats() {
  return [
    { playerId: 'a1', displayName: 'A1', team: 0 },
    { playerId: 'b1', displayName: 'B1', team: 1 },
    { playerId: 'a2', displayName: 'A2', team: 0 },
    { playerId: 'b2', displayName: 'B2', team: 1 },
  ]
}

function createDuelSeats() {
  return [
    { playerId: 'p1', displayName: 'P1' },
    { playerId: 'p2', displayName: 'P2' },
  ]
}

function createFfaSeats(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `p${index + 1}`,
    displayName: `P${index + 1}`,
  }))
}

function createTestCivPool(): string[] {
  return Array.from({ length: 24 }, (_, index) => `civ-${index + 1}`)
}

function resolveState(result: ReturnType<typeof processDraftInput>): DraftState {
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

function startDraft(state: DraftState): DraftState {
  return resolveState(processDraftInput(state, { type: 'START' }))
}

function completeTeamBanPhase(state: DraftState): DraftState {
  const afterFirstBan = resolveState(processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true))
  return resolveState(processDraftInput(afterFirstBan, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true))
}

describe('draft preview helpers', () => {
  test('stores partial blind bans for timeout fallback', () => {
    const state = startDraft(createDraft('match-preview-ban', default2v2, create2v2Seats(), createTestCivPool()))

    const nextPreviews = applyDraftPreview(state, createEmptyDraftPreviews(), 0, 'ban', ['civ-7', 'civ-8'])
    expect(isDraftError(nextPreviews)).toBe(false)
    if (isDraftError(nextPreviews)) return

    expect(nextPreviews.bans[0]).toEqual(['civ-7', 'civ-8'])
  })

  test('timeout keeps saved bans and random-fills the remainder', () => {
    const state = startDraft(createDraft('match-timeout-ban', default2v2, create2v2Seats(), createTestCivPool()))
    const previews: DraftPreviewState = {
      bans: {
        0: ['civ-7', 'civ-8'],
      },
      picks: {},
    }

    const result = resolveTimeoutWithPreviews(state, true, previews)
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result)) return

    expect(result.state.currentStepIndex).toBe(1)
    expect(result.state.bans).toHaveLength(6)
    expect(result.state.bans.filter(ban => ban.seatIndex === 0).map(ban => ban.civId)).toEqual(expect.arrayContaining(['civ-7', 'civ-8']))
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'TIMEOUT_APPLIED',
      seatIndex: 0,
      selections: expect.arrayContaining(['civ-7', 'civ-8']),
    }))
  })

  test('timeout auto-picks the first valid queued leader instead of cancelling', () => {
    const started = startDraft(createDraft('match-timeout-pick', default2v2, create2v2Seats(), createTestCivPool()))
    const state = completeTeamBanPhase(started)
    const previews: DraftPreviewState = {
      bans: {},
      picks: {
        0: ['civ-10', 'civ-11'],
        2: ['civ-12'],
      },
    }

    const result = resolveTimeoutWithPreviews(state, true, previews)
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result)) return

    expect(result.state.status).toBe('active')
    expect(result.state.currentStepIndex).toBe(2)
    expect(result.state.picks).toContainEqual(expect.objectContaining({ seatIndex: 0, civId: 'civ-10' }))
    expect(result.events).toContainEqual({ type: 'TIMEOUT_APPLIED', seatIndex: 0, selections: ['civ-10'] })
  })

  test('pick confirmation falls back to the next queued leader when the primary loses the race', () => {
    let state = startDraft(createDraft('match-ffa-pick-fallback', defaultFfa, createFfaSeats(), createTestCivPool()))

    for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
      state = resolveState(processDraftInput(state, {
        type: 'BAN',
        seatIndex,
        civIds: [`civ-${seatIndex * 2 + 1}`, `civ-${seatIndex * 2 + 2}`],
      }, true))
    }

    state = resolveState(processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' }, true))

    const result = resolvePickSubmissionWithPreviews(state, true, {
      1: ['civ-10', 'civ-11', 'civ-12'],
    }, 1, 'civ-10')

    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result)) return

    expect(result.state.picks).toContainEqual(expect.objectContaining({ seatIndex: 1, civId: 'civ-11' }))
    expect(result.events).toContainEqual({ type: 'PICK_SUBMITTED', seatIndex: 1, civId: 'civ-11' })
  })

  test('timeout still scrubs when no queued pick remains valid', () => {
    let state = startDraft(createDraft('match-timeout-cancel', default1v1, createDuelSeats(), createTestCivPool()))
    state = resolveState(processDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: ['civ-1', 'civ-2', 'civ-3'] }, true))
    state = resolveState(processDraftInput(state, { type: 'BAN', seatIndex: 1, civIds: ['civ-4', 'civ-5', 'civ-6'] }, true))
    state = resolveState(processDraftInput(state, { type: 'PICK', seatIndex: 0, civId: 'civ-10' }, false))

    const result = resolveTimeoutWithPreviews(state, true, {
      bans: {},
      picks: {
        1: ['civ-10'],
      },
    })
    expect(isDraftError(result)).toBe(false)
    if (isDraftError(result)) return

    expect(result.state.status).toBe('cancelled')
    expect(result.state.cancelReason).toBe('timeout')
    expect(result.events).toContainEqual({ type: 'DRAFT_CANCELLED', reason: 'timeout' })
  })

  test('censors preview visibility to self and teammates only', () => {
    const state = completeTeamBanPhase(startDraft(createDraft('match-preview-censor', default2v2, create2v2Seats(), createTestCivPool())))
    const previews = sanitizeDraftPreviews(state, {
      bans: {},
      picks: {
        0: ['civ-10', 'civ-11'],
        1: ['civ-12'],
        2: ['civ-13'],
        3: ['civ-14'],
      },
    })

    expect(censorDraftPreviews(state, previews, 0)).toEqual({
      bans: {},
      picks: {
        0: ['civ-10', 'civ-11'],
        2: ['civ-13'],
      },
    })
    expect(censorDraftPreviews(state, previews, 1)).toEqual({
      bans: {},
      picks: {
        1: ['civ-12'],
        3: ['civ-14'],
      },
    })
  })
})
