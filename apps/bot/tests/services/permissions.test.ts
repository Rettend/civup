import type { Env } from '../../src/env.ts'
import { matches } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { command_admin } from '../../src/commands/admin/index.ts'
import { command_mod } from '../../src/commands/mod.ts'
import {
  addModRole,
  ADMIN_COMMAND_DEFAULT_MEMBER_PERMISSIONS,
  canUseModCommands,
  getModRoleIds,
  hasAdminPermission,
  removeModRole,
} from '../../src/services/permissions/index.ts'
import { factory } from '../../src/setup.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('permissions service', () => {
  test('/mod rejects a moderator from another approved server before altering the match', async () => {
    const originGuildId = '111111111111111111'
    const invokingGuildId = '222222222222222222'
    const { db, sqlite } = await createTestDatabase()
    const followups: unknown[] = []
    const backgroundTasks: Promise<unknown>[] = []
    const originalSetTimeout = globalThis.setTimeout

    try {
      await db.insert(matches).values({
        id: 'origin-owned-match',
        guildId: originGuildId,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
      })
      const context: ModCommandTestContext = {
        env: {
          DB: createSqliteD1Database(sqlite),
          KV: createTestKv(),
          DISCORD_TOKEN: 'token',
          ALLOWED_DISCORD_GUILD_ID: originGuildId,
          ALLOWED_DISCORD_GUILD_IDS: invokingGuildId,
        } as Env['Bindings'],
        interaction: {
          guild_id: invokingGuildId,
          member: {
            permissions: (1n << 5n).toString(),
            roles: [],
            user: { id: 'moderator', username: 'Moderator' },
          },
        },
        sub: { string: 'match cancel' },
        var: { match_id: 'origin-owned-match' },
        flags: () => context,
        async resDefer(callback) {
          await callback(context)
          return new Response(null, { status: 200 })
        },
        async followup(payload) {
          followups.push(payload)
          return {}
        },
        executionCtx: {
          waitUntil(promise) {
            backgroundTasks.push(promise)
          },
        },
      }
      globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
        if (typeof callback === 'function') queueMicrotask(callback)
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout

      await command_mod.handler(context as never)
      await Promise.all(backgroundTasks)

      expect(JSON.stringify(followups[0])).toContain('Moderators can only alter sessions that originated in this server.')
      const [stored] = await db.select({ status: matches.status }).from(matches).where(eq(matches.id, 'origin-owned-match')).limit(1)
      expect(stored?.status).toBe('active')
    }
    finally {
      globalThis.setTimeout = originalSetTimeout
      sqlite.close()
    }
  })
  test('recognizes admin permission bits', () => {
    const administratorBit = (1n << 3n).toString()
    const manageGuildBit = (1n << 5n).toString()

    expect(ADMIN_COMMAND_DEFAULT_MEMBER_PERMISSIONS).toBe(manageGuildBit)
    expect(hasAdminPermission({ permissions: administratorBit })).toBe(true)
    expect(hasAdminPermission({ permissions: manageGuildBit })).toBe(true)
    expect(hasAdminPermission({ permissions: '0' })).toBe(false)
  })

  test('registers /admin with manage server default permissions', () => {
    const [registeredAdmin] = factory.getCommands([command_admin]).map(command => command.toJSON())

    expect(registeredAdmin).toMatchObject({
      name: 'admin',
      default_member_permissions: ADMIN_COMMAND_DEFAULT_MEMBER_PERMISSIONS,
    })
  })

  test('configured mod roles can use /mod while non-members cannot', async () => {
    const kv = createTestKv()
    const guildId = 'guild-1'

    await addModRole(kv, guildId, '123456789')
    await addModRole(kv, guildId, '123456789') // duplicate no-op

    const roles = await getModRoleIds(kv, guildId)
    expect(roles).toEqual(['123456789'])

    const allowed = await canUseModCommands({
      kv,
      guildId,
      roles: ['123456789'],
      permissions: '0',
    })
    expect(allowed).toBe(true)

    const denied = await canUseModCommands({
      kv,
      guildId,
      roles: ['987654321'],
      permissions: '0',
    })
    expect(denied).toBe(false)

    const removed = await removeModRole(kv, guildId, '123456789')
    expect(removed.removed).toBe(true)

    const deniedAfterRemove = await canUseModCommands({
      kv,
      guildId,
      roles: ['123456789'],
      permissions: '0',
    })
    expect(deniedAfterRemove).toBe(false)
  })
})

interface ModCommandTestContext {
  env: Env['Bindings']
  interaction: {
    guild_id: string
    member: {
      permissions: string
      roles: string[]
      user: { id: string, username: string }
    }
  }
  sub: { string: string }
  var: Record<string, string | undefined>
  flags: () => ModCommandTestContext
  resDefer: (callback: (context: ModCommandTestContext) => Promise<unknown>) => Promise<Response>
  followup: (payload?: unknown) => Promise<unknown>
  executionCtx: { waitUntil: (promise: Promise<unknown>) => void }
}
