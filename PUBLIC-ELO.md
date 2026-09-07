# Public RP implementation plan

## Goal

Add visible Rank Points without replacing hidden OpenSkill or turning rank into a game-volume ladder.

- OpenSkill `mu` and `sigma` remain authoritative for matchmaking, predictions, balancing, anti-farming, provisional protection, and rating direction.
- Public RP provides visible progression, divisions, leaderboard order, and the primary visible rank.
- Strong new players must reach Gladiator quickly. Legion and Elite keep the existing evidence and quality gates.
- Weak players can fall below the starting RP. Only `0 RP` is a hard floor.
- A player's visible RP and fixed rank change only after that player completes a rated match.
- Season 9 starts a versioned public-RP epoch from deterministic opening seeds. Pre-S9 matches remain authoritative hidden-rating history but do not receive invented historical RP.

This document is the implementation plan. The previously implemented `900 RP` start, 75-point divisions, and hidden-score catch-up formula must not be deployed as-is.

The isolated implementation is **not ready for deployment or season cutover**. See [local implementation status and remaining work](PUBLIC-RATING-ROLLOUT.md). In particular, the candidate formula is not approved, and the live overlap/report/replay integration is unfinished.

See [S8 close and S9 reset](docs/SEASON-RESET.md) for the reporting window, closed-season lock, qualification carryover, season numbering, historical command views, and cost decisions. The selected schedule opens S9 immediately while unfinished S8 matches have 48 hours to report into separate S8 state. Both hidden and public S9 starting ratings remain frozen.

All existing history, including imported games, belongs to S8 from the earliest recorded game. Initialize that assignment without resetting ratings. The transition can use a local PPL maintenance script; new season commands are not required. Divisions remain display labels, not additional Discord roles.

## Release scope

The update includes public RP, season handling, and the rating-correction safeguards needed for them. It excludes the undeployed multi-server feature, the public PPL website, and unrelated draft/tournament changes. Build on the existing single-server rating tables; do not require `0023_multi_server_expand.sql` or scoped multi-server tables.

Port relevant parts of the old RP implementation selectively. Its full commits depend on multi-server code and are not a safe release dependency. Keep unrelated work preserved on unapplied branches. Local implementation and branch organization do not authorize deployment, production migrations, or a season reset.

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

The percentages are long-run calibration targets, not daily quotas. RP and rank do not change merely because another player joined, left, or completed a match.

## Season 9 opening reset

Season 9 is the first public-RP epoch. Existing players must not all start at `750 RP`, and public RP must not be fabricated for every pre-S9 match.

### Opening target and compression

For each qualified player's global chain:

1. Calculate a no-reset target RP from the frozen hidden-standing calibration. Within each broad rank, preserve hidden-score order across that rank's full RP band.
2. Compress that target 15% toward the `750 RP` new-player center:

   ```text
   compressedSeed = 750 + 0.85 * (targetRP - 750)
   ```

3. Place every closing S8 Elite in `1400-1449 RP`, preserving their order within Elite. They open in Legion I with `51-100 RP` left to reclaim Elite at `1500 RP`.
4. Do not allow the opening seed to place anyone more than one broad rank below their closing S8 managed role. A player caught by this guard starts in the previous role's top division, ordered by hidden standing.
5. Preserve full precision in storage and use rounded RP for the displayed rank.

This is a real soft reset rather than a flat point tax. Players below the center move toward it, while increasingly strong players give back progressively more RP. Bottom Gladiators and Legions can naturally cross into Squire I and Gladiator I; Squire is not emptied below the `750 RP` new-player start.

The compression factor and Elite override are part of the seed version. Freeze them at cutover and never silently recalculate existing seeds from a newer population.

Players without enough evidence for a reliable opening target start at `750 RP`, remain `Unranked` until qualified, and still see every RP change.

Mode chains are seeded separately from their mode-specific hidden standings and eligibility. They never inherit the overall Discord role.

The working reset envelope is:

| Hidden-band position | No-reset target | S9 opening RP | Opening rank | Difference |
| --- | ---: | ---: | --- | ---: |
| Bottom Pleb | 300 | 368 | Pleb | `+68` |
| Top Pleb | 599 | 622 | Squire III | `+23` |
| Bottom Squire | 600 | 623 | Squire III | `+23` |
| Top Squire | 899 | 877 | Squire I | `-22` |
| Bottom Gladiator | 900 | 878 | Squire I | `-22` |
| Top Gladiator | 1199 | 1132 | Gladiator I | `-67` |
| Bottom Legion | 1200 | 1133 | Gladiator I | `-67` |
| Top Legion | 1499 | 1387 | Legion II | `-112` |
| Bottom Elite | 1500 | 1400 | Legion I | `-100` |
| Top Elite | 1599 | 1449 | Legion I | `-150` |

These differences compare the opening seed with a hypothetical no-reset public target. No public RP existed in S8, so they are calibration measurements rather than points visibly removed from a player's account.

### Why not subtract one or two divisions

A flat subtraction is deflation, not compression. It pushes weak players down as much as strong players, puts a new `750 RP` player above much of the returning Squire population, and gives almost everyone an artificial climb-back gap toward unchanged hidden targets.

The cached PPL snapshot through 2026-08-06 contained 592 qualified global players. The following reconstruction uses the target `10/50/20/15/5` hidden bands and is illustrative; the final cutover requires a fresh frozen D1 and KV snapshot.

| Opening policy | Pleb | Squire | Gladiator | Legion | Elite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Literal `-100 RP` | 26.7% | 39.9% | 18.4% | 15.0% | 0.0% |
| Literal `-200 RP` | 43.2% | 30.1% | 16.6% | 10.1% | 0.0% |
| 15% compression toward 750, plus Elite override | 9.0% | 52.7% | 22.3% | 16.0% | 0.0% |

Under the reconstructed hidden bands, all Squires remained Squire, the bottom 8.5% of Gladiators opened in Squire I, the bottom 27.0% of Legions opened in Gladiator I, and all Elites opened in Legion I. The final managed-role guard may retain a small number of additional players one rank higher.

### Season roles

Before live S9 roles change, capture S8 peak/rank state. After the 48-hour S8 reporting window, finalize historical roles as `S8 Pleb`, `S8 Squire`, `S8 Gladiator`, `S8 Legion`, or `S8 Elite` using S8's season-peak behavior, including late S8 results. S9 live roles must not determine S8 achievements, and finalizing S8 must not change S9 opening ratings.

Historical roles must sit below all live S9 ranked roles in Discord's role order. The live roles remain simply `Pleb`, `Squire`, `Gladiator`, `Legion`, and `Elite`.

## RP movement

The next formula must be versioned and replayable. It should retain these properties:

1. OpenSkill determines whether RP moves up or down and how surprising the result was.
2. Hidden percentile standing maps to a target RP within the fixed bands.
3. Results that move public RP toward the hidden target receive favorable catch-up.
4. Results that move public RP away from the hidden target receive less favorable movement while uncertainty is high.
5. Catch-up decreases as `sigma` falls and the system becomes more certain; established ratings settle into smaller, more symmetric changes.
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

At the S9 boundary, keep hidden `mu` and restore the configured share of hidden `sigma`. Current results therefore recalibrate skill faster without replacing the hidden matchmaking history.

The inaugural S9 seed reset is explicit and versioned. Later seasons preserve public RP by default unless another public reset is separately designed, previewed, and approved.

Activity-adjusted leaderboard placement may move an inactive top player down the displayed order without subtracting RP or mutating hidden MMR.

## Simulation requirements

Use the cached PPL export and synthetic scenarios. Do not tune directly against production.

For every candidate formula, report:

- mean and p10/median/p90 movement for wins and losses at game 1, games 2-4, 5-8, 9-16, and established play;
- RP after 8, 16, 20, and 30 effective games by eventual hidden tier;
- fastest and slowest real trajectories;
- final public rank distribution versus `10/50/20/15/5`;
- opening transition counts from each closing S8 role, including every one-rank guard application;
- projected distributions after 1, 7, 14, and 30 days using historical PPL participation cadence;
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
- no opening seed demotes a player by more than one broad rank from the closing S8 managed role;
- the top former Elites need at least about two ordinary wins to reclaim Elite, while the cohort performing at Elite level normally recovers within roughly `2-8` rated S9 games depending on its opening position and results;
- whole-number display and rank boundaries always agree.

## Migration plan

The old `0024_public_elo.sql` is still undeployed and depends on the excluded multi-server migration. Replace it with an RP/season migration that applies directly after production's `0022` baseline; do not copy the scoped-table alterations. Coordinate migration numbering when the separate multi-server work is resumed. Do not deploy, backfill, or enable public reads until this plan is implemented and revalidated.

Store a durable opening seed per season, player, and rating scope (`global` or a mode) using the existing single-server schema. Each seed must include:

- full-precision opening RP;
- effective timestamp and source season;
- formula and calibration version;
- hidden snapshot inputs needed to audit the seed;
- closing S8 managed role and any one-rank guard reason.

Normal S9 match reporting reads the current summary, calculates one transition, updates that summary, and appends an event with RP before and after. It does not replay the player's full history after every match.

Current-season correction and repair paths rebuild public RP from the saved opening seed and replay public-era events in their recorded order using their saved formula/calibration versions. Respect the closed-season and hidden starting-state rules in the reset plan. Past-season corrections are local-only; there is no moderator/API bypass that changes finalized history or S9 opening seeds.

The final public event in a chain and its summary row must always agree. Pre-S9 events keep null public values rather than receiving fabricated RP.

Use this guarded rollout order:

1. Finalize the seed schema, calibration, movement formula, and seed-aware recalculation path.
2. Generate a complete offline player report from one cached snapshot: closing role, hidden target, opening RP/rank, reset amount, and guard reason.
3. Pass replay, correction, deletion, and summary/event consistency tests locally.
4. Apply the amended migration without enabling public reads.
5. Approve the S8 cutoff/S9 opening time and the S8 reporting deadline 48 hours later.
6. Capture one frozen D1 and KV snapshot at cutover, preserve separate S8 state, and approve the complete opening report using the ratings and managed roles recorded then.
7. Briefly pause rating mutations and drain in-flight reports while installing frozen hidden/public opening seeds and current summaries. Start dual-writing S9 public events behind the read flag without leaving an untracked gap. New ranked games belong to S9 immediately; late S8 reports update only S8.
8. Run in shadow mode and compare actual match changes, role movement, and recalculation output. Rebuild from the seeds if pre-launch tuning changes.
9. Complete cutover catch-up, verify no public-era value is missing, confirm event/summary agreement, and rebuild leaderboard KV snapshots once.
10. Only then enable public reads and apply approved opening roles, followed by normal live-role sync.
11. After the S8 reporting deadline, finalize S8 ranked achievements and historical `S8 ...` roles from S8 state without reseeding or replaying S9.

There is no player-facing message that public RP began in S9. The seed boundary is an internal replay detail.

Remote backfill remains read-only by default and requires explicit `--remote --execute --yes` confirmation before it can write.

## Implementation order

1. Replace the current public constants and fixed bands with the agreed scale.
2. Add a versioned frozen hidden-percentile-to-target mapping and the S9 seed compression policy.
3. Add durable public seed storage and seed-aware replay without changing hidden OpenSkill history.
4. Implement uncertainty-aware target convergence without changing hidden OpenSkill updates.
5. Centralize whole-number RP and rank presentation.
6. Keep mode-specific UI on mode RP ranks rather than overall gated roles.
7. Add explicit Discord ordering for historical season roles below live ranked roles.
8. Extend focused formula, trajectory, seed, replay, mode, team, FFA, formatting, and role-gate tests.
9. Run the complete offline simulation and player-level reset preview, then freeze the S9 parameters.
10. Update `MANUAL.md`, `PUBLIC-RATING-ROLLOUT.md`, and rollout estimates.
11. Only then consider migration, shadow writing, and public-read approval.
