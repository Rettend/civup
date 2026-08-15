# Public rating rollout

This procedure adds persisted public Rank Points without changing hidden OpenSkill state. It is a production runbook, not a deployment script. Do not run remote commands during code review.

## Guardrails

- PPL D1 free-tier limits are `100,000` rows written and `5,000,000` rows read per day.
- Use one D1 export for offline estimates and replay validation. Do not repeatedly export or scan production.
- Budget at most `60,000` public-backfill writes per day by default, leaving `40,000` writes for live traffic and variance.
- Process only complete `(stats_key, player_id, mode)` chains. Never split a chain across an invocation.
- Replay every selected chain from `900 RP`; do not preserve temporary or hidden-score anchors.
- Mirror public values to legacy tables only for the primary PPL stats scope.
- Remote backfill writes require `--remote --execute --yes`. Omitting either confirmation keeps the command read-only.
- Do not rebuild leaderboard KV snapshots until D1 backfill and validation are complete.

## Snapshot estimate

The offline PPL ratings export inspected on 2026-08-15 contained:

| Item | Rows |
| --- | ---: |
| Eligible rating events | 67,124 |
| Complete player/mode chains | 3,818 |
| Scoped event updates | 67,124 |
| Scoped summary updates | 3,818 |
| Primary legacy event mirrors | 67,124 |
| Primary legacy summary mirrors | 3,818 |
| Estimated public-backfill writes | 141,884 |

At a `60,000`-write daily budget, the public backfill needs at least three UTC quota days. This excludes migration `0023`, its multi-server data backfill, normal traffic, retries, and the final leaderboard rebuild. Re-estimate from the rollout export immediately before scheduling because live data will increase these counts.

## Estimate commands

Prefer an existing export. This performs no network access:

```text
bun run bot:estimate:public-rating-rollout --export <path-to-d1-export.sql>
```

An aggregate remote estimate is available only with explicit opt-in. Run it at most once when an export is unavailable or stale:

```text
bun --env-file=.ppl.env run bot:estimate:public-rating-rollout --remote --config wrangler.ppl.jsonc
```

The estimator reports per-mode events and chains, the direct-update write count, safe source events per day, minimum rollout days, and missing summary chains. `canBackfill` must be `true`.

## Prerequisites

1. Record the multi-server scoped-write cutoff.
2. Apply migration `0023_multi_server_expand.sql` and complete `backfill-multi-server` under its own capacity budget.
3. Validate that scoped hidden ratings/events match the primary legacy data and that new matches write both representations.
4. Wait for a fresh UTC quota day if the multi-server rollout consumed material D1 writes.
5. Apply migration `0024_public_elo.sql`. It adds nullable public snapshot columns and does not enable public reads by itself.
6. Take one post-migration D1 export and run the offline estimator against it.

Do not combine the multi-server data copy and public-rating replay inside one `100,000`-write day.

## Daily backfill

Preview pending work. This performs aggregate remote reads and no writes:

```text
bun --env-file=.ppl.env run bot:backfill:public-ratings --remote --config wrangler.ppl.jsonc
```

Apply at most `60,000` direct row updates in one invocation:

```text
bun --env-file=.ppl.env run bot:backfill:public-ratings --remote --config wrangler.ppl.jsonc --max-writes 60000 --execute --yes
```

The command replays and writes complete chains, stops before its write budget, and reports `processedWrites` plus remaining chains. It updates scoped event/summary rows directly, mirrors the primary scope directly, and creates no production staging rows. A retry is deterministic: any chain with a null event or summary remains pending and is replayed from 900 again.

Run no more than one budgeted apply per UTC quota day unless current D1 analytics prove enough write headroom remains. Reduce `--max-writes` if normal traffic is above the reserved `40,000` rows.

## Cutover

1. Continue daily applies until the preview reports `pendingChains: 0` and `missingSummaryChains: 0`.
2. Deploy the dual-write code so new global and mode events persist public snapshots. Coordinate the final catch-up with report traffic so an old-code event cannot be inserted between validation and cutover.
3. Immediately run one final preview. If any old-code events landed during cutover, run a small explicitly budgeted catch-up before rebuilding public views.
4. Verify representative event chains are continuous: first `public_rating_before = 900`, every next before equals the previous after, and the summary equals the final after.
5. Verify qualified global ranks around every fixed boundary and confirm hidden `mu`/`sigma` did not change.
6. Rebuild public leaderboard KV snapshots once and refresh configured leaderboard messages through the existing maintenance path.
7. Run ranked-role preview before sync. Confirm only the five broad roles are assigned and then allow normal role synchronization.

## Abort conditions

Stop without enabling public views when any of these occur:

- `missingSummaryChains` is non-zero.
- The estimated or observed write count exceeds the remaining daily quota.
- A chain is discontinuous or does not start at 900.
- Scoped and primary legacy mirrors differ after a completed batch.
- Hidden ratings, predictions, or match balancing change during validation.
- The final preview still has pending chains and the remaining daily headroom is insufficient.

Because public columns are additive and hidden OpenSkill remains canonical, aborting before cutover leaves existing matchmaking behavior intact. Do not roll back by deleting hidden rating history.
