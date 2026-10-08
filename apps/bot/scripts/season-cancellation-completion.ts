import type { CloudflareD1Statement } from '../../../scripts/cloudflare-client.ts'

export function cancellationCompletionBatch(plan: {
  operationId: string
  generation: number
  cancelledAt: number
  matchIds: string[]
}): CloudflareD1Statement[] {
  const ids = JSON.stringify(plan.matchIds)
  return [
    {
      sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM rating_maintenance WHERE id=1 AND state='paused' AND generation=?)
      AND EXISTS(SELECT 1 FROM rating_mutation_leases WHERE id=? AND match_id=id AND generation=?)
      AND NOT EXISTS(SELECT 1 FROM rating_mutation_leases WHERE id<>?)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) target WHERE
        NOT EXISTS(SELECT 1 FROM matches m JOIN season_match_reports r ON r.match_id=m.id
          WHERE m.id=target.value AND m.status='cancelled' AND r.cancelled_at=?)
        OR NOT EXISTS(SELECT 1 FROM session_directory s WHERE s.match_id=target.value AND s.phase='cancelled')
        OR NOT EXISTS(SELECT 1 FROM match_participants p WHERE p.match_id=target.value)
        OR EXISTS(SELECT 1 FROM match_participants p WHERE p.match_id=target.value AND (p.placement IS NOT NULL OR p.rating_before_mu IS NOT NULL OR p.rating_before_sigma IS NOT NULL OR p.rating_after_mu IS NOT NULL OR p.rating_after_sigma IS NOT NULL))
        OR EXISTS(SELECT 1 FROM player_rating_events e WHERE e.match_id=target.value)
        OR EXISTS(SELECT 1 FROM match_civ_stat_contributions c WHERE c.match_id=target.value)
        OR EXISTS(SELECT 1 FROM match_player_civ_stat_contributions c WHERE c.match_id=target.value))
      THEN 1 ELSE json_extract('Cancellation cleanup is incomplete','$') END AS valid`,
      params: [plan.generation, plan.operationId, plan.generation, plan.operationId, ids, plan.cancelledAt],
    },
    {
      sql: 'DELETE FROM rating_mutation_leases WHERE id=? AND match_id=? AND generation=?',
      params: [plan.operationId, plan.operationId, plan.generation],
    },
  ]
}
