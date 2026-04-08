import { describe, expect, test } from 'bun:test'
import {
  ADMIN_COMMAND_DEFAULT_MEMBER_PERMISSIONS,
  addModRole,
  canUseModCommands,
  getModRoleIds,
  hasAdminPermission,
  removeModRole,
} from '../../src/services/permissions/index.ts'
import { command_admin } from '../../src/commands/admin/index.ts'
import { factory } from '../../src/setup.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('permissions service', () => {
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
