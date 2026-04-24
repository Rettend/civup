import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { OpenSessionRecord, SessionRecord } from './session-record.ts'
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
    type: 'update-open-lobby'
    expectedVersion?: number
    mode?: GameMode
    channelId?: string
    messageId?: string
    steamLobbyLink?: string | null
    minRole?: CompetitiveTier | null
    maxRole?: CompetitiveTier | null
    draftConfig?: LobbyDraftConfig
    slots?: (string | null)[]
    memberPlayerIds?: string[]
    lastArrange?: LobbyArrangeMarker | null
    lastActivityAt?: number
    updatedAt?: number
    queueEntries?: QueueEntry[]
  }
  | {
    type: 'cancel-open-session'
    expectedVersion?: number
    now?: number
  }

export async function createSessionAggregateFromLobby(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): Promise<SessionRecord | null> {
  return await postSessionLobbyCommand(namespace, lobby, queueEntries, 'create-from-lobby')
}

export async function syncSessionAggregateFromLobby(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): Promise<SessionRecord | null> {
  return await postSessionLobbyCommand(namespace, lobby, queueEntries, 'sync-from-lobby')
}

export async function prepareSessionDraftStart(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
): Promise<OpenSessionRecord | null> {
  if (!namespace) return null

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch('https://session.local/commands/prepare-draft-start', {
    method: 'POST',
  })

  if (!response.ok) {
    if (response.status === 404) return null
    const detail = await response.text()
    throw new Error(`Failed to prepare session draft start for ${sessionId}: ${response.status} ${detail}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  return body.record?.phase === 'open' ? body.record : null
}

export async function runSessionOpenLobbyCommand(
  namespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
  command: SessionOpenLobbyCommand,
): Promise<SessionRecord | null> {
  if (!namespace) return null

  const id = namespace.idFromName(sessionId)
  const stub = namespace.get(id)
  const response = await stub.fetch('https://session.local/commands/open-lobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })

  if (!response.ok) {
    await throwSessionCommandError(response, `open lobby command ${command.type} for ${sessionId}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  return body.record ?? null
}

async function postSessionLobbyCommand(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[],
  command: 'create-from-lobby' | 'sync-from-lobby',
): Promise<SessionRecord | null> {
  if (!namespace) return null

  const id = namespace.idFromName(lobby.id)
  const stub = namespace.get(id)
  const response = await stub.fetch(`https://session.local/commands/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobby,
      queueEntries,
    }),
  })

  if (!response.ok) {
    await throwSessionCommandError(response, `${command} session aggregate for ${lobby.id}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  return body.record ?? null
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
