import { afterEach, describe, expect, test } from 'bun:test'
import { getRankedRoleConfig, getRankedRoleDisplayConfig, RANKED_ROLE_CONFIG_KEY_PREFIX, RANKED_ROLE_DISPLAY_REFRESH_INTERVAL_MS, refreshRankedRoleDisplayMetadata, resolveCurrentCompetitiveTierFromRoleIds, setRankedRoleCurrentRoles, setRankedRoleTierCount, updateRankedRoleConfig } from '../../src/services/ranked/roles.ts'
import { createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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

  test('refreshes cached role labels and colors from Discord when due', async () => {
    const kv = createTestKv()
    const guildId = '99999999999999999'
    const roleId = '11111111111111111'
    await updateRankedRoleConfig(kv, guildId, {
      tierRoleIdsByRank: [roleId],
    }, new Map([[roleId, { name: 'Old role', color: '#010203' }]]))
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify([{ id: roleId, name: 'Elite', color: 0xC92A2A }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await refreshRankedRoleDisplayMetadata(kv, guildId, 'token', { now: 1_000 })
    const config = await getRankedRoleDisplayConfig(kv, guildId)

    expect(result).toEqual({ refreshed: true, updated: true, missingRoleIds: [] })
    expect(config.tiers[0]).toEqual({ roleId, label: 'Elite', color: '#C92A2A' })
    expect((await getRankedRoleConfig(kv, guildId)).tiers[0]).toEqual({ roleId, label: 'Old role', color: '#010203' })
    expect(fetchCount).toBe(1)

    const cached = await refreshRankedRoleDisplayMetadata(kv, guildId, 'token', {
      now: 1_000 + RANKED_ROLE_DISPLAY_REFRESH_INTERVAL_MS - 1,
    })
    expect(cached).toEqual({ refreshed: false, updated: false, missingRoleIds: [] })
    expect(fetchCount).toBe(1)
  })

  test('refreshes again after the display metadata interval', async () => {
    const kv = createTestKv()
    const guildId = '99999999999999999'
    const roleId = '11111111111111111'
    await updateRankedRoleConfig(kv, guildId, { tierRoleIdsByRank: [roleId] })
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify([{ id: roleId, name: 'Elite', color: 0 }]), { status: 200 })
    }) as typeof fetch

    await refreshRankedRoleDisplayMetadata(kv, guildId, 'token', { now: 1_000 })
    const result = await refreshRankedRoleDisplayMetadata(kv, guildId, 'token', {
      now: 1_000 + RANKED_ROLE_DISPLAY_REFRESH_INTERVAL_MS,
    })

    expect(result).toEqual({ refreshed: true, updated: false, missingRoleIds: [] })
    expect(fetchCount).toBe(2)
  })

  test('retries on the next call after a failed refresh', async () => {
    const kv = createTestKv()
    const guildId = '99999999999999999'
    const roleId = '11111111111111111'
    await updateRankedRoleConfig(kv, guildId, { tierRoleIdsByRank: [roleId] })
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch

    await expect(refreshRankedRoleDisplayMetadata(kv, guildId, 'token', { now: 1_000 })).rejects.toThrow('Discord fetch guild roles failed: 403 forbidden')

    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: roleId, name: 'Elite', color: 0xC92A2A },
    ]), { status: 200 })) as typeof fetch
    const result = await refreshRankedRoleDisplayMetadata(kv, guildId, 'token', { now: 1_000 })

    expect(result).toEqual({ refreshed: true, updated: true, missingRoleIds: [] })
  })

  test('does not overwrite role mapping changes made while Discord roles are loading', async () => {
    const kv = createTestKv()
    const guildId = '99999999999999999'
    const oldRoleId = '11111111111111111'
    const newRoleId = '22222222222222222'
    await updateRankedRoleConfig(kv, guildId, { tierRoleIdsByRank: [oldRoleId] })
    globalThis.fetch = (async () => {
      await updateRankedRoleConfig(kv, guildId, { tierRoleIdsByRank: [newRoleId] })
      return new Response(JSON.stringify([
        { id: oldRoleId, name: 'Old role', color: 0x010203 },
        { id: newRoleId, name: 'New role', color: 0xAABBCC },
      ]), { status: 200 })
    }) as typeof fetch

    await refreshRankedRoleDisplayMetadata(kv, guildId, 'token', { now: 1_000 })

    expect((await getRankedRoleConfig(kv, guildId)).tiers[0]?.roleId).toBe(newRoleId)
    expect((await getRankedRoleDisplayConfig(kv, guildId)).tiers[0]).toEqual({
      roleId: newRoleId,
      label: 'New role',
      color: '#AABBCC',
    })
  })
})
