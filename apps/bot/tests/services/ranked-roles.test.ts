import { describe, expect, test } from 'bun:test'
import { getRankedRoleConfig, resolveCurrentCompetitiveTierFromRoleIds, setRankedRoleCurrentRoles } from '../../src/services/ranked-roles.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('ranked role config service', () => {
  test('stores and loads current ranked role mappings', async () => {
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      squire: '11111111111111111',
      gladiator: '22222222222222222',
    })

    const config = await getRankedRoleConfig(kv, 'guild-1')
    expect(config.currentRoles.pleb).toBeNull()
    expect(config.currentRoles.squire).toBe('11111111111111111')
    expect(config.currentRoles.gladiator).toBe('22222222222222222')
    expect(config.currentRoles.legion).toBeNull()
    expect(config.currentRoleMeta.squire.label).toBeNull()
  })

  test('resolves the highest configured tier from member roles', () => {
    const tier = resolveCurrentCompetitiveTierFromRoleIds(
      ['11111111111111111', '33333333333333333'],
      {
        currentRoles: {
          pleb: '00000000000000000',
          squire: '11111111111111111',
          gladiator: '22222222222222222',
          legion: '33333333333333333',
          champion: '44444444444444444',
        },
        currentRoleMeta: {
          pleb: { label: null, color: null },
          squire: { label: null, color: null },
          gladiator: { label: null, color: null },
          legion: { label: null, color: null },
          champion: { label: null, color: null },
        },
      },
    )

    expect(tier).toBe('legion')
  })
})
