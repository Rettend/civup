# Public RP rollout

**Local work in progress; do not deploy or start S9 with this branch yet.** The requirements are in [PUBLIC-ELO.md](PUBLIC-ELO.md) and [the season-reset plan](docs/SEASON-RESET.md). No production migration, cutover, public-read activation, or deployment has been performed for this update.

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
- Cancellation prepares mode and global replay before lifecycle changes and submits their rating writes together. Incomplete-report repair and report rollback also combine both rating scopes. Oversized prepared online replays refuse before rating writes. Session lifecycle and statistics remain outside that rating batch.
- Opt-in season-isolated reporting writes both rating scopes, participant rating snapshots, seeds for new players, and accepted report order in one guarded D1 batch. Late legacy S8 reports write only S8 rating state. Saved reports can finish lifecycle projections without being rated twice. Moderator result correction, reported-player substitution, and cancellation use seed-aware replay.
- RP result formatting, fixed broad ranks with global evidence gates, RP leaderboard ordering, and Activity player-card values. Hidden ratings still drive balancing and win probabilities; the Activity suppresses legacy predicted rating deltas during the RP era rather than presenting them as RP.
- Historical Discord-role ordering with post-write verification. Isolated seasons cannot receive final historical roles before their reporting deadline and database finalization.

The opt-in runtime remains off by default. Legacy replay cannot cross an RP opening. Manual reports and active-session substitutions refuse unsupported season-aware paths before writing data. Unassigned matches cannot bypass the season check after an RP season exists. Do not activate the flags until the remaining cutover and runtime work below is complete.

### Maintenance buffering

Migration `0024_rating_maintenance.sql` adds a default-open maintenance gate, admitted-writer records, and a discovery directory for buffered reports. SessionDO owns each saved result; the directory is only its discovery projection. Normal deployment neither enables buffering nor activates RP. Apply compatible migrations before deploying code that reads the new schema.

Validated participant reports are saved durably during buffering and acknowledged without completing the match. Duplicates retain the first saved result. Discovery projection failures retry through the session alarm, and publishing leases prevent reopening before the saved work is discoverable. Moderator corrections, legacy replay, manual reporting, season resets, and ranked-role writes use the same admission gate. Already-admitted nested operations can finish after buffering begins. Drafts remain open and their season assignment uses the SessionDO draft-start timestamp, including delayed projection retries.

Authenticated admin endpoints under `/api/activity/admin/rating-maintenance` expose status and generation-checked state changes. `/drain` processes one saved report per request through the ordinary report path, preserves its acceptance time, and completes its directory projection afterward. Reopening refuses outstanding writers or buffered reports. An interrupted writer is not assumed finished just because its lease is old; unexpected failures can require owner reconciliation.

The ignored local operator wrapper is `ppl/rating-maintenance.ts`, with `status`, `buffer`, `drain`, and `resume` commands. It requires the operator's Discord ID, a new audit output filename, and `--execute` for changes. It uses the existing internal Activity authentication secret, saves responses without secrets, and does not apply migrations or activate RP. It has not been run against production. Full cutover orchestration and recovery are still unfinished; do not enable maintenance as a substitute for completing them.

## Remaining implementation

1. Finish real overlap operation: integrate the maintenance gate with the cutover source/apply/recovery workflow, late S8 peak handling, and remaining manual/import and active-roster entry points. Buffered results now preserve acceptance beyond the ordinary claim TTL, but this is not yet a complete overlap rollout.
2. Review operational coverage of bounded online replay: 40 reports from the correction onward, 100 affected season states/seeds, 150 rewritten events, 5,000 indexed prefix events, and 400 SQL statements. These are window/affected-chain limits, not total-season roster limits. Older or oversized corrections require local maintenance rather than splitting an atomic repair into partial writes.
3. Complete public presentation and rank integration: audit remaining API consumers and caches, historical earned-peak labels, inactivity ordering, and optional RP outcome previews. Cutover/read activation must refresh cached snapshots so old-era metadata cannot be presented as the current era.
4. Implement the guarded cutover and finalization workflow: buffer reports without pausing drafts, drain admitted writers, use a reviewed frozen source and atomic source validation, install opening summaries and role assignments, capture S8 peaks, update late S8 peaks, and finalize historical roles. Historical-role ordering is implemented separately. The legacy admin start/end commands must not perform this transition.
5. Complete cached-PPL trajectory/cadence simulations and long equal-skill boundary runs. Review convergence, volume bias, distributions, opening-role transitions, and Elite recovery before approving the formula or calibration.
6. Finish the owner-run cutover/finalization tooling and revised metered estimates. The S8 history-initialization script below is implemented; there is still no approved S9 seed apply SQL or production reset command.

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

Local validation on September 7:

- `bun run check`: all workspace package checks passed.
- Service, embed, and rating tests: 421 passed, zero failed, 112,570 assertions across 50 files.
- Session runtime, routes, and commands: 244 passed; selected Activity helper/store tests: 21 passed. The S8 initialization SQL also passed a small local apply/stale-source rollback check, with no remote calls.
- Capacity regression passed. Relative to the previous foundation commit, the snapshot adds two modeled D1 row reads in measured report paths and no modeled writes. The measured paths do not establish the cost of enabled RP reporting or cutover; production estimates remain separate.
- `git diff --check`: passed.

After the owner confirmed the complete S8 assignment policy, validation was limited to the S8 script's local atomic/stale-source smoke check, focused type checking, and the existing season-report regression file while changing replay selection. No further broad simulation or test expansion was run for that decision.

These checks validate the implemented subset, not the unfinished rollout. The offline tools do not have a remote or execute mode. Production reads/writes, migrations, deployment, reset, and public-read activation remain separate actions requiring the appropriate approval.

Completed historical repairs are not part of this rollout. **Never rerun a completed cancellation or its saved apply SQL.** Deployment-specific records belong in ignored local maintenance documentation.
