## The short version

`CivVIReplay` is mostly a **snapshot parser**, not an action-log parser. For each autosave/replay file, it extracts a decompressed game-state blob, parses turn/map/player/city/unit/district/governor/visibility state, then compares adjacent turns for a smaller set of derived events like hard techs/civics, government/policy changes, goody hut category counts, conservative city built-item completions, district completion timing, unit losses/upgrades, and cumulative yields. The deepest extraction happens in `CivVIParser::ParsePlayers`, which is a long, hard-coded binary cursor walk using sentinels and many fixed skips.   

## How the parser gets per-turn data

The file path starts in `SaveLoader::LoadSave_WithoutAsset`: for each queued save path it creates a `CivVIParser`, calls `Parser.ParseAll(path)`, gets the game seed, creates or reuses a `CivVIGame`, parses player metadata for new games, then calls `State.Parse(Parser, Game, assets)`. If a previous parsed state exists for the same game, it calls `Game.UpdateStats(previousState, State, assets)` to compute turn-to-turn derived stats.  

`ParseAll` checks the `CIV6` magic header, parses several top-level Firaxis packet arrays, then reaches a compressed payload. The parser understands a small packet format with `marker`, `type`, 3-byte `length`, `found`, `info`, scalar data, and nested child packets for object/array types. The known packet data types include bool, integer, pointer, string, UTF string, object, array, timestamp, and compressed data.   

Compressed blocks are zlib streams beginning with bytes `78 9C`; the C++ uses `inflateInit` and `inflate`, stores inflated bytes in `compressedData`, skips 4-byte separators between compressed chunks, and expects a final `0xffff0000` marker near the end. A Node/TypeScript port should use normal zlib inflate, not raw DEFLATE, because the stream includes a zlib header.  

For each state, `CivVIState::Parse` takes `Parser.compressedData.back()` and runs this sequence: `ParseTurn`, `ParseMap`, `ParseDisaster`, `ParsePlayers`, `ParseVisibility`, `UpdatePointer`, then optionally `ComputeDistrictProxi`, `ComputeCityLine`, and `ComputeTileYields` when assets/database data are available.  

## What it extracts directly

**Map and tiles.** `ParseMap` searches for a `MAP_BEGIN` byte pattern, reads tile count, then loops every tile. It extracts tile index, terrain, feature, continent, resource and count, improvement, road and road level, appeal, river info, cliffs, pillage flag, overlay data, and, when a “found” bit is set, ownership/city/district/player/wonder fields. Width is read after the tile block.  

**Visibility.** `ParseVisibility` searches for `VISIBILITY_BEGIN`, then for each player reads arrays for visible tiles, in-sight counts, known improvements, known resources, another unknown tile array, and in-sight unit counts. `UpdatePointer` later aggregates player visibility into team visibility.  

**Cities.** Inside `ParsePlayers`, the city block extracts each city’s `id`, `x`, `y`, `population`, `name`, `religion`, current production type, current production item hashes, production-progress maps, built-item maps, and later per-city yield maps. The `City` structure stores `yields`, `yields2`, `currentProds`, `currentProdType`, `prod`, and `built`.    

**City production.** Current production is parsed from records starting with sentinel `0x2C0F4A46`; `currentProdType` is one of unit, building, district, wonder, or project, and the item hash goes into `city.currentProds`. The UI displays production progress as `city.prod[item] >> 8`, so those production values are fixed-point-ish integers with fractional bits in the low byte.   

**City yields.** Near the end of each player parse, it loops over cities again, validates by city id, then assigns `city.yields = readMapFloat(it)` and `city.yields2 = readMapFloat(it)`. `readMapFloat` decodes each 4-byte value as `(value >> 8) + (value & 0xff) / 256`. The UI prints both yield maps per city.   

**Player yields and totals.** `UpdatePointer` sums every city’s `city.yields` into `player.yields`. `CivVIGame::UpdateStats` then accumulates `player.totalYields[yield] = previous.totalYields[yield] + current.yields[yield]`. The UI uses fixed yield hashes for food, production, science, culture, faith, and gold.   

**Techs and civics.** Each `Player` has two `TechDogmeInfo` objects: `TECH` and `DOGME`/civics. The parser extracts `found`, `boost`, `research`, `current`, and later `turnTo` maps for both. `UpdateStats` detects “hard” tech/civic completions by comparing `found` maps across adjacent turns and checking boost status.      

**Government and policies.** The player parser reads `government`, `lastTurnChangeGovernment`, several government/card maps, then policy entries as `(policy, position)` and pushes them into four policy slots, with slot position `4` coerced to `3`.  

**Units.** The unit block extracts each unit’s `id`, `type`, `x`, `y`, `army`, `damage`, `fortified`, `xp`, and `level`. Unit type metadata such as health, movement, range, attack, and defense is parsed later into `unitsInfo`. `UpdatePointer` links units onto their tiles and uses `UnitInfo` to compute military strength.    

**Active trade routes.** The TypeScript analyzer decodes trader `UNITOPERATION_MAKE_TRADE_ROUTE` endpoint coordinates, matches them back to parsed city centers, and classifies routes as domestic, international, and same-team where lobby team metadata is available. It also computes conservative known-component route yields from `District_TradeRouteYields` and active route-yield policy modifiers with unconditional/domestic/international scopes. This is not the same as the exact UI route-yield total.

**Districts.** The district block extracts district `globalId`, local `id`, `x`, `y`, `cityId`, `type`, damage, wall damage, wall, cost, built flag, and pillage flag. `UpdateStats` uses this to record when each district first appears and when it becomes built.   

**Governors.** The governor block extracts each governor’s `id`, `type`, assigned `player`, assigned `city`, assignment/transition `turn`, and active promotions. `UpdatePointer` resolves the governor onto the target city by matching `governor.player` and `governor.city`; unassigned governors appear to use `0xffff` for player.   

**Improvements.** The parser has a player-level improvements snapshot: each `Improvement` stores `x`, `y`, `district`, and `type`. Separately, every tile also has `tile.improvment`, road, resource count, and pillage status from `ParseMap`.   

**Strategic resources, faith, gold, diplo favor, great people, era state.** The player parser extracts current/gain/give/prod/max strategic resources, `faith`, `pantheon`, `gold`, `diploFavor`, `diploPoint`, maintenance, great people points/current values, great people lists, age state, commemorations, era points, tourism, and several other victory/progression stats.     

**City-state roster and influence.** The TypeScript analyzer now post-processes parsed player/city snapshots to identify city-state capital city names using a bundled city-state table plus optional `DebugGameplay.sqlite` data (`Civilizations`, `CivilizationLeaders`, `Leaders`, and `CityNames`). This exposes city-state civilization/leader/category, owner player id, capital coordinates, alive/captured presence, decoded influence-token envoy counts, and suzerain player. Opening reports aggregate those snapshots to show city-states that disappeared during the parsed window as `notPresent`.

## What it does **not** really extract

It does **not** fully decode “what each builder did” as an action history. It recognizes unit-operation hashes including `UNITOPERATION_BUILD_IMPROVEMENT`, `UNITOPERATION_BUILD_ROUTE`, `UNITOPERATION_PILLAGE`, and `UNITOPERATION_REPAIR`, but the code only uses those hashes to skip different byte lengths; it does not store operation details on the unit or emit action events. 

It also does not directly emit “city X completed Y on turn N” as a complete action stream. It extracts current production, production progress, built-item maps, units, districts, and buildings/wonders snapshots; the TypeScript analyzer only emits built-item completions when an existing-city built map entry moves from absent/`0xffff` to a real 1..65534 value. Exact purchases, exact hut rewards, exact UI trade-route yields/length, dark/golden age thresholds, and exact river adjacency still need additional parsing. Active route endpoints and conservative known-component route yields are available, but route-yield buildings/wonders, civ traits, great people, governments, commemorations, alliance type/level effects, and other modifier scopes are not fully modeled. City-state envoy counts and suzerain player are decoded from the minor player's influence-token array, matching Civ VI UI concepts like `Players[minorId]:GetInfluence():GetTokensReceived(majorId)`, `GetMostTokensReceived()`, and `GetSuzerain()`. City-state quests, visibility, and turn-by-turn envoy/suzerain-change events are still unsupported.  

The parser leaves many blocks as skipped bytes with comments like “unknown,” “maybe,” or contextual hints. So a TypeScript port should preserve its useful known fields, but treat the current C++ as a practical reverse-engineered cursor walk, not a complete formal save-file schema.   

## Hashes and name resolution

Most identifiers in the save are 32-bit hashes. The project resolves names through Civ’s gameplay database and the same CRC convention. `Crc32` is standard table-driven CRC-32 starting from `0xffffffff` and returning `~Result`; assets and database identifiers often use `~Crc32("TYPE_NAME")` as the stored hash. `Assets::GetCrc(folder, name)` builds uppercase `FOLDER_NAME` and returns `~Crc32(fullName)`.  

The database loader reads `%LOCALAPPDATA%/Firaxis Games/Sid Meier's Civilization VI/Cache/DebugGameplay.sqlite`, falling back to `./image/database/backup.sqlite`. It queries tables such as `Types`, `TERRAIN_YIELDCHANGES`, `FEATURE_YIELDCHANGES`, `Resource_YieldChanges`, `IMPROVEMENT_YIELDCHANGES`, `IMPROVEMENT_BONUSYIELDCHANGES`, `Governors`, and `Features` to resolve assets, static tile yields, governor transition data, and natural wonders.   

For TypeScript, implement hash helpers like:

```ts
export function crc32(buf: Uint8Array | string): number {
  // Return unsigned standard CRC-32 result equivalent to Crc32() in Crc.h.
  // Then civHash(type) below applies bitwise NOT as CivVIReplay does.
}

export function civHash(type: string): number {
  return (~crc32(type)) >>> 0;
}

export function assetHash(folder: string, name: string): number {
  return civHash(`${folder.toUpperCase()}_${name.toUpperCase()}`);
}
```

## TypeScript CLI architecture I would build

Use a staged parser, not one monolithic 4,000-line function:

```txt
src/
  bin/civ6replay.ts
  binary/reader.ts          // offset, readU8/U16/U24/U32LE, readString, skip, find, assert
  binary/crc.ts             // CRC32 and Civ hash helpers
  parser/packet.ts          // top-level packet arrays + compressed blob extraction
  parser/turn.ts            // parseTurn, parseMap, parseDisaster, parseVisibility
  parser/player.ts          // parsePlayers split into named sections
  model/state.ts            // Tile, City, Player, Unit, District, Governor, etc.
  postprocess/pointers.ts   // city/tile/unit/governor linking
  postprocess/yields.ts     // tile yields from DB static modifiers
  postprocess/districts.ts  // adjacency/proximity
  diff/events.ts            // inferred per-turn events
  db/resolver.ts            // DebugGameplay.sqlite/backup.sqlite hash<->name resolver
```

Start by reproducing the exact C++ parser behavior for the stable fields: file magic, compressed blob extraction, turn number, map width/tile count, city count, city names, unit count, districts, governors, and city yields. Add strict cursor bounds checks and optional trace logging around every sentinel. The original parser uses many `assertT` checks and fixed offsets; your TS port should report structured parse errors with offset, expected value, actual value, and section name.   

Then implement post-processing equivalent to `UpdatePointer`: create `player.pCities[city.id]`, set `tile.city`, set `tile.district`, link units to tiles, link governors to assigned cities, sum city yields into player yields, compute total population, military strength, team visibility, tileWorked, and freeTile. 

Finally implement a separate diff layer. The C++ already compares consecutive turns only when `state.turn - previousState.turn == 1`; that is a good rule for your CLI too. Your diff layer should produce normalized JSON events rather than mixing event logic into the binary parser. 

## Event inference for the things you care about

For **settles**, diff cities by `(playerId, cityId)` between turn `N-1` and `N`. A new city gives you `x`, `y`, name, owner, founding turn, center tile, first-ring tiles, second-ring tiles, nearby resources, appeal, fresh water/river, features, improvements, and computed tile yields. Use the tile fields from `ParseMap` plus `ComputeTileYields`-style static modifiers.   

For **nearby yields**, compute rings around the city center using the hex-grid neighbor logic. The viewer’s neighbor function handles horizontal map wrap; `District::getDirectNeighbours` uses even/odd row offsets but does not wrap. For settle analysis, I would implement a single hex helper with an explicit `wrapX: boolean` option.  

For **city completed production**, diff several signals: `city.built` entries newly present or changing from `0xffff`; new districts for that city; new units owned by the player that were not present last turn; changes in `currentProdType/currentProds`; and production-progress resets or drops in `city.prod`. This will be heuristic but useful. The repo itself displays current production and built maps but does not fully label completion events.  

For **builder actions**, diff tile snapshots: improvement changed, road/road level changed, feature removed, resource count changed, pillage flag changed, or improvement repaired. Attribute to the nearest alive builder owned by the same player on the previous turn, or improve the unit-operation parser later to decode the skipped `UNITOPERATION_BUILD_IMPROVEMENT`/`BUILD_ROUTE` records. The current repo only counts newly created builders by comparing unit ids across turns.   

For **governors**, diff governor id across turns: unassigned to assigned, city change, promotion changes, and transition turn changes. Since `UpdatePointer` links governor to a city, your output can include governor type, assigned city id/name, city coordinates, and nearby city/tile yields.   

For **tech/civic events**, diff `found`, `boost`, `current`, `research`, and `turnTo`. The C++ “hard tech” detection is specifically “found changed and not boosted,” but for analytics I would output all transitions: boosted, completed, started researching, research progress changed, and turns-to changed.    

## Practical output schema

A useful CLI could produce one JSONL record per turn:

```json
{
  "turn": 57,
  "timestamp": 1234567890,
  "players": [
    {
      "id": 0,
      "gold": 312,
      "faith": 74,
      "yields": {
        "YIELD_FOOD": 58.5,
        "YIELD_PRODUCTION": 42.25,
        "YIELD_SCIENCE": 67.0
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
          },
          "yields": {
            "YIELD_FOOD": 12.5,
            "YIELD_PRODUCTION": 18.0
          },
          "governor": "GOVERNOR_THE_BUILDER"
        }
      ]
    }
  ],
  "events": [
    {
      "type": "cityFounded",
      "player": 0,
      "cityId": 3,
      "x": 41,
      "y": 22,
      "firstRingYields": {
        "YIELD_FOOD": 11,
        "YIELD_PRODUCTION": 8
      }
    }
  ]
}
```

The most important design choice is to keep **raw snapshot extraction** separate from **derived event inference**. `CivVIReplay` mixes some of these ideas, but its reliable core is the per-turn snapshot parser; the richer analytics you want will come from deterministic diffs over those snapshots.
