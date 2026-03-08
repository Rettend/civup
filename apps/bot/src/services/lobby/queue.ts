import type { GameMode, QueueState } from '@civup/game'
import type { LobbyState } from './types.ts'
import { parseLobbyState } from './normalize.ts'
import { parseQueueState } from '../queue.ts'
import { stateStoreMget } from '../state-store.ts'

const LOBBY_MODE_KEY_PREFIX = 'lobby:mode:'
const QUEUE_KEY_PREFIX = 'queue:'

export async function getLobbyAndQueueState(
  kv: KVNamespace,
  mode: GameMode,
): Promise<{ lobby: LobbyState | null, queue: QueueState }> {
  const [rawLobby, rawQueue] = await stateStoreMget(kv, [
    { key: `${LOBBY_MODE_KEY_PREFIX}${mode}`, type: 'json' },
    { key: `${QUEUE_KEY_PREFIX}${mode}`, type: 'json' },
  ])

  return {
    lobby: parseLobbyState(rawLobby),
    queue: parseQueueState(mode, rawQueue),
  }
}
