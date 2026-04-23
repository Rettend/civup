import type { QueueEntry } from '@civup/game'
import type { LobbyState } from '../services/lobby/types.ts'
import type { OpenSessionRecord, SessionRecord } from './session-record.ts'

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
    const detail = await response.text()
    throw new Error(`Failed to ${command} session aggregate for ${lobby.id}: ${response.status} ${detail}`)
  }

  const body = await response.json<{ record?: SessionRecord }>()
  return body.record ?? null
}
