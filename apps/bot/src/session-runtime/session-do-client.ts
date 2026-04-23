import type { QueueEntry } from '@civup/game'
import type { LobbyState } from '../services/lobby/types.ts'

export async function createSessionAggregateFromLobby(
  namespace: DurableObjectNamespace | null | undefined,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): Promise<boolean> {
  if (!namespace) return false

  const id = namespace.idFromName(lobby.id)
  const stub = namespace.get(id)
  const response = await stub.fetch('https://session.local/commands/create-from-lobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobby,
      queueEntries,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Failed to initialize session aggregate for ${lobby.id}: ${response.status} ${detail}`)
  }

  return true
}
