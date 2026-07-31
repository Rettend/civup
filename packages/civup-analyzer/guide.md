# Autosave analyzer

Run the analyzer from the repository root with Bun. It reads a `.Civ6Save` file or a ZIP of autosaves. Keep saves and generated reports in ignored local storage.

## Commands

```sh
bun run civup parse tmp/autosaves.zip
bun run civup lobby tmp/autosaves.zip
bun run civup snapshot tmp/autosaves.zip --turn 1
bun run civup opening tmp/autosaves.zip --focus Lincoln --to-turn 50
bun run civup science tmp/autosaves.zip --turn 70
```

- `parse` lists saves, turns, players, leaders, mods, and map metadata.
- `lobby` shows seeds, slot order, teams, and game settings from one save.
- `snapshot` extracts turn-by-turn map, player, city, unit, and district state.
- `opening` summarizes a player's opening, including yields, city founding, research, production, and governors.
- `science` shows observed science and the components the parser can explain.

Use `--focus` with a player, leader, or civilization, or `--player-id` with a slot number. `--from-turn` and `--to-turn` select an opening window. `--help` lists all options.

## Save and compare reports

```sh
bun run civup snapshot tmp/autosaves.zip --jsonl --out tmp/snapshots.jsonl
bun run civup opening tmp/baseline.zip --focus Lincoln --json --out tmp/baseline.json
bun run civup opening tmp/my-game.zip --focus Lincoln --json --out tmp/my-game.json
bun run civup compare-opening tmp/baseline.json tmp/my-game.json
```

Comparisons show differences in city timing, yields, research, and other milestones. Negative timing differences mean the second report reached a milestone earlier.

## Game data and limits

The analyzer uses the local Civ VI `DebugGameplay.sqlite` database when available to resolve names and gameplay values. Pass `--types-db <path>` to select another database or `--no-types-db` to use only bundled names.

Reports combine saved state with changes between consecutive turns. Missing turns can hide events. Purchases, combat losses, builder actions, and some mod effects cannot always be distinguished. Science that the parser cannot explain appears as `modifier/unattributed`; trade-route yields include only known components.

To replay a map, use `lobby` to inspect both random seeds, leaders, slots, teams, map settings, and mods. Matching seeds alone does not reproduce the same starting positions.
