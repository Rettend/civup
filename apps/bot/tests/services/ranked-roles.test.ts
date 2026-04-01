import { describe, expect, test } from 'bun:test'
import { getRankedRoleConfig, RANKED_ROLE_CONFIG_KEY_PREFIX, resolveCurrentCompetitiveTierFromRoleIds, setRankedRoleCurrentRoles, setRankedRoleTierCount, updateRankedRoleConfig } from '../../src/services/ranked/roles.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('ranked role config service', () => {
  test('stores and loads current ranked role mappings', async () => {
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier4: '11111111111111111',
      tier3: '22222222222222222',
    })

    const config = await getRankedRoleConfig(kv, 'guild-1')
    expect(config.tiers).toHaveLength(4)
    expect(config.tiers[3]?.roleId).toBe('11111111111111111')
    expect(config.tiers[2]?.roleId).toBe('22222222222222222')
    expect(config.tiers[1]?.roleId).toBeNull()
    expect(config.tiers[3]?.label).toBeNull()
  })

  test('resolves the highest configured tier from member roles', () => {
    const tier = resolveCurrentCompetitiveTierFromRoleIds(
      ['11111111111111111', '33333333333333333'],
      {
        tiers: [
          { roleId: '44444444444444444', label: null, color: null },
          { roleId: '33333333333333333', label: null, color: null },
          { roleId: '22222222222222222', label: null, color: null },
          { roleId: '11111111111111111', label: null, color: null },
          { roleId: '00000000000000000', label: null, color: null },
        ],
      },
    )

    expect(tier).toBe('tier2')
  })

  test('supports resizing to a custom tier count', async () => {
    const kv = createTestKv()

    const config = await setRankedRoleTierCount(kv, 'guild-1', 3)

    expect(config.tiers).toHaveLength(3)
  })

  test('derives tier count from configured role slots when count is omitted', async () => {
    const kv = createTestKv()

    const config = await updateRankedRoleConfig(kv, 'guild-1', {
      tierRoleIdsByRank: ['11111111111111111', '22222222222222222', '33333333333333333'],
    })

    expect(config.tiers).toHaveLength(3)
    expect(config.tiers[2]?.roleId).toBe('33333333333333333')
  })

  test('drops trailing empty tiers when the lowest configured role is unset', async () => {
    const kv = createTestKv()

    await updateRankedRoleConfig(kv, 'guild-1', {
      tierRoleIdsByRank: ['11111111111111111', '22222222222222222', '33333333333333333', '44444444444444444', '55555555555555555'],
    })

    const config = await updateRankedRoleConfig(kv, 'guild-1', {
      tierRoleIdsByRank: [undefined, undefined, undefined, undefined, null],
    })

    expect(config.tiers).toHaveLength(4)
    expect(config.tiers[3]?.roleId).toBe('44444444444444444')
    expect(config.tiers[4]).toBeUndefined()
  })

  test('normalizes stored configs with trailing empty tiers', async () => {
    const kv = createTestKv()

    await kv.put(`${RANKED_ROLE_CONFIG_KEY_PREFIX}guild-1`, JSON.stringify({
      tiers: [
        { roleId: '11111111111111111', label: 'Role 1', color: null },
        { roleId: '22222222222222222', label: 'Role 2', color: null },
        { roleId: '33333333333333333', label: 'Role 3', color: null },
        { roleId: '44444444444444444', label: 'Role 4', color: null },
        { roleId: null, label: null, color: null },
      ],
    }))

    const config = await getRankedRoleConfig(kv, 'guild-1')

    expect(config.tiers).toHaveLength(4)
    expect(config.tiers[3]?.roleId).toBe('44444444444444444')
    expect(config.tiers[4]).toBeUndefined()
  })
})
