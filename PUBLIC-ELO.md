# Public rating and rank architecture

## Responsibilities

Ranked ratings have two separate responsibilities:

- OpenSkill `mu` and `sigma` remain hidden canonical skill state. Match prediction, balancing, provisional protection, anti-farming, quality/evidence gates, and player-civilization adjustment continue to use them.
- `public_rating` is persisted for `global`, `duel`, `duo`, `squad`, `ffa`, and `red-death`. It is the visible Rank Points value, determines public ladder order, and provides the primary score for the visible overall rank.

The public system never feeds back into OpenSkill. Changing public progression, rank boundaries, or demotion protection cannot change match prediction or hidden MMR updates.

## Public progression

New public chains start at exactly `900 RP`. The hidden compatibility score remains anchored at `1000`; these must be separate constants.

For prior public rating `P0`, hidden rating before the match `mu0`, the final hidden result before source weighting `muRaw`, and source weight `w`:

```text
H(mu) = 1000 + 36 * (mu - 25)
D = H(muRaw) - H(mu0)
s = sign(D)
G = max(0, s * (H(mu0) - P0))
core = 25 * tanh(abs(D) / 25)
catchup = min(10, 0.05 * G, 0.05 * D * D)
rawDelta = w * s * min(35, core + catchup)
rawP1 = max(0, P0 + rawDelta)
P1 = apply one-loss rank-boundary protection to rawP1
```

Calculations and storage retain full precision. User-facing formatting rounds normal changes, but a non-zero change below one point must never display as `+0` or `-0`.

Imported matches use `w = 0.5`; live matches use `w = 1`. The public update consumes the pre-import hidden result so source weighting is applied exactly once.

Historical source-weighted hidden events recover the raw result with:

```text
muRaw = muBefore + (muAfter - muBefore) / w
```

Starting below the hidden `1000` anchor is intentional. A new player near average hidden MMR receives mildly favorable gains while their public rank catches up. PPL replay data showed that `900` keeps strong skill correlation without making game volume dominate the ladder; starts of `800` or lower were too grind-sensitive.

## Visible ranks

Players remain `Unranked` until they have at least `8` effective global games. Public RP still updates during this placement period.

Qualified players use fixed boundaries so their rank changes only after their own results, never because another player joined or left the ladder:

| Public RP | Visible rank | Broad Discord role |
| ---: | --- | --- |
| `<650` | Pleb | Pleb |
| `650-724.999...` | Squire III | Squire |
| `725-799.999...` | Squire II | Squire |
| `800-874.999...` | Squire I | Squire |
| `875-949.999...` | Gladiator III | Gladiator |
| `950-1024.999...` | Gladiator II | Gladiator |
| `1025-1099.999...` | Gladiator I | Gladiator |
| `1100-1174.999...` | Legion III | Legion |
| `1175-1249.999...` | Legion II | Legion |
| `1250-1324.999...` | Legion I | Legion |
| `>=1325` | Elite | Elite |

Pleb is intentionally not subdivided. Elite is the single apex tier and displays uncapped total RP, for example `Elite · 1412 RP`. `Champion` is reserved for a future apex or seasonal achievement when the active top population is large enough.

The same fixed rank model can describe mode ratings, but only the qualified global public rating controls the overall visible rank and broad Discord role. Existing evidence caps, quality floors, grace caps, and delayed role demotion remain safeguards around that baseline assignment.

## Boundary protection

Rank changes should not bounce after every game.

- Promotions happen immediately when public RP reaches a boundary.
- On the first loss that would cross below the current division boundary, RP stops exactly at that boundary.
- A later loss from the boundary can demote the player.
- Broad Discord role demotions retain the existing delayed-sync protection.
- RP remains the canonical ladder ordering value; there is no percentile recalculation or hidden adjustment to displayed progress.

The one-loss shield is deterministic from the previous and next RP values, so it does not require extra persisted rank state and can be reconstructed during replay.

## Presentation

User-facing copy calls the value `RP` or `rating`, not Elo or LP.

- Match result: `+24 RP -> 974 RP`
- Division: `Gladiator II · 974 RP`
- Apex: `Elite · 1412 RP`
- Sub-point movement: `+0.4 RP`, never `+0 RP`

Discord continues to manage only the five broad roles. Subdivisions are display metadata and do not create additional Discord roles or lobby-gate values.

## Seasons and inactivity

A season soft reset changes hidden uncertainty and season counters but preserves public RP. Activity-adjusted leaderboard placement can move an inactive top player down the displayed ordering without subtracting RP. Neither behavior mutates hidden `mu`.

## Migration and backfill order

Do not run these steps as part of code review or normal deployment.

1. Deploy the multi-server schema and scoped rating writes first.
2. Apply migration `0024_public_elo.sql` without enabling public reads.
3. Estimate pending chains, direct row updates, and minimum rollout days with the rollout estimator.
4. Export one D1 snapshot and use it for all replay previews and threshold validation. Do not repeatedly scan production.
5. Backfill complete scoped event chains in canonical event order from `900 RP`, then their summary rows. Mirror only the primary PPL stats scope into legacy tables.
6. Process bounded batches below the chosen daily D1 row-write budget. Leave headroom for normal production writes. Old code can continue writing null public snapshots because those chains remain pending.
7. Once the preview reports no pending chains, deploy the dual-write and public-read code while coordinating report traffic.
8. Immediately run a final catch-up pass for any old-code events that landed during cutover, then verify that no public event or summary values remain null.
9. Rebuild leaderboard KV snapshots once, after the final catch-up is complete.

The backfill must replay full chains from `900`; it must not preserve temporary compatibility anchors from hidden display scores. Boundary protection is part of replay, so historical and live chains use exactly the same transition.

The local backfill command remains dry-run by default:

```text
bun run bot:backfill:public-ratings
bun run bot:backfill:public-ratings --execute
```

Remote backfill is also read-only by default and requires `--remote --execute --yes` before it can write. It applies complete chains directly and stops before `--max-writes`.

The PPL rollout estimator requires exactly one source: an existing export or an explicit `--remote` read. Its output includes estimated rows written per stage, safe daily batch size, and minimum rollout days. The rollout procedure is documented in `PUBLIC-RATING-ROLLOUT.md`.
