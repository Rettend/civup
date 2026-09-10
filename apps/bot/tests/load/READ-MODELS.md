# Local D1 read-model comparison

Run from the repository root:

```powershell
bun run --filter civup-bot test:read-models
```

This is a standalone service/database benchmark. It uses Wrangler to create disposable local D1 databases and `getPlatformProxy` to call their workerd bindings. Service JavaScript runs in Bun. It does not start the bot, invoke Discord routes, or use remote bindings or credentials.

The runner extracts bot services from commit `7a0c1f01` and compares them with the working tree. Both variants use the installed dependencies and shared game/rating packages. Changes to those shared calculations require a separately pinned dependency comparison.

The fixtures are deterministic and synthetic: 50 and 1,000 duel reports for two players with active overall divisions, plus mixed-mode civ contributions and 80 frozen beta candidates. Historical standings add 50 and 1,000 other players, respectively, with Duel and overall summaries. These fixtures expose history and population growth but do not establish production costs or cover every game format.

For each size, the runner compares:

- Three ordinary reports with active division assignments.
- A cancellation near the end of the earlier history, including connected later reports.
- Release maintenance, snapshot refresh, and cancellation refresh.
- Historical standings on a cold cache and after KV loss.
- Missing quality-history initialization, including ledger writes.

The new variant also applies the new migrations to the populated baseline database, measures checkpoint/release/standings preparation, and records allocated SQLite page storage. Ratings, events, division assignments, credits, civ statistics, and historical positions must agree between variants; quality evidence allows a small floating-point summation difference. The new historical graph distribution is an additional saved field.

Results are saved under `tmp/read-model-benchmark-<timestamp>/`. `results.json` summarizes each workload. Per-workload trace files include SQL, bindings, returned rows, available local D1 metadata, and workerd query plans for larger reads and predecessor lookups. Query-plan collection happens outside the timed operation. Each database has its own import log, captured outputs, and persistence directory. Preparation writes only derived data in these disposable databases.

Use environment variables to select fixture sizes or a fresh output directory:

```powershell
$env:READ_MODEL_SIZES = '50,1000'
$env:READ_MODEL_OUTPUT = 'C:\path\to\fresh-output-directory'
bun run --filter civup-bot test:read-models
```

Wall times include the local binding bridge and should be compared across repeated runs. `raw()` returns ordered columns required by Drizzle but does not expose D1 metadata; total returned rows must not be described as billed reads. Available write metadata is reported separately. Storage uses allocated SQLite pages, including the live WAL view, rather than cumulative WAL file size. These results are local comparisons, not production billing or latency measurements.

## September 10 comparison

The first proposal was measured in `tmp/read-model-benchmark-1789044681656/results.json`. The refined version was verified in `tmp/read-model-benchmark-1789046277147/results.json`, using Wrangler 4.63.0. Both fixture sizes passed the report/correction database comparisons and civ/historical projection comparisons. Quality calculations agreed; the original 1,000-match initializer could not commit because its generated statement exceeded the existing size guard.

For the 1,000-match fixture, writes below are locally reported D1 writes:

| Workload | Original services (`7a0c1f01`) | First proposal | Refined proposal |
| --- | --- | --- | --- |
| Ordinary duel report | 71 statements; 87 writes | 72 statements; 103 writes | 68 statements; 89 writes |
| Connected correction | 213 statements; 4,210 returned rows; 276 writes | 136 statements; 143 rows; 360 writes | 132 statements; 143 rows; 298 writes |
| Idle release maintenance after reports/correction | No saved-aggregate maintenance | 11 statements; 4 writes | 1 statement; 0 writes |
| Civ refresh, including idle maintenance check | 2 statements; 1,080 returned rows | 5 statements; 2 rows | 3 statements; 2 rows |
| Civ cancellation refresh | 2 statements; 1,079 returned rows | 14 statements; 87 rows | 10 statements; 5 rows |
| Historical lookup with initially missing D1 snapshot | 4 statements | 2 statements, using prepared snapshot | 2 statements, using prepared snapshot |
| Historical lookup after KV loss | 2 statements | 2 statements | 2 statements |
| Missing quality initialization | Rejected by the per-statement limit | 1,165 statements; 3,051 writes | 172 statements; 3,051 writes |
| Checkpoint, release, and historical preparation | Not required | 1,316 statements; 15,618 writes | 1,278 statements; 11,618 writes |
| Allocated fixture storage before workloads | 3,104,768 bytes | 6,144,000 bytes after preparation | 5,943,296 bytes after preparation |

The refinements avoid rewriting unchanged quality credits, batch initialization credits into one insert per page, and remove two proposed indexes. Checkpoint cleanup uses the reordered primary key. Quality initialization uses the existing player/scope/creation-time index, with separate indexed ranges for tied and later timestamps. Workerd query plans confirm seeks on both timestamp and row identity, including tied timestamps, rather than rescanning earlier pages.

Civ maintenance reads its saved state and pending revisions together, skips dirty writes for unchanged contributions or match updates without contributions, and skips loading the frozen beta sample once live games fully replace it. Crossing back below that threshold still restores the correct beta members across modes. At size 50, where beta members remain selected, cancellation refresh uses 12 statements and returns 85 rows; the bound remains independent of live history size.

The normal-report write count was stable across all six samples per implementation. The increase over the original services fell from 16 writes (18.4%) to two (2.3%). Correction reads remain 143 rows at both sizes, while the original services grow from 334 to 4,210. Saved checkpoint lookups remain indexed.

Quality initialization dropped from 12.34 s to 3.52 s; an earlier refinement run measured 3.36 s with the same statement and write counts. In the final run, the original/refined 1,000-match report medians were 1.19/1.11 s, correction times were 3.96/2.12 s, civ refreshes were 89/47 ms, and civ cancellation refreshes were 89/154 ms. These short local samples show variable timing even when operation counts are stable.

Preparation writes fell by about 26%, and allocated storage fell by about 3.3% from the first proposal. Preparation timing varied from 19.67 s initially to 25.03 s and 32.18 s in the refinement runs, so fewer writes do not establish a faster preparation time. The final schema upgrade took 2.23 s including Wrangler startup; its CLI output exposes duration but not complete row metering.

The refinements reduce recurring database work while retaining bounded-history reads and atomic source guards. The remaining costs are substantial checkpoint storage (the prepared fixture is still about 1.91 times the original size), a small report-write increase, and additional civ cancellation calls. Historical preparation moves ranking out of requests; paged quality initialization trades a bounded, resumable walk for the original all-at-once operation. Production savings and preparation duration still require representative measurements.
