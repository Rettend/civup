import type { DraftState, DraftWebhookPayload } from '@civup/game'
import type { ParsedDraftWebhookPayload } from '../../src/services/match/draft-webhook-events.ts'
import { processedDraftWebhookEvents } from '@civup/db'
import { createDraft, default1v1 } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { claimDraftWebhookEvent, markDraftWebhookEventProcessed, parseDraftWebhookPayload } from '../../src/services/match/draft-webhook-events.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('draft webhook events', () => {
  test('normalizes legacy completion payloads into stable event ids', () => {
    const state = createCompletedState('legacy-match')

    const first = parseDraftWebhookPayload({
      outcome: 'complete',
      matchId: 'legacy-match',
      completedAt: 1_700_000_000_000,
      state,
      mapVoteResult: null,
    })
    const second = parseDraftWebhookPayload({
      outcome: 'complete',
      matchId: 'legacy-match',
      completedAt: 1_700_000_000_000,
      state,
      mapVoteResult: null,
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.eventId).toBe(second?.eventId)
    expect(first?.eventKind).toBe('DraftCompleted')
    expect(first?.eventSequence).toBeNull()
  })

  test('reclaims stale webhook claims and marks processed events durable', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const d1 = createSqliteD1Database(sqlite)
      const payload = createCompletionPayload('claim-match', 1)

      expect(await claimDraftWebhookEvent(d1, payload, 1_000)).toBe('claimed')
      expect(await claimDraftWebhookEvent(d1, payload, 5_000)).toBe('in-flight')
      expect(await claimDraftWebhookEvent(d1, payload, 40_000)).toBe('claimed')

      await markDraftWebhookEventProcessed(d1, payload.eventId, 45_000)
      expect(await claimDraftWebhookEvent(d1, payload, 46_000)).toBe('processed')

      const [storedEvent] = await db
        .select()
        .from(processedDraftWebhookEvents)
        .where(eq(processedDraftWebhookEvents.eventId, payload.eventId))
        .limit(1)

      expect(storedEvent?.processedAt).toBe(45_000)
    }
    finally {
      sqlite.close()
    }
  })

  test('ignores lower-sequence replays once a newer event for the same match is processed', async () => {
    const { sqlite } = await createTestDatabase()

    try {
      const d1 = createSqliteD1Database(sqlite)
      const older = createCompletionPayload('sequence-match', 1)
      const newer = createCompletionPayload('sequence-match', 2, {
        eventId: 'sequence-match:webhook:2',
        eventKind: 'SwapAccepted',
      })

      expect(await claimDraftWebhookEvent(d1, older, 1_000)).toBe('claimed')
      await markDraftWebhookEventProcessed(d1, older.eventId, 1_500)

      expect(await claimDraftWebhookEvent(d1, newer, 2_000)).toBe('claimed')
      await markDraftWebhookEventProcessed(d1, newer.eventId, 2_500)

      expect(await claimDraftWebhookEvent(d1, {
        ...older,
        eventId: 'sequence-match:stale:1',
      }, 3_000)).toBe('processed')
    }
    finally {
      sqlite.close()
    }
  })
})

function createCompletionPayload(
  matchId: string,
  eventSequence: number,
  overrides: Partial<ParsedDraftWebhookPayload> = {},
): ParsedDraftWebhookPayload {
  const state = createCompletedState(matchId)
  return {
    eventId: overrides.eventId ?? `${matchId}:webhook:${eventSequence}`,
    eventKind: overrides.eventKind ?? 'DraftCompleted',
    eventSequence,
    outcome: 'complete',
    matchId,
    hostId: 'host-1',
    completedAt: 1_700_000_000_000 + eventSequence,
    finalized: overrides.finalized === true ? true : undefined,
    state,
    mapVoteResult: null,
  }
}

function createCompletedState(matchId: string): DraftState {
  return {
    ...createDraft(matchId, default1v1, [
      { playerId: 'host-1', displayName: 'Host 1' },
      { playerId: 'guest-1', displayName: 'Guest 1' },
    ], ['rome', 'greece', 'egypt', 'china']),
    status: 'complete',
    currentStepIndex: 1,
  } as DraftState
}
