import type { AdminCommandContext } from './types.ts'
import { formatHealthReport, runHealthChecks } from '../../services/health.ts'
import { sendEphemeralResponse } from './shared.ts'

export function handleHealth(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').resDefer(async (deferred: AdminCommandContext) => {
    const results = await runHealthChecks(c.env, { interactionEndpointUrl: c.env.CIVUP_INTERACTION_ENDPOINT_URL })
    await sendEphemeralResponse(deferred, formatHealthReport(results), results.some(result => result.status === 'FAIL') ? 'error' : 'info')
  })
}
