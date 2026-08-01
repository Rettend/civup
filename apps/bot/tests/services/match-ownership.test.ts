import { matches, sessionDirectory } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { resolveMatchOriginGuildId } from '../../src/services/session/index.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('stored match ownership', () => {
  test('uses permanent match ownership instead of a contradictory session projection', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(matches).values({
        id: 'owned-match',
        guildId: '222222222222222222',
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
      })
      await db.insert(sessionDirectory).values({
        sessionId: 'stable-session',
        phase: 'active',
        mode: '1v1',
        guildId: '111111111111111111',
        channelId: 'channel',
        hostId: 'host',
        messageId: 'message',
        matchId: 'owned-match',
        version: 1,
        rosterJson: '{}',
        configJson: '{}',
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      })

      await expect(resolveMatchOriginGuildId(db, 'owned-match')).resolves.toBe('222222222222222222')
    }
    finally {
      sqlite.close()
    }
  })

  test('fails closed for an ownerless match during the nullable rollout window', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(matches).values({ id: 'ownerless-match', guildId: null, gameMode: '1v1', status: 'active', createdAt: 1 })
      await expect(resolveMatchOriginGuildId(db, 'ownerless-match')).rejects.toThrow('missing owning-server data')
    }
    finally {
      sqlite.close()
    }
  })
})
