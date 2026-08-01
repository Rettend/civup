# Draft lobby game settings

The draft setup Activity shows a compact game-settings card in the players column. Opening it provides a local editor and an on-demand public preset browser; opening the editor does not read D1.

## Official preset

The built-in `Official PPL preset` is code-owned and available without a database read:

- hut frequency: `1.75×`
- ridges: Standard
- diplomatic and cultural victories: disabled
- MPH / CivLan timer: `30 + average cities × 2 + average units × 0.5 + MPH timeshift`
- Defender of the Faith, God of the Forge, Colosseum, and Temple of Artemis: banned
- automatic leader exclusions: none

Maps are intentionally outside this settings model. All values except automatic leader exclusions are a lobby checklist; the Activity does not configure Civilization VI or MPH.

## Profiles and modes

`packages/game/src/game-settings.ts` owns the versioned, strictly validated profile schema. A profile contains complete base settings plus sparse per-mode overrides. Changing lobby mode resolves the already-copied profile locally and does not read the preset catalog.

Profiles reject unknown fields, unsupported schema versions, unknown leader IDs, oversized payloads, and out-of-range values. Automatic exclusions are selected against the lobby's BBG data version and are applied before standard, random, and hidden draft pools are built. Red Death and CivBlitz pools ignore them.

## Persistence

SessionDO stores the applied profile and preset attribution at the top level of the session record. Draft start freezes that copy with the session and writes it into match `draft_data`. A community preset is copied into a lobby when applied, so later catalog edits do not alter that lobby. Legacy lobby, session-directory, and match records resolve to the Official preset in memory without eager writes.

Community presets use D1 migration `0025_game_settings_presets.sql`. The authenticated catalog API supports create, list, update, and delete with owner-only mutations, optimistic revisions, normalized unique names, and a maximum of ten presets per owner. The Activity fetches the bounded catalog only when Browse presets is opened and caches it for the current authenticated Activity session.
