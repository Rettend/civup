# Public Elo architecture

Mode ratings have two separate responsibilities:

- OpenSkill `mu` and `sigma` remain hidden canonical skill state. Match prediction, balancing, provisional protection, ranked-role assignment, quality/evidence gates, global ratings, and player-civilization adjustment continue to use them.
- `public_rating` is persisted per stats scope and leaderboard mode (`duel`, `duo`, `squad`, `ffa`, and `red-death`). It is the visible Elo and determines public mode ladder order. The internal `global` scope never receives a public rating.

New public chains start at exactly 1000. A season soft reset changes hidden uncertainty and season counters but preserves public Elo.

## Version 1 transition

For prior public rating `P0`, hidden rating before the match `mu0`, the final hidden result before source weighting `muRaw`, and source weight `w`:

```text
H(mu) = 1000 + 36 * (mu - 25)
D = H(muRaw) - H(mu0)
s = sign(D)
G = max(0, s * (H(mu0) - P0))
core = 25 * tanh(abs(D) / 25)
catchup = min(10, 0.05 * G, 0.05 * D * D)
delta = w * s * min(35, core + catchup)
P1 = max(0, P0 + delta)
```

Calculations and storage retain full precision. User-facing formatting rounds only for presentation. Imported matches use `w = 0.5`; live matches use `w = 1`. The public update consumes the pre-import hidden result so source weighting is applied exactly once.

Historical source-weighted hidden events recover the raw result with:

```text
muRaw = muBefore + (muAfter - muBefore) / w
```

## Migration and backfill order

Do not run these steps as part of a code review. The rollout order is:

1. Apply migration `0024_public_elo.sql`.
2. Start code that dual-writes scoped and primary-scope legacy public summaries/events.
3. Backfill all scoped mode event chains in canonical event order, then their existing summary rows. Mirror only the primary PPL stats scope into legacy tables.
4. Rebuild leaderboard KV snapshots. Snapshot version 4 rejects older hidden-score snapshots automatically.

The transition is safe before backfill completes: null summary/event values resolve to the old `H(mu)` score for display, while every newly written public event establishes an authoritative persisted chain. Backfill fills only null values and treats populated events as chain anchors, so it cannot overwrite ratings written after migration. Boundary replay reconstructs earlier null snapshots from public 1000 and stored event source evidence.

The provided command targets migrated local D1 storage only and never accesses remote data:

```text
bun run bot:backfill:public-ratings
bun run bot:backfill:public-ratings --execute
```

It processes complete player/mode chains in batches, bulk-stages updates, is idempotent, and resumes by selecting chains that still contain null snapshots or summaries. It stops if an event chain has no summary row, because that inconsistency requires a full rating replay first. Use `--batch-size N` to change the chain batch size and `--primary-guild-id ID` to override primary legacy mirroring.
