# Public RP implementation plan

## Goal

Add visible Rank Points without replacing hidden OpenSkill or turning rank into a game-volume ladder.

- OpenSkill `mu` and `sigma` remain authoritative for matchmaking, predictions, balancing, anti-farming, provisional protection, and rating direction.
- Public RP provides visible progression, divisions, leaderboard order, and the primary visible rank.
- Strong new players must reach Gladiator quickly. Legion and Elite keep the existing evidence and quality gates.
- Weak players can fall below the starting RP. Only `0 RP` is a hard floor.
- A player's visible RP and fixed rank change only after that player completes a rated match.

This document is the implementation plan. The previously implemented `900 RP` start, 75-point divisions, and hidden-score catch-up formula must not be deployed as-is.

## Rank scale

New public chains start at `750 RP`, the middle of Squire II. Players remain officially `Unranked` until they qualify, but RP changes remain visible from the first game.

| Public RP | Visible rank | Broad Discord role |
| ---: | --- | --- |
| `<600` | Pleb | Pleb |
| `600-699` | Squire III | Squire |
| `700-799` | Squire II | Squire |
| `800-899` | Squire I | Squire |
| `900-999` | Gladiator III | Gladiator |
| `1000-1099` | Gladiator II | Gladiator |
| `1100-1199` | Gladiator I | Gladiator |
| `1200-1299` | Legion III | Legion |
| `1300-1399` | Legion II | Legion |
| `1400-1499` | Legion I | Legion |
| `>=1500` | Elite | Elite |

Pleb is not subdivided. Elite is uncapped. Discord continues to manage only the five broad roles.

Rank boundaries use rounded visible RP. Full-precision storage must never produce a displayed `600 RP` Pleb or similar boundary mismatch.

## Population targets

Keep the deployed PPL rank proportions:

| Hidden standing | Share | Public target band |
| --- | ---: | --- |
| Bottom | 10% | Pleb |
| Next | 50% | Squire |
| Next | 20% | Gladiator |
| Next | 15% | Legion |
| Top | 5% | Elite |

The hidden standings provide a convergence target, not the visible rank itself. Public RP still determines the visible fixed rank.

Fixed thresholds cannot guarantee exact percentages continuously. The target mapping should make the deployed percentages the system's equilibrium while allowing temporary drift. Calibrate hidden-score percentile anchors from an approved snapshot and freeze each mapping version; do not query or recalculate the full population for every match.

## RP movement

The next formula must be versioned and replayable. It should retain these properties:

1. OpenSkill determines whether RP moves up or down and how surprising the result was.
2. Hidden percentile standing maps to a target RP within the fixed bands.
3. Results that move public RP toward the hidden target receive favorable catch-up.
4. Results that move public RP away from the hidden target receive less favorable movement while uncertainty is high.
5. Catch-up decreases with `sigma`; established ratings settle into smaller, more symmetric changes.
6. Expected wins remain protected by the existing anti-farming taper.
7. Imported games apply their `0.5` source weight exactly once.

Candidate movement limits from the local PPL investigation:

| State | Maximum movement |
| --- | ---: |
| Brand new, high uncertainty | about `75 RP` |
| Partially established | about `45-60 RP` |
| Established | about `35 RP` |

With the current candidate target formula, a `750 RP` start produced a mean first live win of about `+30 RP` and a mean first live loss of about `-32 RP`. Final tuning should balance expected movement for equal players, not overfit medians or force population percentages through the starting value.

The exact target interpolation, uncertainty curve, and catch-up strength remain implementation work. Add them only after the simulation matrix and invariants below pass.

## Qualification and safeguards

Keep the deployed safeguards:

- Overall rank remains `Unranked` before `8` effective global games.
- Gladiator is available at `8` effective games.
- Legion remains capped until `16` effective games.
- Elite remains capped until `18` effective games and still requires the existing quality wins.
- Imported games count as `0.5` effective games.
- Existing quality floors, grace caps, delayed Discord-role demotion, and provisional upset protection remain in force.
- The first loss crossing a visible division boundary stops at that boundary; a later loss can demote the player.

These gates can make the overall Discord role differ from a mode's natural public rank. Mode-specific UI must display the mode's own RP rank, as `/stats` does, rather than the gated overall role.

## Presentation

Store and calculate RP at full precision. Display whole RP everywhere:

```text
visibleBefore = round(rawBefore)
visibleAfter = round(rawAfter)
visibleDelta = visibleAfter - visibleBefore
```

Use the rounded total for rank boundaries and the rounded before/after difference for match changes. This keeps displayed arithmetic consistent.

- Match result: `+31 RP -> 781 RP`
- Division: `Squire II · 781 RP`
- Apex: `Elite · 1634 RP`
- If full-precision movement does not change the rounded total, show the unchanged total without decimal or `+0` noise.

User-facing copy calls the value `RP` or `rating`, never Elo or LP.

## Seasons and inactivity

A season soft reset continues to change hidden uncertainty while preserving public RP unless a separate public reset is explicitly designed. Returning players can therefore recalibrate faster without losing their visible history.

Activity-adjusted leaderboard placement may move an inactive top player down the displayed order without subtracting RP or mutating hidden MMR.

## Simulation requirements

Use the cached PPL export and synthetic scenarios. Do not tune directly against production.

For every candidate formula, report:

- mean and p10/median/p90 movement for wins and losses at game 1, games 2-4, 5-8, 9-16, and established play;
- RP after 8, 16, 20, and 30 effective games by eventual hidden tier;
- fastest and slowest real trajectories;
- final public rank distribution versus `10/50/20/15/5`;
- rank agreement and disagreement with hidden standing;
- game-volume correlation after controlling for hidden standing;
- imported-only, mixed-source, duel, team, FFA, expected-win, upset, streak, and season-reset cases.

Required invariants:

- finite, directional updates with a `0 RP` floor;
- no source weight applied twice;
- no expected-win farming regression;
- no hidden matchmaking, prediction, or balancing behavior change;
- strong eight-game starts can reach Gladiator but cannot receive the Legion role before its evidence gate;
- established players can converge into Legion instead of accumulating in Gladiator;
- whole-number display and rank boundaries always agree.

## Migration plan

Migration `0024_public_elo.sql` is still undeployed. Do not deploy, backfill, or enable public reads until this plan is implemented and revalidated.

Existing players must not all be treated as new `750 RP` players. That makes finite game volume distort the initial population. Seed established players from the approved hidden percentile mapping so rollout preserves the current broad rank proportions.

Historical event snapshots and current summary rows must remain internally consistent. Before implementation, choose and validate one deterministic strategy:

1. Replay chronological hidden events against versioned historical or frozen percentile anchors.
2. Derive an initial per-chain seed that replays to the approved current target without breaking the `0` floor or boundary protection.

Do not write summary values that disagree with the final event in their chain. The migration strategy is a release blocker until offline replay proves this consistency.

After that decision, retain the guarded rollout order:

1. Apply migration `0024_public_elo.sql` without enabling public reads.
2. Export one D1 snapshot and use it for all previews and validation.
3. Estimate complete-chain writes and minimum rollout days.
4. Backfill complete event chains and their summary rows in bounded batches.
5. Keep daily backfill writes at or below `60,000`, reserving at least `40,000` of the D1 free daily write limit.
6. Deploy dual writes and public reads only after no chain remains pending.
7. Run one final catch-up pass for events created during cutover.
8. Verify no public event or summary value remains null.
9. Rebuild leaderboard KV snapshots once.

Remote backfill remains read-only by default and requires explicit `--remote --execute --yes` confirmation before it can write.

## Implementation order

1. Replace the current public constants and fixed bands with the agreed scale.
2. Add a versioned frozen hidden-percentile-to-target mapping.
3. Implement uncertainty-aware target convergence without changing hidden OpenSkill updates.
4. Centralize whole-number RP and rank presentation.
5. Update mode-specific UI to use mode RP ranks rather than overall gated roles.
6. Extend focused formula, trajectory, mode, team, FFA, formatting, and role-gate tests.
7. Run the full offline simulation matrix and select final parameters.
8. Resolve deterministic migration seeding and event-history replay.
9. Update `MANUAL.md`, `PUBLIC-RATING-ROLLOUT.md`, and rollout estimates.
10. Only then consider migration and rollout approval.
