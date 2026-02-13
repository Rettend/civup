import { describe, expect, test } from 'bun:test'
import {
  addModRole,
  canUseModCommands,
  getModRoleIds,
  hasAdminPermission,
  removeModRole,
} from '../../src/services/permissions.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('permissions service', () => {
  test('recognizes admin permission bits', () => {
    const administratorBit = (1n << 3n).toString()
    const manageGuildBit = (1n << 5n).toString()

    expect(hasAdminPermission({ permissions: administratorBit })).toBe(true)
    expect(hasAdminPermission({ permissions: manageGuildBit })).toBe(true)
    expect(hasAdminPermission({ permissions: '0' })).toBe(false)
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
