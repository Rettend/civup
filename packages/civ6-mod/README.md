# `@civup/civ6-mod`

Worker-compatible TypeScript generation of one combined Civilization VI CivBlitz mod ZIP for all completed kits in a match. Runtime code uses only web-platform primitives; it does not read the filesystem, call CivBlitz, or require a local Civilization VI install.

## Public API

```ts
import type {
  CivBlitzModInput,
  CivBlitzModSeatInput,
  GeneratedCivBlitzModFiles,
} from '@civup/civ6-mod'
import {
  CivBlitzModError,
  generateCivBlitzModFiles,
  generateCivBlitzModZip,
  isCivBlitzModError,
} from '@civup/civ6-mod'
```

- `generateCivBlitzModFiles(input): GeneratedCivBlitzModFiles` returns `archiveFilename`, the deterministic mod UUID as `modId`, and sorted `{ path, content }` files.
- `generateCivBlitzModZip(input): Uint8Array` writes those files as a deterministic, standards-compliant stored ZIP suitable for a Worker `Response`.
- `CivBlitzModError` exposes `code`, `status`, and `safeMessage`. `isCivBlitzModError()` is the corresponding type guard.
- `CivBlitzModInput` contains `matchId`, `leaderDataVersion`, `excludeBbgExpanded`, and contiguous seat-ordered entries with `seatIndex`, `displayName`, and a complete `CivBlitzKit`. Player display names are validated for diagnostics but are not written into the shared mod.

```ts
const zip = generateCivBlitzModZip(input)
return new Response(zip, {
  headers: {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${generateCivBlitzModFiles(input).archiveFilename}"`,
  },
})
```

The mod UUID and bounded `CIVILIZATION_IMP_*` / `LEADER_IMP_*` IDs derive only from the normalized `matchId`, data version, and canonical set of completed kits. Moving kits between players during the teammate swap window does not change the archive. Player names do not affect its IDs or contents. The `.modinfo` title, description, and teaser identify the match by `matchId`.

## Support policy

The generated mod contains gameplay/frontend rows, copied source and granted traits/items, colors, icon aliases, English custom-leader localization, source start biases and geography, BBG adjacency compatibility, leader/civilization/culture/landmark art aliases, and the related layered leader-scene integration. Traits that represent multiple frontend items emit every item; for example, Street Carnival emits both the land and water districts. A kit is rejected if any selected primary or granted game trait overlaps another selection anywhere in the combined mod.

Each archive contains one `.modinfo`. Its `<Files>` section lists every other archive payload exactly once and omits the `.modinfo` itself, following the Civilization VI manifest convention. Only the generated `Art.dep` is referenced.

All currently registered default (non-BBG-Expanded) live and beta component IDs resolve to the generated catalog. Four components are intentionally rejected because the proven upstream normal-card registry marks their traits unsafe to transplant:

- `civblitz:civilizationAbility:babylon`
- `civblitz:civilizationAbility:byzantium`
- `civblitz:unit:p-51-mustang`
- `civblitz:unit:u-boat`

`excludeBbgExpanded` must be `true`. BBG Expanded kits fail before generation with `BBG_EXPANDED_UNSUPPORTED`; the package does not silently omit their external dependency and art metadata.

## Catalog provenance

`vendor/civ-blitz` is the minimum source-data/static-resource subset from MIT-licensed Civ Blitz commit `413d329664183ab13b5f889df0bea62dc2131131`. `src/generated` is reproducible from it and the persisted `@civup/game` registry:

```sh
bun run --cwd packages/civ6-mod generate
```

To refresh the vendored source from that exact checkout:

```sh
bun run --cwd packages/civ6-mod vendor:upstream C:/path/to/civ-blitz
bun run --cwd packages/civ6-mod generate
```

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and [`vendor/civ-blitz/LICENSE.txt`](./vendor/civ-blitz/LICENSE.txt). Every generated mod includes the required MIT text as `LICENSE.txt`; repository-level provenance remains in `THIRD_PARTY_NOTICES.md`.
