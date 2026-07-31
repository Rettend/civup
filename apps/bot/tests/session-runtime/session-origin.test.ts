import { describe, expect, test } from 'bun:test'
import { buildOpenSessionRecordFromLobby, syncSessionRecordFromLobby } from '../../src/session-runtime/session-record.ts'
import { createLobby } from '../helpers/lobby-runtime.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('session origin identity', () => {
  test('keeps origin guild, channel, and message immutable across open-session syncs', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: '111111111111111111',
      hostId: 'host-1',
      channelId: 'origin-channel',
      messageId: 'origin-message',
    })
    const original = buildOpenSessionRecordFromLobby(lobby)
    const synced = syncSessionRecordFromLobby(original, {
      ...lobby,
      guildId: '222222222222222222',
      channelId: 'other-channel',
      messageId: 'other-message',
      revision: lobby.revision + 1,
      updatedAt: lobby.updatedAt + 1,
    })

    expect(synced.guildId).toBe('111111111111111111')
    expect(synced.channelId).toBe('origin-channel')
    expect(synced.projectionState).toMatchObject({ channelId: 'origin-channel', messageId: 'origin-message' })
  })
})
