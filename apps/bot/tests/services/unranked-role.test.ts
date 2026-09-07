import { expect, test } from 'bun:test'
import { applyPendingRankedRoleDiscordChanges, getCurrentRankAssignments, setCurrentRankAssignments } from '../../src/services/ranked/role-sync.ts'
import { getRankedRoleConfig, setRankedRoleTierCount } from '../../src/services/ranked/roles.ts'
import { createTestKv } from '../helpers/test-env.ts'

test('Unranked cleanup and later qualification preserve historical and unrelated roles', async () => {
  const kv = createTestKv()
  const tiers = Array.from({ length: 5 }, (_, i) => ({ roleId: `10000000000000000${i}`, label: null, color: null }))
  const unrankedRoleId = '100000000000000009'
  const playerId = '200000000000000001'
  await kv.put('ranked-roles:config:g', JSON.stringify({ tiers, unrankedRoleId }))
  await setRankedRoleTierCount(kv, 'g', 5)
  expect((await getRankedRoleConfig(kv, 'g')).unrankedRoleId).toBe(unrankedRoleId)
  const roles = new Set([tiers[4]!.roleId, 'historic', 'unrelated'])
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    if (init?.method === 'DELETE') roles.delete(String(input).split('/').at(-1)!)
    else if (init?.method === 'PUT') roles.add(String(input).split('/').at(-1)!)
    else return new Response(JSON.stringify({ roles: [...roles] }), { status: 200 })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  try {
    await setCurrentRankAssignments(kv, 'g', { byPlayerId: { [playerId]: { tier: 'tier5', sourceMode: null, unranked: true, appliedRoleId: tiers[4]!.roleId } } })
    expect((await getCurrentRankAssignments(kv, 'g')).byPlayerId[playerId]?.unranked).toBe(true)
    expect((await applyPendingRankedRoleDiscordChanges({ kv, guildId: 'g', token: 'token' })).pendingChanges).toBe(0)
    expect(roles).toEqual(new Set([unrankedRoleId, 'historic', 'unrelated']))
    await setCurrentRankAssignments(kv, 'g', { byPlayerId: { [playerId]: { tier: 'tier4', sourceMode: null, appliedRoleId: unrankedRoleId } } })
    await applyPendingRankedRoleDiscordChanges({ kv, guildId: 'g', token: 'token' })
    expect(roles).toEqual(new Set([tiers[3]!.roleId, 'historic', 'unrelated']))
  }
  finally { globalThis.fetch = original }
})
