import { describe, expect, test } from 'bun:test'
import { main as cancelSeasonMatches } from '../../scripts/cancel-season-matches.ts'
import { main as reconcileCompletedLeases } from '../../scripts/reconcile-completed-rating-leases.ts'

describe('maintenance command target selection', () => {
  test('cancellation preview requires an explicit target before reading settings', async () => {
    await expect(cancelSeasonMatches(['preview'])).rejects.toThrow('--target')
    await expect(cancelSeasonMatches(['preview', '--target', '../outside'])).rejects.toThrow()
    await expect(cancelSeasonMatches(['preview', '--target', 'team-archive'])).rejects.toThrow('--season')
  })

  test('completed lease preview requires an explicit target before reading settings', async () => {
    await expect(reconcileCompletedLeases(['preview'])).rejects.toThrow('--target')
    await expect(reconcileCompletedLeases(['preview', '--target', '../outside'])).rejects.toThrow()
    await expect(reconcileCompletedLeases(['preview', '--target', 'team-archive'])).rejects.toThrow('lease IDs')
  })

  test.each(['apply', 'finish', 'pause', 'resume', 'recover-finish'])(
    'cancellation %s still requires execution approval',
    async command => {
      await expect(cancelSeasonMatches([command, '--target', 'alternate'])).rejects.toThrow('--execute')
    },
  )

  test('completed lease changes still require execution approval', async () => {
    await expect(reconcileCompletedLeases(['apply', '--plan', 'fixture-plan.json'])).rejects.toThrow('--execute')
  })
})
