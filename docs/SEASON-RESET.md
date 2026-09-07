# S8 close and S9 reset plan

This records the season, history, command, and cost decisions alongside [the public RP plan](../PUBLIC-ELO.md). It is not permission to deploy, reset a season, or run a database conversion.

The release scope and exclusions are in [the public RP plan](../PUBLIC-ELO.md#release-scope). Current implementation status and remaining work are in [the rollout notes](../PUBLIC-RATING-ROLLOUT.md); the selected reporting schedule below has not been activated.

## Before the reset

Finish approved historical corrections before taking the final S8 snapshot. Do not calculate S9 opening ratings from data that is still being repaired.

**Completed September 7, 2026 at 02:14:26 UTC:** the owner applied the combined historical repair and cancellation of `DiRufV9GvDw2`. Full post-apply checks passed for the cancellation, rating events, current summaries, participant snapshots, statistics aggregates, and dirty scopes. The repair is no longer a blocker for implementing the public RP and season-reset plans. The prevention code remains local and undeployed; no season reset or public-rating migration has been performed.

The successful run is saved in `tmp/historical-match-cancel/DiRufV9GvDw2-owner-retry-20260907`. Its `apply-result.json` records plan digest `c2b3e02abc27a84ed33e5e48b31ba1760ef56dec0de36ad470dee0e3ed99ed3c` and actual D1 usage:

- Source fetch: 482,232 reads.
- Atomic apply: 829,646 reads and 67,503 writes.
- Post-apply verification: 148,022 reads and zero writes.
- Successful-run total: 1,459,900 reads and 67,503 writes, excluding KV and earlier attempts/diagnostics. The writes are about 0.135% of Paid's included monthly D1 writes.

Retain the conservative event-write multiplier for future maintenance until more representative metering supports changing it. The earlier preview and failure notes below are historical records, not the current repair status.

### Archived repair notes — do not execute

The notes through “First owner apply and follow-up” preserve the earlier investigation. Their previews, commands, estimates, and statements that production work was pending are superseded by the successful apply recorded above. **Do not rerun the cancellation or any saved apply SQL.**

The requested first-match cancellation for player `1115304937501503508` was a separate pre-reset operation:

- Match: `DiRufV9GvDw2`, 3v3, created April 5, 2026 at 20:56:13 UTC.
- At the September 6 inspection it was completed, not imported, and had no season assigned.
- Use `ppl/cancel-historical-rated-match.ts`, not the public RP migration or a season reset.
- Ordinary cancellation must reproduce the existing ratings. If inconsistent history requires a broader repair, review that policy explicitly and validate both the repaired baseline and cancellation separately. Keep source data, proposed changes, and recovery files locally.
- Check actual Cloudflare usage before applying. Nearness to midnight UTC does not make an oversized operation safe.
- A successful production cancellation must be verified separately; this entry records the request, not completion.

The initial September 6–7 cancellation-only preview did not pass. Saved input and diagnostics are in `tmp/historical-match-cancel/DiRufV9GvDw2-preview-20260906`. Production spot checks confirmed 19 rated matches with no global rating events and three cancelled matches with remaining rating events (`9AiEaHO12c`, `V9ixC1FFd1`, `gDzPUIsCPM`). The local replay also differs because of historical loss-protection rules, four old ordinary FFA games interpreted as Permanent Ally games, event ordering, and opponent-tier evidence.

A diagnostic current-algorithm cancellation simulation estimated 221,396 indexed writes before target bans and civ-stat cleanup. That diagnostic must not be applied. The owner subsequently requested fixing the existing errors before cancellation, with prevention changes where possible. The combined preview is described below; it must not be mistaken for a cancellation-only operation. The user will run the final reviewed apply. Finish and verify this work before implementing the season reset.

On September 7 the owner purchased Workers Paid. The available API token could not inspect subscriptions, so activation must be confirmed in the dashboard. The latest read-only September 1–7 calendar-period snapshot, through 01:27:46 UTC, recorded 12,679,276 D1 reads and 159,268 D1 writes; this is not the new billing-period total. Paid includes 25 billion D1 reads and 50 million D1 writes per month. Keep the conservative repair estimate and explicit apply limit because past local estimates have understated metered usage.

The four old FFA games now have an evidence-checked local replay compatibility path: both their saved mode snapshots and global rating changes must reproduce ordinary FFA before changing their local interpretation. This does not change production match settings. An ordinary control replay still cannot reproduce the inconsistent old history; the separate reconciliation policy below is required. A full local replay took about 91 seconds. No production apply duration has been measured.

### Combined repair preview, September 7

The proposed repair rebuilds downstream squad/global hidden ratings with the current formula in match-creation order, then removes `DiRufV9GvDw2`. This intentionally changes historical protection/order behavior; it does not recover the exact old formula sequence. Earlier state is preserved. Baseline and cancellation calculations both passed comparison against a separate reconstruction. Ordinary cancellation retains its original strict control requirement.

- Reconstruct 60 global player events across the 19 missing match scopes. Keep recorded quality credits on existing events; do not invent opponent-tier credits where no record exists.
- Remove the 26 stale squad/global events belonging to the three already-cancelled matches, plus the target's 12 events. Rebuild affected current summaries from the resulting history.
- Update 15,168 squad and 34,571 global events, 15,168 participant snapshots, and 2,253 player/scope summaries; delete one squad summary. Other mode tracks and pre-boundary history are outside this repair.
- Keep the conservative estimate at 221,379 indexed writes, including target statistics cleanup. The proposed apply ceiling is 250,000 estimated writes. This is about 0.44% of Paid's included monthly D1 writes, or 4.4% at a hypothetical 10× underestimate; neither figure guarantees actual metering.
- The latest live source fetch used 482,162 D1 reads and zero writes. Subsequent preview and SQL validation runs used saved data only.
- Final SQL validation passed at 01:34:44 UTC: 443 apply statements, 162 verification statements, and 380 rollback statements, all within the unchanged 500-statement and 100,000-byte limits. The largest apply statement is 88,749 bytes. Local apply took 14.8 seconds and rollback 4.6 seconds; production runtime is still unmeasured.

`tmp/historical-match-cancel/DiRufV9GvDw2-final-review-20260907` contains the final review artifacts. `reconciliation-effects.json` separates history-only changes from cancellation effects. `local-sql-verification.json` records the local apply, final-state checks, and rollback equality test. See [PPL maintenance instructions](../PPL.md#repairing-inconsistent-history-before-cancellation) for the owner-run command and prerequisites. No production cancellation, migration, deployment, or season reset has been performed.

Local prevention changes prepare both rating scopes before cancellation changes lifecycle state, then submit their rating writes together. Incomplete-report repair and report rollback also combine rating scopes. Oversized online replays refuse before their rating writes. Tests cover a global validation failure leaving mode/state unchanged and a failed write batch preserving both rating tracks, followed by a successful retry. Session lifecycle and statistics are not part of that same D1 batch, so interruption can still require retry; this is not a claim that every historical cause has been eliminated. These changes are not deployed.

Validation: 80 focused maintenance/report/rating/moderation tests passed, bot type checking passed, and the capacity regression test passed with an unchanged snapshot. A separate maintenance-script type-check attempt encountered Bun/Workers global type conflicts in shared utility dependencies; it is not recorded as a passing script-wide type check.

### First owner apply and follow-up

The first owner apply stopped with `malformed JSON: SQLITE_ERROR` before the rating updates. At 01:55 UTC a read-only diagnosis found the target still completed with its original 12 events. All 250 other source checks passed; the sole failure was a guard incorrectly requiring the three already-cancelled matches to have no session-directory entries. They have cancelled, closed entries, unchanged since June. The local fixture had omitted these entries.

The corrected cleanup distinguishes the target cancellation (still no SessionDO support) from removing stale D1 events on already-cancelled history. It captures and validates the existing closed session projections and guards their identity, phase, version, server, and timestamps. It does not change session lifecycle or session-directory rows. Non-terminal, mismatched, duplicate, or changed entries still block the operation. Guard errors now name the failing check rather than producing only a generic malformed-JSON message.

The diagnostic used 46,575,055 D1 reads and zero writes, about 0.19% of Paid's included monthly reads. This disproved the old guarded-read estimate: SQLite was choosing a broad scan joined on repeated JSON settings instead of match identity. Guard joins now force expected keys first, followed by indexed source lookups. Keep metering the actual D1 queries; do not rely on the old 343,624-read estimate as a bound. The owner permits Paid-level read usage. No script-imposed read cap or read-budget restart is required.

The corrected preview and local recovery check passed at 02:03 UTC: 444 apply statements, 162 verification statements, 380 rollback statements, maximum apply statement 88,749 bytes, and the same 221,379-write estimate. Local apply took 4.5 seconds; rollback restored the source and left session-directory rows unchanged. Maintenance tests: 23 passed. Artifacts are in `tmp/historical-match-cancel/DiRufV9GvDw2-retry-review-20260907`.

A read-only production check of all 252 corrected guards used 552,277 reads and zero writes, roughly 84× fewer reads than before. The cancelled-session guards passed. Two new reports (`hep03ztF57` and `wwI6m78Tno`) arrived after the earlier diagnosis, so match/event counts and some current summaries correctly rejected the old saved plan. This is source freshness, not a read-limit stop. The owner's retry must fetch and validate current data; do not apply the stale saved SQL or bypass those checks.

## Identify the current season as S8

Season numbers are stored, not permanently hardcoded to 1. The season-start command already accepts a starting number.

The owner confirmed that all existing history belongs to S8, including imported games, from the first recorded game. Use a local maintenance script; new season commands are not required.

The saved source for the successful September 7 repair contains **zero season records**. Its 10,884 covered matches have no season assignments: 1,046 imported matches dated March 13–April 12 and 9,838 non-imported matches dated March 21–September 7. This is a saved, pre-repair source covering that maintenance operation, not a complete current season export. There is no Season 1 in that source to rename.

- Create `Season 8` starting at the earliest existing game's timestamp and assign every existing match to it, without resetting or replaying hidden ratings.
- Refuse initialization if a fresh source has existing seasons or assigned matches; inspect that changed source rather than overwriting it.
- The local initialization workflow is documented in [the rollout guide](../PUBLIC-RATING-ROLLOUT.md#s8-historical-initialization). S9 still requires the separate immediate-opening transition and 48-hour S8 reporting window.

Do not start a new season today merely to rename existing history. Starting a season does not attach earlier games to it.

Update any already-created historical Discord role names and saved mappings. Historical names come from the season number, so the intended result is `S8 Gladiator`, not `S1 Gladiator`.

## Two-day reporting window

A match belongs to the season in which its draft started. Reporting it later must not move it into a newer season. Manual reports and imports must have a validated season assignment too.

The window allows the first result report, or scrapping an unreported game, for an existing unfinished S8 match for 48 hours after S8 closes to new ranked starts. Store one exact UTC deadline. Do not allow someone to create a new match after the cutoff and label it S8.

**Selected September 7: open S9 immediately (option B).** There is no two-day break in new ranked games. At the cutoff, new ranked drafts belong to S9 while existing unfinished S8 matches retain their 48-hour reporting window. The exact cutoff and deadline still require approval before rollout.

Save separate S8 rating state and freeze both hidden and public S9 starting ratings when S9 opens. Late S8 results update S8 only; they do not change S9 starting ratings or replay S9 games. Historical replay must respect the saved hidden starting state too. For example, an S8 win reported the next day counts toward S8 results but does not improve an already-assigned S9 opening rating.

This requires more implementation and testing than waiting for S8 reports, but preserves uninterrupted ranked play without repeated S9 recalculation. Keep the two seasons' statistics and rating history separate during the overlap.

Capture S8 peak/rank state before changing live roles at S9 opening. Finalize S8 peak ranks and historical roles after the reporting window, including its late results. Derive those achievements from saved S8 state, not S9 roles; finalizing S8 must not replace frozen S9 seeds.

## Lock closed-season results

During the reporting window, existing unfinished S8 matches can be reported or scrapped. A game with a saved or partially written result must finish reporting before cancellation is considered. Already-reported past-season results are not editable through the bot or API.

After the deadline, reject both new S8 reports and all result changes. This includes placement edits, deleting or cancelling a completed result, changing participants or teams, and moving a result to another season to bypass the lock.

Enforce the rule in shared server-side mutation paths, not just Discord command permissions. Moderators and administrators have no bypass. Current-season corrections remain available under normal permissions.

Owner-only historical repair uses a local maintenance script, not a Discord/API exception. Inspect and recalculate a local copy first. Applying a repair back to production is a separate, explicitly approved operation with saved source data, a write budget, and verification. Local experimentation alone does not change production. Neither ordinary repair paths nor an owner script may silently replace finalized S9 opening ratings.

A deadline check needs no polling loop or per-player daily writes. Use the match's saved season and the season's deadline. Handle reports crossing the deadline consistently with the serialized report claim so retries do not reject a result already accepted on time.

## Preserve qualification, reset season records

Keep existing effective-game evidence and quality-win credit when S9 starts. A returning qualified player does not become a new player again. New players still need the evidence and quality wins required by the public RP plan.

Store season games, wins, and leader records separately from qualification evidence. For example, a player can have three S9 games while already meeting Elite's experience requirement.

Save S8 closing state before increasing hidden uncertainty. Use the public RP plan's opening RP and one-rank protection to assign the approved S9 opening roles once. Clear old pending demotions so ordinary role-delay rules do not keep former Elites in Elite after the reset. Resume ordinary role protection after opening assignments.

Do not use the deployed soft-reset helper unchanged: it clears qualification counters, and the deployed season command also clears managed-role state. The isolated local implementation preserves evidence, but its legacy season-start command is not the S8/S9 overlap cutover workflow.

## Historical ratings and graphs

Keep existing S8 rating history. Do not create RP for S8 merely to make a graph continuous.

- `/rank` defaults to the current season and its most recent 20 games; retain the 50/100/200 choices within that season.
- `/rank season:8` shows S8's existing rating scale. Do not label it RP or apply S9 fixed RP division bands to it.
- `/rank season:9` starts at the saved opening RP. Before the first S9 game, show that opening point rather than no data.
- There is no line connecting S8's old rating scale to S9 RP in the default view.
- A future cross-season graph needs an explicit season divider. A reset remains a real change even if both seasons eventually use RP.

Pre-S9 public event fields stay null. Historical views must deliberately choose the old rating presentation; generic null-to-hidden-score fallback must not invent RP. A missing public-era value is incomplete data, not permission to substitute hidden MMR.

## Consistent season choices in commands

Add the same `season` option to `/stats`, `/rank`, and `/leaders`. Default to Current; allow specific seasons. Offer All time for aggregate statistics, not a combined graph with incompatible rating scales. If no season is active, Current resolves to the latest season. Show the selected season in the title.

| Command | Selected-season behavior |
| --- | --- |
| `/stats` for a player or team | Games, wins, teammates, opponents, and recent matches come from the selected season. Current views show current ratings; past views show closing ratings and the earned peak rank, not today's role. |
| `/stats leader:...` | Use the same season selection for leader results and best-player comparisons. |
| `/rank` | Read the selected season's rating history and saved opening point, using that season's rating system. |
| `/leaders` | Show the selected season's leader games, wins, and performance rankings. All time combines historical counts. |

All-time statistics may combine games and wins, but never sum or average RP across seasons. Any current rating shown beside all-time counts must be labelled current.

Save each player's closing hidden rating for historical leader-performance calculations. They currently use today's hidden rating; otherwise an S8 ranking can change as people play S9. Save closing ratings separately from season peaks: the highest achieved rank is not necessarily the closing rank.

Use saved summaries and indexed history reads. Selecting a season must not replay matches, change live roles, or mutate historical ratings. Apply the same rules to Activity/API views using these statistics.

## Reporting and repair order

Store a stable order for accepted public rating transitions and the formula/calibration version used for each event. Corrections keep the original event's place in the sequence. Do not infer public ordering from a mutable report timestamp or use different ordering in normal reporting and repair.

Before shipping, prove that a repair with no result changes reproduces the same ratings, including games reported out of start-time order, retries, and season-straddling matches. Retain hidden OpenSkill behavior; any required change to hidden historical ordering is a separate decision, not an incidental public-RP change.

## Cost expectations

These are planning estimates, not current production headroom. [Cloudflare limits](CLOUDFLARE.md) and actual account usage must be checked again before a write operation. D1's documented free daily allowance is 100,000 rows written and 5,000,000 rows read; it resets at midnight UTC.

| Work | Expected cost |
| --- | --- |
| 48-hour window before the actual reset | Lowest: normal report work, one reset, no repeated S9 repair. |
| Late S8 reports after S9 opens, affecting S8 only | Low ongoing cost, moderate implementation work for separate season state. |
| Late S8 reports repeatedly rewriting S9 | Variable and potentially high. Avoid. Cost grows with later rating events rewritten, not just the number of late reports. |
| Closed-season lock | Negligible extra write cost; check season/deadline during mutations. |
| Keep S8 ratings and separate graphs | No historical RP conversion. Season summaries and correctly indexed graph reads still need implementation. |
| Convert all old history to RP | Substantial one-time reads/writes; ordinary graph reads afterward. Not selected. |
| Rename an existing season to S8 | Tiny: update the season record and any saved Discord names/mappings. |
| Assign previously unassigned games to S8 | One-time work proportional to matches and affected statistics; estimate after agreeing the actual date range. |
| Seasonal command views | Moderate implementation work, low ongoing cost with saved summaries. No full rating recalculation on command use. |

The older August 15 whole-history estimate counted 67,124 player/mode rating events and 3,818 player/mode rating records. Converting that history would require 141,884 direct row updates with the compatibility copies, at least three quota days at a proposed 60,000-write daily conversion budget. This is not a current S8-only estimate and excludes additional migration/index/retry work.

For scale, one seed per 3,818 records plus updates to two current-rating copies would be about 11,454 direct row writes, before extra audit or season-summary storage. Re-estimate using the final schema. Do not treat direct row-update estimates as exact metered D1 costs.

## Implementation and cutover

1. Finish approved historical corrections and determine the real S8 date range/record mapping.
2. Implement the selected immediate-S9 schedule, closed-season protection, persistent qualification, separate season summaries, and command filters.
3. Implement and simulate the formula, opening seeds, and seed-aware repair described in the public RP plan. Include long runs of equally skilled players near division boundaries to detect game-volume inflation from loss protection.
4. Update the old rollout runbook; its replay-everything-from-900 procedure is obsolete.
5. Apply only separately approved migrations, with public reads disabled.
6. Approve an exact S8 cutoff/S9 opening time and S8 reporting deadline. Briefly refuse new reports and other rating-changing actions, wait for already-admitted writers to finish, then capture consistent S8 state and install frozen S9 opening ratings. Drafts remain available and can complete. Reports attempted during the pause are not saved; players retry after reopening. Deploy the pause-capable code before using the gate. Stop for targeted inspection if a write's outcome is uncertain; do not overwrite live reports with an older snapshot.
7. Validate shadow writes, finish any cutover catch-up, and verify event totals match current summaries before enabling public reads or opening-role sync. Open S9 ranked play at the cutoff, with unfinished S8 matches reporting only into their separate S8 state. Refresh leaderboard snapshots after the data is consistent.
8. At the end of the 48-hour window, finalize S8 achievements and historical roles without changing S9 seeds or replaying S9 games.

Test the distinct failure cases: carried qualification, late-report deadline and retry, all closed-season mutation routes, historical graph scale, seed-only graph, stable recalculation order, and archived leader rankings remaining unchanged during a new season.
