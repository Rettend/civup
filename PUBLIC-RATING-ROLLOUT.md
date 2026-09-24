# Public RP rollout

**Deployment support is implemented; season activation is a separate, owner-approved operation.** The requirements are in [PUBLIC-ELO.md](PUBLIC-ELO.md) and [the season-reset plan](docs/SEASON-RESET.md). Deploy with the additive migrations first. Reporting remains open, existing ratings remain unchanged, and no season is created by deployment. No production migration, cutover, public-read activation, or deployment has been performed for this update.

## Local implementation

The main workspace uses `rp-season-release` on the isolated `e233762f` baseline. The original mixed feature stack remains preserved and unapplied. The new migration, `packages/db/migrations/0023_public_rp_seasons.sql`, extends the existing single-server tables directly after `0022`. It does not include multi-server support or the public website. Migration numbering must be coordinated when that separate work resumes.

Implemented locally:

- The 750 RP scale, rounded display arithmetic, fixed bands, versioned calibration, deterministic opening compression, Elite ordering, and one-rank seed protection.
- A candidate uncertainty-aware movement formula and database-backed replay using saved seeds, recorded order, and calibration/formula versions. Corrections select the report window from the changed match onward and only its participating rating chains; unaffected opening-roster entries are not loaded. Indexed earlier events connect those chains back to their frozen seeds.
- Schema for immutable opening seeds, calibrations, and per-season formula configuration; separate season rating state; report ordering; public events; and disabled public-read and isolated-rating flags. Existing events keep null public values.
- An offline opening planner that carries qualification evidence, freezes both S9 ratings, and keeps late S8 state updates separate in calculation. It has no production apply mode.
- Shared closed-season checks for participant reporting and moderator resolution, cancellation, substitutions, and leader correction. Closed completed-report retries return existing results without repairing history.
- `/stats`, `/rank`, and `/leaders` season selection, including team and leader statistics. Graphs separate legacy history from RP and show a saved opening point before the first game. Historical leader comparisons read closing hidden snapshots instead of today's ratings.
- Evidence-preserving legacy season resets and closing snapshots. These helpers are not the immediate-S9 overlap transition.
- Cancellation prepares mode and global replay before lifecycle changes and submits their rating writes together. Incomplete-report repair and report rollback also combine both rating scopes. Session lifecycle and statistics remain outside that rating batch.
- Opt-in season-isolated reporting writes both rating scopes, participant rating snapshots, seeds for new players, and accepted report order in one guarded D1 batch. Late legacy S8 reports write only S8 rating state. Saved reports can finish lifecycle projections without being rated twice. Moderator result correction, reported-player substitution, and cancellation use seed-aware replay.
- RP result formatting, fixed broad ranks with global evidence gates, RP leaderboard ordering, and Activity player-card values. Hidden ratings still drive balancing and win probabilities; the Activity suppresses legacy predicted rating deltas during the RP era rather than presenting them as RP.
- RP-only gradual qualification: 4 effective global games for initial Pleb/Squire qualification and 6 for Gladiator eligibility. Legion/Elite requirements and legacy qualification remain unchanged. `/tiers` switches from legacy percentages to fixed RP bands and qualification requirements when public reads activate.
- Historical Discord-role ordering with post-write verification. Isolated seasons cannot receive final historical roles before their reporting deadline and database finalization.
- Guarded local cutover and finalization planners with bounded JSON statements, complete rating-source comparisons, conservative write estimates, and verification queries. The cutover freezes independent closing/opening state and preserves lifetime evidence. Finalization reconstructs eligible late legacy reports from the saved closing source, records earned peaks using the saved role configuration, and never writes the new season's ratings or seeds.

The opt-in runtime remains off by default. Legacy replay cannot cross an RP opening. Manual reports/imports remain deliberately unsupported after RP activation. Active substitutions use a serialized SessionDO command that updates the canonical roster, completed draft, and participant projections without changing ratings. An interrupted substitution must finish before reporting or cancellation; retry the same substitution. Unassigned matches cannot bypass season checks after an RP season exists.

### Brief reporting pause

Migration `0024_rating_maintenance.sql` adds a default-open maintenance gate and admitted-writer records. Apply compatible migrations before deploying code that reads the new schema. Deployment does not pause reporting or activate RP.

During the operator-controlled pause, new reports are refused with “Season setup is in progress. Please try again shortly.” They are not accepted or saved; players retry afterward. Drafts still start and complete. Moderator rating changes, legacy replay, manual reporting, resets, and ranked-role writes share the gate. Already-admitted writes can finish. Draft season assignment uses the SessionDO draft-start timestamp, including delayed projection retries.

Authenticated admin endpoints under `/api/activity/admin/rating-maintenance` expose status and generation-checked `paused`/`open` changes. Wait for admitted writers to finish before capturing the cutover source. Reopening refuses outstanding writers. Unexpected outcomes require targeted operator inspection; never assume an old writer record means the write finished. There is no buffered-report queue, drain endpoint, or automatic maintenance recovery.

The ignored local wrapper is `ppl/rating-maintenance.ts`, with `status`, `pause`, and `resume` commands. It requires the operator's Discord ID, a new audit filename, and `--execute` for changes. It uses existing internal Activity authentication, records responses without secrets, and does not apply migrations or activate RP. It has not been run against production.

## Activation prerequisites

Approve the candidate formula, per-scope calibration, opening distribution, and exact cutoff/deadline before applying a season plan. Sparse or tied calibration populations refuse automatic planning and require an explicitly reviewed calibration file; another mode's population is never silently substituted. Synthetic invariants do not establish that the ladder is better.

The revised `rp-v3-candidate` retains target influence at low uncertainty and removes the extra favorite-win taper for RP-season reports only. Newcomer protection reduces only established losers' losses, fading with uncertainty and lifetime experience; reset veterans do not count as newcomers. Legacy S8 reports and repairs retain the old calculation. Division grace remains display-only through `0025_public_rank_badge.sql`. Focused safety checks do not establish long-run population convergence.

Opening Unranked cleanup is a paused operator action before opening-role application. It pages guild members, targets only members holding a current ranked role with fewer than four lifetime effective games, and records Unranked separately from the five broad ranks. Qualified opening assignments remove Unranked automatically. Division roles remain optional future work; no extra Discord division roles are created in this release.

The ignored `ppl/season-cutover.ts` supports capture, offline preview, digest-confirmed apply, verification, opening-role batches, read/cache activation, finalization capture/preview/apply/verification, and historical-role batches. The operator instructions are in ignored `ppl/season-cutover.md`. The source must be captured while reporting is paused and admitted writers have finished. A stale or uncertain apply stops for inspection, not automatic retry or rollback.

Opening roles are applied before public reads, without carrying old pending demotions. Read activation refreshes leaderboard snapshots. Reopening refuses an unfinished writer or an active RP season whose reads are still disabled. Final historical-role assignment runs in small operator-driven batches after database finalization.

Moderator match changes require the current season and a match created no more than 30 days ago. RP replay follows the complete connected downstream report history without fixed match, player, event, state, or statement-count caps. Variable-length selections use JSON bindings and checkpoint writes are split into bounded statements within the same atomic batch. Database per-statement checks and source-consistency guards still apply. Manual imports and extra RP predictions are intentionally outside this release.

The owner confirmed that every existing game, including imports, belongs to S8 from the first recorded game. S8 initialization must not reset or replay those ratings. The S8 cutoff/S9 opening timestamp and its 48-hour reporting deadline still require approval. Use a local maintenance script rather than adding new season commands.

### S8 historical initialization

The local, ignored `ppl/season-history.ts` captures only match identities, dates, and season assignments, then prepares an atomic S8 initialization. PPL database/configuration details belong there, not in tracked application scripts. It works with the existing season columns before or after the public-rating migration. It refuses existing seasons, assigned history, stale captured match identities, oversized batches, and an exceeded write ceiling. It changes no ratings, events, lifecycle state, or Discord roles.

Owner-run commands, **not executed as part of implementation**:

```sh
bun --env-file=.ppl.env ppl/season-history.ts capture --output tmp/s8-source.json
bun ppl/season-history.ts preview --input tmp/s8-source.json --output tmp/s8-plan.json
# Review the plan and its conservative write estimate before confirming its digest.
bun --env-file=.ppl.env ppl/season-history.ts apply --input tmp/s8-source.json --output tmp/s8-apply.json --execute --confirm REVIEWED_DIGEST
bun --env-file=.ppl.env ppl/season-history.ts verify --input tmp/s8-source.json --output tmp/s8-verification.json
```

Each network request saves its response and actual D1 metering. Missing metering is unknown, not zero. If an apply times out, run verification and inspect its saved result rather than blindly rerunning it. Do not remove S8 after new matches begin using it. This tool initializes S8 only; it does not perform the S8/S9 cutover.

## Offline review

Use a fresh output filename; the preview refuses to overwrite an existing artifact:

```sh
bun apps/bot/scripts/preview-rp-season.ts --synthetic --output tmp/rp-synthetic-review.json
bun apps/bot/scripts/preview-rp-season.ts --input tmp/reviewed-opening-input.json --output tmp/rp-opening-review.json
```

Opening input uses `SeasonOpeningInput` from `apps/bot/src/services/season/opening.ts`: distinct source/target season IDs, cutoff, reset factor, source digest, per-scope calibrations, and player hidden ratings, closing roles, qualification evidence, and season counts from the same saved source. A supplied digest is provenance, not proof that a production source is still fresh. The future apply tool must check that independently.

The synthetic September 7 run is saved at `tmp/rp-synthetic-review-20260907.json`: 104,000 transitions across 60 format/source/ability cohorts. It passed finite-value and direction checks. Fixed synthetic opponents do not validate the required PPL convergence or cadence matrix. Strong live-duel cohorts still averaged roughly 1,080–1,100 RP at 30 effective games in that fixture; this is not approval of the candidate formula.

Earlier integration validation on September 7 (before the reporting-pause simplification):

- `bun run check`: all workspace package checks passed.
- Service, embed, and rating tests: 421 passed, zero failed, 112,570 assertions across 50 files.
- Session runtime, routes, and commands: 244 passed; selected Activity helper/store tests: 21 passed. The S8 initialization SQL also passed a small local apply/stale-source rollback check, with no remote calls.
- Capacity regression passed. Relative to the previous foundation commit, the snapshot adds two modeled D1 row reads in measured report paths and no modeled writes. The measured paths do not establish the cost of enabled RP reporting or cutover; production estimates remain separate.
- `git diff --check`: passed.

After the owner confirmed the complete S8 assignment policy, validation was limited to the S8 script's local atomic/stale-source smoke check, focused type checking, and the existing season-report regression file while changing replay selection. No further broad simulation or test expansion was run for that decision.

These checks validate the implemented subset, not the unfinished rollout. The offline tools do not have a remote or execute mode. Production reads/writes, migrations, deployment, reset, and public-read activation remain separate actions requiring the appropriate approval.

The reporting-pause and active-substitution update passed workspace type checks, a subsequent focused bot check, and 42 focused session/season/maintenance tests. The capacity regression passed and its snapshot was refreshed. The cutover update passed workspace checks, the bot dry-run bundle, the Activity production build, and focused season/admin checks. Its local database check includes a stale-source refusal, a late legacy report, and finalization without changing the new season's live ratings. No new broad simulation work was added.

Completed historical repairs are not part of this rollout. **Never rerun a completed cancellation or its saved apply SQL.** Deployment-specific records belong in ignored local maintenance documentation.
