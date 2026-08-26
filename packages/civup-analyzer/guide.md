# CivUp Analyzer Guide

This package is the standalone Civ 6 autosave analysis tool. The CLI binary is `civup`.

The analyzer has six useful CLI layers now:

1. `parse`: the existing metadata timeline parser used to identify saves, turns, players, leaders, civs, BBG, and map metadata.
2. `lobby`: a one-save lobby setup summary with seeds, slot order, and team assignment.
3. `snapshot`: the new CivVIReplay-style parser foundation that extracts the internal decompressed game-state blob from each `.Civ6Save`.
4. `opening`: a player-focused opening report for turns 1-50 by default.
5. `science`: a one-turn science source report using observed city yields plus visible component estimates.
6. `compare-opening`: a report-to-report comparison for user openings against a baseline.

The deep-analysis path is not blind byte diffing. It is structured snapshot parsing over CivVIReplay-style decompressed state, followed by deterministic diffs between adjacent turns.

## Quick Start

Metadata timeline:

```sh
bun run civup parse "C:\Users\hegyi\Documents\My Games\Sid Meier's Civilization VI\Saves\Multi\amit-tj-mikalai-cynth-noddle-khornie.zip"
```

CivReplay snapshot extraction for one autosave turn:

```sh
bun run civup snapshot "C:\Users\hegyi\Documents\My Games\Sid Meier's Civilization VI\Saves\Multi\amit-tj-mikalai-cynth-noddle-khornie.zip" --turn 1
```

Machine-readable snapshots:

```sh
bun run civup snapshot auto.zip --jsonl --out snapshots.jsonl
```

When published as a package, the goal is:

```sh
bunx civup snapshot auto.zip --jsonl --out snapshots.jsonl
```

## Current CLI

```sh
civup parse <autosaves.zip|save.Civ6Save> [options]
civup lobby <autosaves.zip|save.Civ6Save> [options]
civup snapshot <autosaves.zip|save.Civ6Save> [options]
civup opening <autosaves.zip> --focus <player|leader|civ> [options]
civup science <autosaves.zip|save.Civ6Save> [options]
civup compare-opening <baseline-opening.json> <subject-opening.json> [options]
```

Options:

```txt
--summary              Print a human-readable summary (default)
--json                 Print JSON
--jsonl                Print one JSON object per turn/save
--format <format>      summary, json, or jsonl
--out, -o <path>       Write output to a file
--focus <text>         Highlight matching player, leader, or civilization in parse summary
--player-id <n>        Select internal player id/slot for opening reports
--turn <n>             Snapshot only one autosave turn
--from-turn <n>        Opening report start turn (default 1)
--to-turn <n>          Opening report end turn (default 50)
--limit <n>            Parse only the first n autosaves
--types-db <path>      Resolve hashes with a Civ VI DebugGameplay.sqlite file
--no-types-db          Do not load the default local Civ VI DebugGameplay.sqlite
--compact              Minify JSON output
--fail-fast            Stop on the first parse failure
--help, -h             Show help
```

Removed commands: `profile`, `tokens`, `diff`, `ranges`, `blocks`, and `inspect`.

Those were discovery tools. We proved the important fact from them: tech/civic data lives inside Civ6 internal compressed state. Keeping blind diff/string commands would push the project in the wrong direction, so they are gone.

## Science Reports

`science` answers one-turn questions like "where is this player's midgame science coming from?" It defaults to the latest parsed save, or use `--turn <n>` for a specific autosave.

```sh
bun run civup science auto.zip --turn 70
bun run civup science auto.zip --focus England
bun run civup science auto.zip --player-id 2 --json --out owl-science.json
```

The report shows each major player's observed total science from saved city yield maps, top science cities, population science, science-yielding buildings from `DebugGameplay.sqlite`, campus adjacency, Natural Philosophy when active, decoded standard scientific city-state building bonuses, decoded Owl suzerain route yields, known route-yield components, active policies, governors, and scientific city-state presence/envoys/suzerain. It also reports `modifier/unattributed` science: the observed city science above the visible baseline. This bucket is intentional, because exact save fields for civ/leader modifiers, great people, alliance effects, conditional city-state duplicate-copy modifiers, and some custom mod modifiers are not decoded yet.

## Opening Reports

The `opening` command is the first high-level analyzer workflow. It combines metadata player matching with structured CivReplay snapshots.

Example:

```sh
bun run civup opening "C:\Users\hegyi\Documents\My Games\Sid Meier's Civilization VI\Saves\Multi\amit-tj-mikalai-cynth-noddle-khornie.zip" --focus Lincoln --to-turn 50
```

It currently reports:

- selected player by metadata focus or internal `--player-id`
- lobby seeds: Game Random Seed and Map Random Seed
- key-turn metrics for cities, population, districts, units, improvements, gold, faith, maintenance, and labeled core yields
- save-derived current age state, current/previous era score, and active dedication choices
- cumulative tech/civic completion counts plus completed-with-boost counts for comparison reports
- city-founded events
- resolved tech/civic completions when a gameplay types database is available
- resolved production changes for units, buildings, districts, and other known gameplay types
- city built-item completions when a city `builtItems` entry moves from absent/`0xffff` to a real value
- government/policy changes and goody hut category count changes
- pantheon changes and visible city majority religion changes from parsed player/city snapshot fields
- age change events from parsed `HasGoldenAge`/`HasDarkAge` flags
- district placed/built events
- unit created/lost/upgraded events, with a conservative creation method label: `producedOrChopped`, `likelyPurchasedOrGranted`, `likelySettlementGrantOrInstant`, or `unknown`
- governor assigned/promoted events, including the first visible governor assignment
- tile improvement changed events
- conservative district cost analysis that flags likely discounted placements when saved district cost is substantially below estimated full cost
- best-effort district adjacency change history for the focused player when a Civ VI gameplay database is available
- luxury resource ownership changes by turn, including improvement status, when a Civ VI gameplay database is available
- city-state roster/presence by matching parsed city-state capital city names to bundled city-state definitions and, when available, `DebugGameplay.sqlite`; opening summaries count alive/captured/not-present city-states and highlight scientific city-states, decoded envoy counts, and suzerain status
- active trade-route endpoint counts plus conservative known-component route yields from destination/origin district route-yield tables and active unconditional/domestic/international route-yield policy cards

Core yields are resolved with Civ hash labels: `YIELD_FOOD`, `YIELD_PRODUCTION`, `YIELD_GOLD`, `YIELD_SCIENCE`, `YIELD_CULTURE`, and `YIELD_FAITH`.

District adjacency history is computed from map tiles plus `District_Adjacencies`/`Adjacency_YieldChanges` in `DebugGameplay.sqlite`. It is intentionally best-effort: adjacent river and natural-wonder parity are flagged as unsupported rather than guessed, and unavailable databases simply omit these sections. District cost analysis uses saved locked district costs plus `Districts`, `GameSpeeds`, and progression tables from `DebugGameplay.sqlite`; it reports likely discounts conservatively rather than claiming an exact hidden discount flag. Trade-route output has two layers: active endpoints are decoded from trader operation state, and known-component yields are computed from `District_TradeRouteYields` plus active route-yield policy modifiers with unconditional/domestic/international scopes. Exact UI route yields, route length, route-yield buildings/wonders, alliance effects, and other modifier stacks remain unsupported unless decoded later. Religion output currently covers player pantheon and each city's visible majority religion hash; founded-religion belief payloads are still not decoded. Age output covers current score, previous-era score, active dedication, and current normal/dark/golden/heroic state where flags are present; dark/golden thresholds are not decoded yet. City-state output identifies city-state capital city names, owner player ids, alive/captured/not-present state over the parsed opening window, category such as scientific/cultural/religious/trade/industrial/militaristic, decoded influence-token envoy counts, and suzerain player. City-state visibility, quests, and suzerain-change/envoy-change events are still not decoded.

By default, `opening` tries to load the local Civ VI debug gameplay database at `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI\Cache\DebugGameplay.sqlite`. Use `--types-db <path>` to point at another database or `--no-types-db` to keep only the bundled static resolver. The bundled resolver covers common early-game techs, civics, units, buildings, districts, improvements, governors, promotions, operations, and core yields.

Generate a reusable report:

```sh
bun run civup opening auto.zip --focus Lincoln --to-turn 50 --json --out expert-lincoln.json
```

## Comparing Opening Reports

`compare-opening` compares two saved `opening --json` reports. It does not reparse the original autosave zips.

```sh
bun run civup compare-opening expert-lincoln.json mine-lincoln.json
```

The summary reports subject-minus-baseline deltas for end state, key turns, city founding timings, yields, completed/boosted tech and civic counts, tech timing, and civic timing. It also emits `biggestGaps` plus short recommendations. Negative timing means the subject reached the milestone earlier than the baseline.

Expert-vs-user workflow:

```sh
bun run civup opening expert.zip --focus Lincoln --to-turn 50 --json --out expert-lincoln.json
bun run civup opening mine.zip --focus Lincoln --to-turn 50 --json --out mine-lincoln.json
bun run civup compare-opening expert-lincoln.json mine-lincoln.json
```

## Replaying The Same Map

To reproduce the expert lobby as closely as possible, copy both seeds and the player setup:

- Game Random Seed: drives game-level randomization and start assignment behavior.
- Map Random Seed: drives map generation. In a freshly created Civ VI lobby this often defaults to Game Random Seed + 1, but saved games store both values explicitly.
- Exact leaders/civs.
- Exact slot order and team assignment. In team games, slot order affects which players land in which starts, even with the same map seed.
- Same map script, map size, game speed, ruleset, DLC/mod set, BBG/BBM versions, game modes, city-states, disasters, resources, starts, and any other lobby options.
- Same city-state roster. The `snapshot` and `opening` commands now expose save-derived city-state presence, envoys, and suzerain status so SP/no-city-state setup bugs or mismatched scientific city-states are visible without guessing from yields.

For the current expert Lincoln save, the parser reports:

```txt
Game Random Seed: -1556873817
Map Random Seed:  -1556873816
```

Use `lobby` for the full table instantly:

```sh
bun run civup lobby auto.zip
```

The expert save reports team `0` slots `0, 3, 4` and team `1` slots `1, 2, 5`.

## Correct Parsing Direction

`CivVIReplay` is the reference architecture.

Its useful core is:

1. Read the `.Civ6Save` top-level packet arrays.
2. Parse packet headers with marker, type, 3-byte length, found byte, and info field.
3. Handle packet scalar/object/array types enough to keep the cursor aligned.
4. Extract compressed packets using packet lengths, zlib inflate, 64 KiB chunks, and 4-byte inter-chunk padding.
5. Use the final decompressed payload as the per-turn game-state snapshot.
6. Parse specific state sections from that snapshot.
7. Diff adjacent snapshots to derive events.

The current `snapshot` command implements steps 1 through 6 for the map section. It reports state blob sizes, packet counts, map dimensions, tile count, and map-derived counters such as owned tiles.

Current expert-zip validation:

- `104/104` saves parse successfully.
- Map dimensions are stable at `74x46` with `3404` tiles.
- Owned tile counts advance over time, which validates that tile ownership fields are being read from the map section.
- Player/city block extraction now parses `104/104` saves successfully.
- Turn 2 city extraction finds 15 cities, including `LOC_CITY_NAME_ST_PETERSBURG`, `LOC_CITY_NAME_PARIS`, `LOC_CITY_NAME_WASHINGTON`, `LOC_CITY_NAME_LONDON`, `LOC_CITY_HA_NOI`, and `LOC_CITY_NAME_CONSTANTINOPLE`.
- City production-progress and built-item maps are emitted as raw `{ hash, value }` entries for later diffing and hash resolution.
- Player `goodyHuts` and `diploFavor` are captured from the early player stats block.
- The structured post-city player tail now reaches civic and tech progression maps, nearby economy fields, and the later per-city yield pass.
- Extracted player fields include government, last government change turn, policies, civics, techs, faith, pantheon, diplomatic victory points, gold, strategic-resource count, and unit-count maps.
- City yield maps are emitted as fixed-point `{ hash, value }` entries; expert-zip validation sees city yields on `0 -> 67` cities across the game.
- Tech and civic `turnTo` maps are now emitted as raw `{ hash, value }` entries.
- Units, districts, governors, and improvements are exposed as structured snapshots instead of opaque skips.
- Consecutive snapshot diffing emits normalized events for city founding, production changes, city built-item completions, progression completions, government/policy changes, age changes, pantheon and city majority religion changes, goody hut category counts, district placement/completion, units, governors, and tile improvements.
- Expert zip event validation currently yields 67 `cityFounded`, 1,974 `cityProductionChanged`, 750 `cityBuiltItemCompleted`, 697 `techCompleted`, 557 `civicCompleted`, 186 `governmentChanged`, 30 `dedicationChanged`, 9 `ageChanged`, 451 `districtPlaced`, 287 `districtBuilt`, 1,281 `unitCreated`, 1,043 `unitLost`, 4 `unitUpgraded`, 64 `governorAssigned`, 53 `governorPromoted`, and 2,971 `tileImprovementChanged` events.

## Next Parser Milestones

Milestone 1: CivReplay payload extraction

- Keep packet parsing small and strict.
- Match CivVIReplay compressed extraction behavior.
- Emit one `snapshot` row per autosave.
- Verify against expert autosaves before adding deeper fields.

Milestone 2: stable section readers

- Done: add section-aware reader errors with section name and byte offset.
- Done: port `ParseMap` enough to validate tile count, map width/height, terrain, feature, resource, improvement, overlay, ownership, district, city, road, pillage, and wonder fields.
- Next: port the start of `ParsePlayers` with structured reader helpers and section labels.
- Later: port `ParseTurn` only after validating the right offset for our autosaves.

Milestone 3: player/city/tech/civic snapshots

- Done: extract internal player ids and city blocks.
- Done: extract player `goodyHuts`, `diploFavor`, government, last government change turn, policies, faith, pantheon, diplomatic victory points, gold, strategic-resource count, and unit-count maps.
- Done: extract city id, x/y, name, population, religion, current production, production-progress maps, built-item maps, and city yield maps.
- Done: extract tech/civic `found`, `boost`, `research`, `current`, and `turnTo` maps.
- Done: expose units, districts, governors, and improvements as separate structured sections rather than strict skips.
- Next: resolve hashes to Civ type names and add higher-level progression summaries.

Milestone 4: hash resolution

- Done: implement CivVIReplay-compatible CRC32 helpers.
- Done: resolve stored 32-bit hashes to Civ type names through a static type map first.
- Done: load Civ VI `DebugGameplay.sqlite` from the default local cache path or `--types-db <path>`.
- Done: add bundled fallback names for common early-game analysis when no local debug gameplay database exists.
- Next: expand fallback coverage or generate a compact bundled resolver from known gameplay databases.

Milestone 5: deterministic event diffs

- Diff adjacent turns only when they are consecutive.
- Emit normalized events outside the binary parser.
- Done: emit `cityFounded` for newly observed city locations on consecutive turns.
- Done: emit `cityProductionChanged` for current-production type/hash-array changes on consecutive turns.
- Done: emit `cityBuiltItemCompleted` for conservative built-item map transitions from absent/`0xffff` to a real value.
- Done: emit `techCompleted` and `civicCompleted` for `found` map transitions on consecutive turns.
- Done: emit `governmentChanged` for government, last-government-turn, or policy-slot changes.
- Done: emit `goodyHutCategoryCountChanged` for already-parsed goody hut category count changes.
- Done: emit `districtPlaced`, `districtBuilt`, `unitCreated`, `unitLost`, `unitUpgraded`, `governorAssigned`, `governorPromoted`, and `tileImprovementChanged`.
- Done: include initial governor appearance/assignment in `governorAssigned` without duplicating initial promotions as promotion events.
- Next: improve attribution, especially builder actions and distinguishing combat losses from deletes/upgrades when the save state exposes enough context.

Milestone 6: player-facing analysis

- Done: build `opening` reports after snapshots contain real city/stat/progression fields.
- Done: compare a strong-player opening report against a user opening report.
- Done: explain concrete timing gaps by turn with `biggestGaps` and recommendation text.
- Next: make recommendations leader/map-aware instead of generic opening heuristics.

## Output Shape Goal

The eventual deep snapshot JSONL should look like this:

```json
{
  "turn": 57,
  "players": [
    {
      "id": 5,
      "gold": 312,
      "faith": 74,
      "yields": {
        "YIELD_FOOD": 58.5,
        "YIELD_PRODUCTION": 42.25,
        "YIELD_SCIENCE": 67
      },
      "currentTech": ["TECH_APPRENTICESHIP"],
      "currentCivic": ["CIVIC_FEUDALISM"],
      "cities": [
        {
          "id": 3,
          "name": "Kyoto",
          "x": 41,
          "y": 22,
          "population": 7,
          "currentProduction": {
            "type": "DISTRICT",
            "item": "DISTRICT_INDUSTRIAL_ZONE",
            "progress": 83
          }
        }
      ]
    }
  ],
  "events": [
    {
      "type": "cityFounded",
      "player": 5,
      "cityId": 3,
      "x": 41,
      "y": 22
    }
  ]
}
```

The important rule: raw snapshot extraction and derived event inference stay separate.

## Notes

Do not trust one save or one game as a universal rule. Strong-player analysis becomes useful when the same pattern appears across multiple games, leaders, and maps.

The best workflow is narrow: pick one leader, one player, and one timing question. Example: "How does Mikalai get first three cities and first two districts online by turn 50?"

Still unsupported or intentionally approximate: dark/golden age thresholds, exact purchase events, exact UI trade-route yields/length, exact hut reward payloads, founded-religion belief payloads, and exact river adjacency unless that map field is decoded later.
