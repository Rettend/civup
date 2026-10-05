import { expect, test } from 'bun:test'
import { planHistoricalRoleOrder } from '../../src/services/season/role-order.ts'

test('historical role ordering moves only historical roles below every live rank and refuses overlapping or unavailable roles', () => {
  const roles = [
    { id: 'everyone', position: 0 },
    { id: 'live-low', position: 1 },
    { id: 'unrelated', position: 2 },
    { id: 's8-low', position: 3 },
    { id: 'live-high', position: 4 },
    { id: 's8-high', position: 5 },
  ]
  expect(planHistoricalRoleOrder(roles, ['s8-high', 's8-low'], ['live-low', 'live-high'])).toEqual([
    { id: 's8-low', position: 1 },
    { id: 's8-high', position: 2 },
  ])
  const ordered = roles.map(role => ({
    ...role,
    position: role.id === 's8-low' ? 1 : role.id === 's8-high' ? 2 : role.position + 3,
  }))
  expect(planHistoricalRoleOrder(ordered, ['s8-low', 's8-high'], ['live-low', 'live-high'])).toEqual([])
  expect(() => planHistoricalRoleOrder(roles, ['s8-low'], ['s8-low'])).toThrow('distinct')
  expect(() => planHistoricalRoleOrder(roles, ['missing'], ['live-low'])).toThrow('missing')
  expect(() =>
    planHistoricalRoleOrder(
      roles.map(role => ({ ...role, managed: true })),
      ['s8-low'],
      ['live-low'],
    ),
  ).toThrow('integration role')
})
