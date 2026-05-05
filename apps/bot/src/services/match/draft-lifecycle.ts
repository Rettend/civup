import type { DraftLifecyclePayload } from '../../session-runtime/draft-lifecycle-events.ts'
import { syncSessionDraftLifecyclePayload } from '../../session-runtime/session-do-client.ts'

export interface DraftLifecycleEnv {
  SessionDO?: DurableObjectNamespace | null
}

export type DraftLifecycleResult
  = | { ok: true, ignored?: boolean, synced?: boolean }
    | { ok: false, status: number, error: string }

export async function handleDraftLifecyclePayload(
  env: DraftLifecycleEnv,
  payload: DraftLifecyclePayload,
): Promise<DraftLifecycleResult> {
  console.log('[draft-lifecycle] received', buildDraftLifecycleContext(payload))
  return syncSessionDraftLifecyclePayload(env.SessionDO, payload.matchId, payload)
}

function buildDraftLifecycleContext(payload: DraftLifecyclePayload): Record<string, unknown> {
  return {
    eventId: payload.eventId,
    eventKind: payload.eventKind,
    eventSequence: payload.eventSequence,
    matchId: payload.matchId,
    outcome: payload.outcome,
    finalized: payload.outcome === 'complete' ? payload.finalized === true : false,
    stateStatus: payload.state.status,
    currentStepIndex: payload.state.currentStepIndex,
  }
}
