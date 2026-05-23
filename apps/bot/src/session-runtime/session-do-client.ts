import type { CompetitiveTier, DraftSeat, GameMode, QueueEntry } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { ActiveSessionRecord, DraftSessionRecord, SessionRecord } from './session-record.ts'
import { SessionAdmissionError } from '../services/session/directory.ts'

export type SessionOpenLobbyCommand
  = | {
    type: 'set-message'
    expectedVersion?: number
    channelId: string
    messageId: string
    now?: number
  }
  | {
    type: 'set-draft-config'
    expectedVersion?: number
    draftConfig: LobbyDraftConfig
    now?: number
  }
  | {
    type: 'set-min-role'
    expectedVersion?: number
    minRole: CompetitiveTier | null
    now?: number
  }
  | {
    type: 'set-max-role'
    expectedVersion?: number
    maxRole: CompetitiveTier | null
    now?: number
  }
  | {
    type: 'set-steam-lobby-link'
    expectedVersion?: number
    steamLobbyLink: string | null
    now?: number
  }
  | {
    type: 'set-slots'
    expectedVersion?: number
    slots: (string | null)[]
    queueEntries?: QueueEntry[]
    now?: number
  }
  | {
    type: 'set-member-player-ids'
    expectedVersion?: number
    memberPlayerIds: string[]
    queueEntries?: QueueEntry[]
    now?: number
  }
  | {
    type: 'set-last-activity-at'
    expectedVersion?: number
    lastActivityAt: number
    now?: number
  }
  | {
    type: 'arrange-roster'
    expectedVersion?: number
    slots: (string | null)[]
    strategy: LobbyArrangeMarker['strategy']
    at?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'set-roster'
    expectedVersion?: number
    memberPlayerIds: string[]
    slots: (string | null)[]
    lastActivityAt?: number
    now?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'change-mode'
    expectedVersion?: number
    mode: GameMode
    draftConfig: LobbyDraftConfig
    slots: (string | null)[]
    minRole: CompetitiveTier | null
    maxRole: CompetitiveTier | null
    lastActivityAt?: number
    now?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'cancel-open-session'
    expectedVersion?: number
    now?: number
  }

export type SessionDraftLifecycleCommand
  = | {
    type: 'draft-completed'
    opensSwapWindow?: boolean
    at?: number
  }
  | {
    type: 'draft-finalized'
    at?: number
  }
  | {
    type: 'draft-cancelled'
    reason: 'cancel' | 'scrub' | 'timeout' | 'revert'
    at?: number
  }

export type SessionProjectionCommand
  = | {
    type: 'set-message'
    expectedVersion?: number
    channelId: string
    messageId: string
    now?: number
  }
  | {
    type: 'set-steam-lobby-link'
    expectedVersion?: number
    steamLobbyLink: string | null
    now?: number
  }

export type SessionTerminalLifecycleCommand
  = | {
    type: 'mark-reported'
    matchId?: string
    at?: number
    reportedById?: string | null
  }
  | {
    type: 'cancel-session'
    matchId?: string
    at?: number
  }

export interface SessionReportedDiscordSyncCommand {
  matchId?: string
  reason?: string
  at?: number
}

export interface SessionReportClaim {
  matchId: string
  claimId: string
}

export type SessionReportClaimResult
  = | { claimed: true, claim: SessionReportClaim, finalized?: boolean }
    | { claimed: false, processing?: boolean, alreadyReported?: boolean, finalizing?: boolean }

export type SessionDraftLifecycleSyncResult
  = | { ok: true, ignored?: boolean, synced?: boolean }
    | { ok: false, status: number, error: string }

export interface SessionRepeatDraftAvailability {
  kind: 'resume' | 'complete'
  matchId: string
}

export interface SessionRepeatDraftResult {
  kind: 'resume' | 'complete'
  record: DraftSessionRecord | ActiveSessionRecord
  matchId: string
  seats: DraftSeat[]
  participants?: Array<{
    playerId: string
    team: number | null
    civId: string | null
    placement?: number | null
    ratingBeforeMu?: number | null
    ratingBeforeSigma?: number | null
    ratingAfterMu?: number | null
    ratingAfterSigma?: number | null
  }>
}

export async function createSessionAggregateFromLobby(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): Promise<SessionRecord> {
  return postSessionLobbyCommand(namespace, lobby, queueEntries)
}

export async function getSessionRecord(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
): Promise<SessionRecord | null> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/record'))
  if (response.status === 404) return null
  if (!response.ok) await throwSessionCommandError(response, `read session record for ${sessionId}`)

  const body = await response.json<{ record?: SessionRecord }>()
  return body.record ?? null
}

export async function startSessionDraft(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: { expectedVersion?: number, hostId?: string, now?: number } = {},
): Promise<{ record: DraftSessionRecord, matchId: string, seats: DraftSeat[], idempotent?: boolean }> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/start-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `start session draft for ${sessionId}`)
  }

  const body = await response.json<{ record?: SessionRecord, matchId?: string, seats?: DraftSeat[], idempotent?: boolean }>()
  if (body.record?.phase !== 'draft' || typeof body.matchId !== 'string' || !Array.isArray(body.seats)) {
    throw new Error(`Failed to start session draft for ${sessionId}: invalid response`)
  }
  return { record: body.record, matchId: body.matchId, seats: body.seats, idempotent: body.idempotent }
}

export async function getSessionRepeatDraftAvailability(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
): Promise<SessionRepeatDraftAvailability | null> {
  if (!namespace) return null

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/repeat-draft'))
  if (response.status === 404 || response.status === 409) return null
  if (!response.ok) await throwSessionCommandError(response, `read repeat draft availability for ${sessionId}`)

  const body = await response.json<{ repeatDraft?: SessionRepeatDraftAvailability | null }>()
  return body.repeatDraft ?? null
}

export async function repeatSessionDraft(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: { expectedVersion?: number, hostId?: string, now?: number } = {},
): Promise<SessionRepeatDraftResult> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/repeat-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `repeat session draft for ${sessionId}`)
  }

  const body = await response.json<Partial<SessionRepeatDraftResult>>()
  if ((body.kind !== 'resume' && body.kind !== 'complete') || !body.record || typeof body.matchId !== 'string' || !Array.isArray(body.seats)) {
    throw new Error(`Failed to repeat session draft for ${sessionId}: invalid response`)
  }
  if (body.record.phase !== 'draft' && body.record.phase !== 'active') {
    throw new Error(`Failed to repeat session draft for ${sessionId}: invalid record phase`)
  }
  return body as SessionRepeatDraftResult
}

export async function runSessionOpenLobbyCommand(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: SessionOpenLobbyCommand,
): Promise<SessionRecord> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/open-lobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `open lobby command ${command.type} for ${sessionId}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  if (!body.record) throw new Error(`Failed to run open lobby command ${command.type} for ${sessionId}: invalid response`)
  return body.record
}

export async function runSessionDraftLifecycleCommand(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: SessionDraftLifecycleCommand,
): Promise<SessionRecord> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/draft-lifecycle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `run draft lifecycle command ${command.type} for ${sessionId}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  if (!body.record) throw new Error(`Failed to run draft lifecycle command ${command.type} for ${sessionId}: invalid response`)
  return body.record
}

export async function syncSessionDraftLifecyclePayload(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  payload: DraftLifecyclePayload,
): Promise<SessionDraftLifecycleSyncResult> {
  if (!namespace) return { ok: false, status: 503, error: 'SessionDO binding is required' }

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/draft-lifecycle-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))

  const body = await response.json<{ ok?: boolean, ignored?: boolean, synced?: boolean, error?: string }>().catch(() => null)
  if (!response.ok) {
    return { ok: false, status: response.status, error: body?.error ?? `Draft lifecycle sync failed: ${response.status}` }
  }
  if (body?.ok !== true) return { ok: false, status: 500, error: `Draft lifecycle sync for ${sessionId} returned an invalid response` }
  return { ok: true, ignored: body.ignored, synced: body.synced }
}

export async function runSessionProjectionCommand(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: SessionProjectionCommand,
): Promise<SessionRecord> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/session-projection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `run session projection command ${command.type} for ${sessionId}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  if (!body.record) throw new Error(`Failed to run session projection command ${command.type} for ${sessionId}: invalid response`)
  return body.record
}

export async function runSessionTerminalLifecycleCommand(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: SessionTerminalLifecycleCommand,
): Promise<SessionRecord> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/session-lifecycle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `run session lifecycle command ${command.type} for ${sessionId}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  if (!body.record) throw new Error(`Failed to run session lifecycle command ${command.type} for ${sessionId}: invalid response`)
  return body.record
}

export async function queueSessionReportedDiscordSync(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: SessionReportedDiscordSyncCommand = {},
): Promise<void> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/reported-discord-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `queue reported Discord sync for ${sessionId}`)
  }
}

export async function claimSessionReport(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: { matchId?: string, reporterId?: string | null, at?: number } = {},
): Promise<SessionReportClaimResult> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/report-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...command, type: 'claim' }),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `claim report processing for ${sessionId}`)
  }

  const body = await response.json<SessionReportClaimResult>()
  if (body.claimed && body.claim?.claimId && body.claim.matchId) return body
  if (!body.claimed) return body
  throw new Error(`Failed to claim report processing for ${sessionId}: invalid response`)
}

export async function getSessionReportClaimStatus(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: { matchId?: string, at?: number } = {},
): Promise<SessionReportClaimResult> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/report-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...command, type: 'status' }),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `read report processing claim for ${sessionId}`)
  }

  return await response.json<SessionReportClaimResult>()
}

export async function releaseSessionReportClaim(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  claim: SessionReportClaim,
): Promise<void> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(sessionId, '/commands/report-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'release', matchId: claim.matchId, claimId: claim.claimId }),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `release report processing claim for ${sessionId}`)
  }
}

async function postSessionLobbyCommand(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[],
): Promise<SessionRecord> {
  if (!namespace) throw new Error('SessionDO binding is required')

  const id = namespace.idFromName(lobby.id)
  const stub = namespace.get(id)
  const response = await stub.fetch(buildSessionRequest(lobby.id, '/commands/create-from-lobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobby,
      queueEntries,
    }),
  }))

  if (!response.ok) {
    await throwSessionCommandError(response, `create session aggregate for ${lobby.id}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  if (!body.record) throw new Error(`Failed to create session aggregate for ${lobby.id}: invalid response`)
  return body.record
}

function buildSessionRequest(_sessionId: string, pathname: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  return new Request(`https://session.local${pathname}`, {
    ...init,
    headers,
  })
}

async function throwSessionCommandError(response: Response, label: string): Promise<never> {
  let detail = await response.text()
  try {
    const parsed = JSON.parse(detail) as { error?: unknown, playerIds?: unknown }
    if (response.status === 409 && Array.isArray(parsed.playerIds)) {
      throw new SessionAdmissionError(
        typeof parsed.error === 'string' ? parsed.error : 'Player already has a live session',
        parsed.playerIds.filter((playerId): playerId is string => typeof playerId === 'string'),
      )
    }
    if (typeof parsed.error === 'string') detail = parsed.error
  }
  catch (error) {
    if (error instanceof SessionAdmissionError) throw error
  }
  throw new Error(`Failed to ${label}: ${response.status} ${detail}`)
}
