import type {
  DraftCancelledWebhookPayload,
  DraftCompleteWebhookPayload,
  DraftWebhookEventKind,
  DraftWebhookPayload,
} from '@civup/game'
import { DRAFT_WEBHOOK_EVENT_KINDS } from '@civup/game'

const DRAFT_WEBHOOK_CLAIM_LEASE_MS = 30_000

export type DraftWebhookClaimResult = 'claimed' | 'processed' | 'in-flight'

export type ParsedDraftWebhookPayload
  = | (Omit<DraftCompleteWebhookPayload, 'eventSequence'> & { eventSequence: number | null })
    | (Omit<DraftCancelledWebhookPayload, 'eventSequence'> & { eventSequence: number | null })

export async function claimDraftWebhookEvent(
  d1: D1Database,
  payload: ParsedDraftWebhookPayload,
  now: number = Date.now(),
): Promise<DraftWebhookClaimResult> {
  if (payload.eventSequence != null) {
    const newestProcessed = await d1.prepare(`
      SELECT MAX(event_sequence) AS max_event_sequence
      FROM processed_draft_webhook_events
      WHERE match_id = ?
        AND processed_at IS NOT NULL
        AND event_sequence IS NOT NULL
    `)
      .bind(payload.matchId)
      .first<{ max_event_sequence: number | null }>()

    if (typeof newestProcessed?.max_event_sequence === 'number' && newestProcessed.max_event_sequence >= payload.eventSequence) {
      return 'processed'
    }
  }

  const insertResults = await d1.batch([
    d1.prepare(`
      INSERT INTO processed_draft_webhook_events (
        event_id,
        match_id,
        outcome,
        event_kind,
        event_sequence,
        claimed_at,
        processed_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).bind(
      payload.eventId,
      payload.matchId,
      payload.outcome,
      payload.eventKind,
      payload.eventSequence,
      now,
      now,
      now,
    ),
  ])

  const insertResult = insertResults[0]
  if (insertResult && insertResult.meta.changes > 0) {
    return 'claimed'
  }

  const existing = await d1.prepare(`
    SELECT claimed_at AS claimed_at, processed_at AS processed_at
    FROM processed_draft_webhook_events
    WHERE event_id = ?
  `)
    .bind(payload.eventId)
    .first<{ claimed_at: number | null, processed_at: number | null }>()

  if (typeof existing?.processed_at === 'number') {
    return 'processed'
  }

  const claimedAt = existing?.claimed_at
  if (typeof claimedAt !== 'number' || claimedAt > now - DRAFT_WEBHOOK_CLAIM_LEASE_MS) {
    return 'in-flight'
  }

  const reclaimResult = await d1.prepare(`
    UPDATE processed_draft_webhook_events
    SET claimed_at = ?, updated_at = ?
    WHERE event_id = ?
      AND processed_at IS NULL
      AND claimed_at = ?
  `)
    .bind(now, now, payload.eventId, claimedAt)
    .run()

  return reclaimResult.meta.changes > 0 ? 'claimed' : 'in-flight'
}

export async function markDraftWebhookEventProcessed(
  d1: D1Database,
  eventId: string,
  now: number = Date.now(),
): Promise<void> {
  await d1.prepare(`
    UPDATE processed_draft_webhook_events
    SET processed_at = ?, updated_at = ?
    WHERE event_id = ?
  `)
    .bind(now, now, eventId)
    .run()
}

export async function releaseDraftWebhookEventClaim(
  d1: D1Database,
  eventId: string,
): Promise<void> {
  await d1.prepare(`
    DELETE FROM processed_draft_webhook_events
    WHERE event_id = ?
      AND processed_at IS NULL
  `)
    .bind(eventId)
    .run()
}

export function parseDraftWebhookPayload(value: unknown): ParsedDraftWebhookPayload | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<DraftWebhookPayload> & {
    cancelledAt?: unknown
    reason?: unknown
    eventId?: unknown
    eventKind?: unknown
    eventSequence?: unknown
    outcome?: unknown
  }

  if (typeof raw.matchId !== 'string') return null
  if (!raw.state || typeof raw.state !== 'object') return null

  const explicitEventKind = typeof raw.eventKind === 'string'
    ? parseDraftWebhookEventKind(raw.eventKind)
    : null
  if (typeof raw.eventKind === 'string' && !explicitEventKind) return null

  const eventSequence = typeof raw.eventSequence === 'number' && Number.isFinite(raw.eventSequence)
    ? raw.eventSequence
    : null

  if (raw.outcome === 'complete') {
    if (typeof raw.completedAt !== 'number' || raw.state.status !== 'complete') return null
    if (explicitEventKind && explicitEventKind === 'DraftCancelled') return null

    const payload: ParsedDraftWebhookPayload = {
      eventId: typeof raw.eventId === 'string' && raw.eventId.length > 0
        ? raw.eventId
        : buildLegacyDraftWebhookEventId({
            outcome: 'complete',
            matchId: raw.matchId,
            completedAt: raw.completedAt,
            finalized: raw.finalized === true ? true : undefined,
            state: raw.state,
            mapVoteResult: raw.mapVoteResult ?? null,
          }),
      eventKind: explicitEventKind ?? (raw.finalized === true ? 'DraftFinalized' : 'DraftCompleted'),
      eventSequence,
      outcome: 'complete',
      matchId: raw.matchId,
      hostId: typeof raw.hostId === 'string' ? raw.hostId : undefined,
      completedAt: raw.completedAt,
      finalized: raw.finalized === true ? true : undefined,
      state: raw.state,
      mapVoteResult: raw.mapVoteResult ?? null,
    }

    return payload
  }

  if (raw.outcome === 'cancelled') {
    if (typeof raw.cancelledAt !== 'number') return null
    if (raw.reason !== 'cancel' && raw.reason !== 'scrub' && raw.reason !== 'timeout' && raw.reason !== 'revert') return null
    if (raw.state.status !== 'cancelled') return null
    if (explicitEventKind && explicitEventKind !== 'DraftCancelled') return null

    const payload: ParsedDraftWebhookPayload = {
      eventId: typeof raw.eventId === 'string' && raw.eventId.length > 0
        ? raw.eventId
        : buildLegacyDraftWebhookEventId({
            outcome: 'cancelled',
            matchId: raw.matchId,
            cancelledAt: raw.cancelledAt,
            reason: raw.reason,
            state: raw.state,
            mapVoteResult: raw.mapVoteResult ?? null,
          }),
      eventKind: explicitEventKind ?? 'DraftCancelled',
      eventSequence,
      outcome: 'cancelled',
      matchId: raw.matchId,
      hostId: typeof raw.hostId === 'string' ? raw.hostId : undefined,
      cancelledAt: raw.cancelledAt,
      reason: raw.reason,
      state: raw.state,
      mapVoteResult: raw.mapVoteResult ?? null,
    }

    return payload
  }

  return null
}

function parseDraftWebhookEventKind(value: string): DraftWebhookEventKind | null {
  return DRAFT_WEBHOOK_EVENT_KINDS.includes(value as DraftWebhookEventKind)
    ? value as DraftWebhookEventKind
    : null
}

function buildLegacyDraftWebhookEventId(payload: {
  outcome: DraftWebhookPayload['outcome']
  matchId: string
  completedAt?: number
  finalized?: boolean
  cancelledAt?: number
  reason?: string
  state: DraftWebhookPayload['state']
  mapVoteResult: DraftWebhookPayload['mapVoteResult']
}): string {
  const identity = JSON.stringify(payload)
  return `${payload.matchId}:legacy:${hashString(identity)}`
}

function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}
