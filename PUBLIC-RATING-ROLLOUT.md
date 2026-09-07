# Public RP rollout

**Local work in progress; do not deploy or start S9 with this branch yet.** The requirements are in [PUBLIC-ELO.md](PUBLIC-ELO.md) and [the season-reset plan](docs/SEASON-RESET.md). No production migration, cutover, public-read activation, or deployment has been performed for this update.

## Local implementation

The main workspace uses `rp-season-release` on the isolated `e233762f` baseline. The original mixed feature stack remains preserved and unapplied. The new migration, `packages/db/migrations/0023_public_rp_seasons.sql`, extends the existing single-server tables directly after `0022`. It does not include multi-server support or the public website. Migration numbering must be coordinated when that separate work resumes.

Implemented locally:

- The 750 RP scale, rounded display arithmetic, fixed bands, versioned calibration, deterministic opening compression, Elite ordering, and one-rank seed protection.
- A candidate uncertainty-aware movement formula and pure public replay using saved seeds, recorded order, and calibration/formula versions. This is not yet the database correction path.
- Schema for immutable opening seeds and calibrations, separate season rating state, report ordering, public events, and a disabled public-read flag. Existing events keep null public values.
- An offline opening planner that carries qualification evidence, freezes both S9 ratings, and keeps late S8 state updates separate in calculation. It has no production apply mode.
- Shared closed-season checks for participant reporting and moderator resolution, cancellation, substitutions, and leader correction. Closed completed-report retries return existing results without repairing history.
- `/stats`, `/rank`, and `/leaders` season selection, including team and leader statistics. Graphs separate legacy history from RP and show a saved opening point before the first game. Historical leader comparisons read closing hidden snapshots instead of today's ratings.
- Evidence-preserving legacy season resets and closing snapshots. These helpers are not the immediate-S9 overlap transition.
- Cancellation prepares mode and global replay before lifecycle changes and submits their rating writes together. Incomplete-report repair and report rollback also combine both rating scopes. Oversized prepared online replays refuse before rating writes. Session lifecycle and statistics remain outside that rating batch.

The unfinished overlap paths deliberately refuse RP reports/corrections and legacy replay across an RP opening. Unassigned matches cannot bypass the season check after an RP season exists. Do not remove these stops merely to get reports flowing; finish and test the season-isolated implementation first.

## Remaining implementation

1. Integrate season state with real report claims and D1 writes. Persist the accepted time and stable order, reject stale rating summaries atomically, support retries across the deadline, and keep late S8 writes away from every S9 summary, seed, cache, and live-role update. Validate all manual/import and API entry points as well as Discord commands.
2. Implement database-backed current-season correction from frozen hidden/public seeds. A no-op replay must reproduce normal reporting, including out-of-start-order results, retries, deletion, and participant changes. Preserve recorded quality evidence and formula/calibration versions. Do not substitute the legacy all-history replay.
3. Complete public presentation and rank integration: match/recent-result RP, all Activity/API consumers, RP leaderboard ordering, overall evidence/quality gates, mode eligibility, historical earned-peak labels, and inactivity ordering. The current command work alone is not full public-read readiness.
4. Implement the guarded cutover and finalization workflow: mutation pause/drain, a reviewed frozen source, atomic source validation, opening summaries and role assignments, S8 peak capture, late S8 peak updates, final historical-role assignment, and Discord role ordering below live roles. The legacy admin start/end commands must not perform this transition.
5. Complete cached-PPL trajectory/cadence simulations and long equal-skill boundary runs. Review convergence, volume bias, distributions, opening-role transitions, and Elite recovery before approving the formula or calibration.
6. Build and validate the owner-run preview/apply/verification tooling and revised metered estimates. There is currently no approved S8 assignment SQL, seed apply SQL, or production reset command in this update.

The saved successful repair source had no season records. Confirm the real S8 start date and imported-match policy; do not assign every unassigned game to S8. The S8 cutoff/S9 opening timestamp and its 48-hour reporting deadline also still require approval.

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
- Service, embed, and rating tests: 406 passed, zero failed, 112,471 assertions across 47 files.
- Capacity regression: passed, 9,065 assertions. Relative to the isolated baseline, the snapshot adds one modeled D1 row read to the measured report paths and does not add modeled writes. This is not a production usage estimate.
- `git diff --check`: passed.

These checks validate the implemented subset, not the unfinished rollout. The offline tools do not have a remote or execute mode. Production reads/writes, migrations, deployment, reset, and public-read activation remain separate actions requiring the appropriate approval.

The historical cancellation of `DiRufV9GvDw2` is already complete and verified. **Never rerun it or its saved apply SQL as part of this rollout.**
