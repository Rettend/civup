# Toolchain Migration Plan

Move the workspace to Vite+ and Vite 8, Oxlint/Oxfmt, stable TypeScript 7, Solid 2 with Router 2, and Cloudflare's `cf` CLI with shared TypeScript configuration.

This is an implementation plan, dated 2026-10-05. The source baseline is `947209c6`, now on `origin/main`. Before planning, the existing type/copy checks, 1,097 workspace tests, and Activity development build passed. The proposed dependency combination has not yet been installed or tested in this repository.

## Implementation choices

- Keep Bun as the package manager and script runner. Run Vite+/Cloudflare tooling under a supported Node 24 release, at least 24.11. The Cloudflare TypeScript config loader explicitly rejects execution under Bun.
- Let Vite+ supply its coordinated Vite, Vitest, Oxlint, and Oxfmt versions. Use the Vite 8 version bundled with Vite+, rather than overriding its internals with an independently newer Vite.
- Move Activity tests to Vitest. Keep the bot and existing package tests on Bun, including their SQLite helpers. The root test command runs the package scripts for both runners.
- Keep the Activity as a client-rendered application with explicit routes and the existing bot API. Use the Solid 2 plugin in ordinary SPA mode.
- Use the Vite-backed Cloudflare build for Activity. Start the bot on `cf`'s Wrangler-backed builder, preserving its existing binary imports. Its generated `wrangler.config.ts` contains build settings; `cloudflare.config.ts` owns deployment configuration.
- Keep the two Workers and the two existing deployment targets. Both accounts use `civup-bot` and `civup-activity`; target selection must not append Worker-name suffixes.
- Preserve current public command names where practical. In particular, `deploy:prod` currently selects the standard account; PPL has its own runner.

Implementation and verification are local work. Deployment, remote migrations, secret uploads, Discord registration, and production maintenance require the user's explicit request under the repository's existing rules.

## Dependency starting point

These are the versions checked during investigation. Recheck compatibility when starting, then pin the selected prerelease set exactly in the manifests and lockfile.

| Component | Starting version / choice |
| --- | --- |
| Vite+ | `1.0.0`; its Vite core reports `8.3.1` |
| Vitest | Vite+'s `5.0.1`; match any UI/coverage packages |
| Oxlint / Oxfmt | Vite+'s `1.85.0` / `0.70.0` |
| TypeScript | Stable `typescript@7.0.2`, using `tsc` |
| Solid core / web | `solid-js@2.0.0-rc.13`, `@solidjs/web@2.0.0-rc.13` |
| Solid compiler integration | `@solidjs/vite-plugin@3.0.0-next.47`; matching compiler packages through its dependencies |
| Router | `@solidjs/router@2.0.0-next.35` |
| Solid Testing Library | `@solidjs/testing-library@1.0.0-beta.3` |
| Solid primitives | `storage@5.0.0-next.4`, `scheduled@2.0.0-next.2` |
| Solid lint plugin | `eslint-plugin-solid@0.18.1`, through Oxlint's JS plugin support |
| Cloudflare CLI / config | `cf@1.0.0-beta.12`; use its compatible `@cloudflare/config` version |
| Cloudflare Vite plugin | Evaluate `1.62.5`'s experimental new-config/build-output support with the pinned CLI |

Router's `latest` tag still targets Solid 1. Install the explicit Router 2 version. Pin Solid's compiler/runtime/router/testing packages as a compatible set; avoid global overrides that hide incompatible peer requirements.

The useful sibling references are `../gau/package.json` and `../gau/vite.config.ts` for Vite+, and `../oneday/.oxlintrc.json` / `.oxfmtrc.json` for the Antfu-style rules. Both siblings still use Wrangler TOML. Oneday's older Solid plugin and custom Bun transform loader are not a compatible template for the newer plugin without adaptation.

## 1. Establish Vite+ and Vite 8

**Files:** root and Activity `package.json`, `bun.lock`, a new root `vite.config.ts`, `apps/activity/vite.config.ts`, and a Node version pin.

1. Add Vite+ and the Vite core alias using Gau's catalog/compatible-range override pattern. Inspect the resulting dependency graph for duplicate Vite or Vitest versions.
2. Standardize the Node requirement. Keep the existing Bun pin unless compatibility requires a change; if it changes, update all workspace `packageManager` declarations together.
3. Add the root Vite+ configuration for workspace lint/format settings. Keep Activity's application plugins and build settings in its own config.
4. Change Activity build/live scripts to `vp build` / `vp dev`. Preserve development, standard, and PPL build modes while the old Cloudflare configs still exist.
5. Keep Solid 1 during this first step. Use a Vite-8-compatible `vite-plugin-solid` 2.x release to establish a working toolchain before changing application semantics.
6. Update UnoCSS packages as a coordinated set to versions supporting Vite 8. Check the custom development CSS link, extraction of source tokens, and generated production CSS.
7. Upgrade the Cloudflare Vite plugin to a Vite-8-compatible release while retaining legacy Wrangler config loading for this step. New TypeScript config and production Worker build integration happen in step 6.
8. Preserve the `~` alias, allowed development host, no-cache headers, asset revision map, and browser Discord application-ID definition. Remove existing Solid distribution aliases only when their replacement resolution has been verified.

Do not import Activity's application config into the root lint/format config: doing so currently reads asset directories and expects Discord configuration, neither of which a lint command should need.

Before the broad source conversion, use a temporary local fixture to prove that the pinned Cloudflare plugin/CLI can consume a Vite+ build with the new config and that the bot's Wrangler-backed builder handles its binary imports. Also prove that the selected Solid 2 plugin can render a component under Vitest. Keep these compatibility probes small; report a concrete package/API incompatibility before committing to the larger migration.

## 2. Replace lint/format tooling and adopt stable TypeScript 7

**Files:** root `vite.config.ts`, `eslint.config.js`, `scripts/eslint-player-copy.js`, root/workspace manifests, `tsconfig.json`, app/package tsconfigs, and editor settings that select ESLint or a formatter.

### Lint and formatting

1. Start from Oneday's rules, expressed in Vite+'s root `lint` block. Use native ESLint, TypeScript, import, Unicorn, Node, and Oxc rules; use JS plugins for the Solid and player-copy rules.
2. Scope environments and overrides appropriately for browser code, Workers, Bun scripts/tests, and Node-loaded configuration. Do not make browser globals valid throughout server code just to suppress diagnostics.
3. Preserve the current conventions: separate type imports, smart equality, unused-argument underscore exceptions, practical console rules, and the project's short statement style where Oxfmt permits it.
4. Configure Oxfmt for single quotes, no semicolons, two-space indentation, `arrowParens: avoid`, consistent property quotes, and the existing import groups. Check import sorting against side-effect imports such as CSS and startup modules before enabling it across the repository.
5. Set generated/artifact ignores explicitly, including `dist`, `.wrangler`, `.cloudflare`, coverage, caches, and saved investigation output. Avoid formatting vendored/generated data or historical documents as part of this migration.
6. Audit UnoCSS lint rules individually. Carry working rules through JS plugin support; record any unsupported rule instead of silently claiming exact Antfu parity. Class ordering must remain UnoCSS-aware.
7. Translate useful disable comments to supported rule names. Inspect unused directives before applying bulk cleanup.

Keep `lint` read-only, add `lint:fix` for changes, and provide `format` / `format:check`. Put broad mechanical formatting in its own commit after semantic conversions, so runtime changes remain reviewable.

### Preserve the player-copy check

Extract the detection logic from `scripts/eslint-player-copy.js` into a reusable local rule. Preserve its message contexts, template-literal handling, JSX text checks, and exclusions for logs/technical text.

`check:copy` currently runs with ESLint's `--no-inline-config`. The replacement must still check all `apps/*/src/**/*.{ts,tsx}` without allowing inline disable comments to hide a violation. Confirm whether the pinned Oxlint supports this behavior. If it does not, use a small standalone AST checker sharing the same detection logic, while exposing the rule through Oxlint for editor feedback.

Add focused fixtures for a player message, an allowed log, JSX/template text, and an attempted inline suppression. These protect behavior that could otherwise disappear when ESLint is removed.

### TypeScript

1. Remove direct ESLint/parser dependencies once the replacement checks work. Then replace `@typescript/native-preview` with stable TypeScript 7 and update workspace `check` scripts from `tsgo --noEmit` to `tsc --noEmit`.
2. Check any remaining compiler-API consumers separately. TypeScript 7.0 has no equivalent JavaScript compiler API; a transitive tool needing TypeScript 6 must receive that compatibility dependency without taking over the workspace's native `tsc`.
3. Review explicit environment `types`, side-effect import declarations, module resolution, and path aliases against TypeScript 7 defaults. Resolve diagnostics rather than adding blanket exclusions.
4. Add a focused tools tsconfig/check for the new Vite, Vitest, Cloudflare, and shared target modules. Do not accidentally typecheck every historical PPL repair script as a side effect of adding config coverage.
5. Keep `check` as the familiar aggregate for copy checks and workspace/tooling typechecks. Document lint and format checks alongside it rather than maintaining a second typecheck system with different coverage.

## 3. Move Activity tests to Vitest while still on Solid 1

**Files:** `apps/activity/package.json`, a new `apps/activity/vitest.config.ts`, `apps/activity/tests/setup-dom.ts`, `apps/activity/tests/ui-mocks.tsx`, Activity test files, root `bunfig.toml`, `tests/setup-activity-dom.ts`, and root test/coverage/UI scripts.

1. Create a dedicated Vitest config importing `defineConfig` from Vite+. Use the actual Solid Vite plugin and a browser DOM environment; begin with Happy DOM to minimize unrelated test changes.
2. Keep test config independent of Worker builds, Cloudflare account selection, asset scanning, and real Discord environment files. Include only Activity test files.
3. Replace `bun:test` imports and Bun mock APIs with Vitest equivalents. Rewrite module mocks with explicit hoisting/import order; preserve test isolation and intentional real exports.
4. Replace the direct `Bun.plugin` transform call and deep `solid-js/web` mock with Vite's supported compilation/resolution path. Port only needed DOM polyfills and cleanup. Check fetch, streams, timers, and response bodies against the selected DOM environment.
5. Convert scheduler assumptions into observable assertions. Prefer framework settling helpers or `waitFor`; avoid arbitrary sleeps and blanket timer flushing.
6. Remove root Activity-preload routing after its consumers have moved. Keep Bun-only tests out of Vitest discovery and Activity tests out of the supported Bun test commands.
7. Keep the root package-script-based `test` orchestration. Replace root `test:cov`, which currently invokes repository-wide `bun test`, with runner-specific coverage commands and separate output directories. Make `test:ui`'s Activity Vitest scope explicit and remove `bun-test-ui` if no supported command uses it.

Move the existing 33 Activity test files before adding Solid 2 changes. This gives compiler/test-runner failures a separate checkpoint from changes to reactivity. If a dependency incompatibility prevents the Solid 1/Vitest 5 bridge, document the specific incompatibility and combine this step with step 4 while preserving the original test assertions.

## 4. Migrate Solid 2 and Router 2

**Files:** Activity dependencies and JSX config; `src/client/index.tsx`, `App.tsx`, `activity/`, `stores/`, affected components/pages, and their tests.

Read the cheatsheet shipped with the selected Solid 2 version and the matching migration guides before coding. Current inventory: 47 TSX files, 56 normal effects, three render effects, three stores, and 11 route declarations. There is no substantial resource/cache/action layer to convert.

### Runtime, state, and components

1. Upgrade the coordinated Solid package group and replace `vite-plugin-solid` with `@solidjs/vite-plugin`. Move web imports to `@solidjs/web`, store imports into core, and `jsxImportSource` to `@solidjs/web`.
2. Replace old distribution aliases with supported browser resolution and runtime deduplication. Confirm the application and tests resolve the same Solid generation.
3. Convert `stores/draft-store.ts` first: object patches, path setters, `produce`, nested array updates, and snapshot replacement. Preserve one coherent application of each server snapshot.
4. Convert `stores/ui-store.ts` and its storage primitive. Preserve the `civup:activity:ui` key, saved-data shape, normalization, and serialized representation so players retain their preferences.
5. Review exported setter wrappers and `lib/optimistic-state.ts`. Distinguish passing a function as a stored value from passing an updater; do not mechanically rewrite both cases the same way.
6. Convert effects to Solid 2's dependency/side-effect model. Start with `ActivityShell.tsx`, `LeaderGridOverlay.tsx`, and `useDraftSetupConfigState.ts`; preserve request cancellation, revision checks, serialized saves, and optimistic acknowledgements.
7. Review render effects, mount cleanup, refs, custom memo equality, portals, and class handling in `PlayerSlot.tsx`, `DraftTimeline.tsx`, and the grid. Measurements and scrolling must happen against connected DOM nodes.
8. Convert the app's loading boundary and transition/batching APIs according to the selected release. Use the storage/scheduling primitive versions compatible with that runtime; retain cancellation of pending preview sends.
9. Replace mutable test-store mocks with state helpers using supported Solid 2 updates. Update the Solid lint settings to version 2 and enable its removed-API, effect, prop, and store-mutation checks.

### Routes and shell lifetime

1. Define one module-level Router 2 instance using explicit routes. Keep the existing URL paths, parameter names, wildcard behavior, and lazy route modules.
2. Keep practice outside the authenticated shell, embedded routes under `/`, and browser routes under `/web`.
3. Reuse a shell when navigating within its surface. Dispose it when crossing surfaces or entering practice, closing its sockets and clearing the appropriate shared state.
4. Port state-driven navigation and the pending/back/resume guards together. Preserve the relationship between selected lobby/match state and the URL.
5. Keep Discord SDK readiness/authentication and browser OAuth redirects in their existing platform/shell flow. Keep admin capability checks attached to the same actions.
6. Leave ordinary dynamic-import preloads as module preloads unless Router 2 requires a specific change. Do not introduce server functions or filesystem routing to replace the current small route table.

`stores/connection-store.ts` remains responsible for transport and retry behavior. The migration must preserve stale-response rejection, optimistic-pick clearing, terminal disconnects, and hidden-Activity reconnect behavior. The focused regression cases are in the verification section below.

## 5. Introduce shared Cloudflare target data

**New module:** `config/cloudflare-targets.ts`.

Define a typed, plain-data record for `standard` and `ppl`. It supplies:

- Cloudflare account ID and the two Worker names.
- Discord application/client ID, public key, guild settings, and Activity origin.
- D1 database identity, KV namespace identity, optional R2 bucket, and migration directory/table settings.
- Target-specific public variables and compatibility differences.

This module must be importable by both Bun maintenance scripts and Node-loaded configuration. Keep secrets in the existing environment/secret files. Do not load Cloudflare configuration or contact APIs while importing target data.

Use a single proposed selector, `CIVUP_TARGET=standard|ppl`, in app configs and command wrappers. This is a repository convention, not an assumed `cf` option. Existing standard and PPL entrypoints set it explicitly. Pass a separate local/remote choice to storage commands; selecting PPL must not itself turn a local command into a remote one.

Keep target resolution pure enough to test independently. Resolve accounts and resource IDs together instead of allowing the same database or Worker name to select either account accidentally. Preserve useful explicit overrides such as `DRIZZLE_DB_URL`.

## 6. Migrate Worker configuration, builds, and command callers

**Config files:** new `apps/bot/cloudflare.config.ts`, `apps/bot/wrangler.config.ts`, and `apps/activity/cloudflare.config.ts`; updated `apps/activity/vite.config.ts`. These replace `apps/bot/wrangler.jsonc`, `apps/bot/wrangler.ppl.jsonc`, `apps/activity/wrangler.json`, and `apps/activity/wrangler.ppl.json` once active callers are migrated.

### Configuration and build output

1. Run the pinned `cf` migrator in dry-run/no-install mode for each existing config, including explicit PPL paths. Review its generated shape before writing the two `cloudflare.config.ts` files.
2. Derive each Worker config from the shared target module. Use the actual typed schema: account, Worker, environment/bindings, triggers, and Durable Object exports; do not cast a Wrangler-shaped object into the new type.
3. Preserve the compatibility dates/flags, service binding, assets, schedules, Durable Object class names and complete migration history, database/KV/R2 identities, and migration paths.
4. Preserve deliberate differences: PPL's `global_fetch_strictly_public`, font import rule, guild allowlist, and the standard bot's current debug variable. A tooling migration must not silently change their behavior.
5. Add a bot build-only command using the Wrangler-backed builder. Verify `@resvg/resvg-wasm`, font imports, and exported Durable Object classes in its generated artifact.
6. Enable Activity's new-config/build-output support in the compatible Cloudflare Vite plugin. Its current plugin is serve-only, so explicitly integrate the Worker proxy and client assets into production build output.
7. Replace `loadProductionDiscordClientId()` with public target data. Development still uses the development Discord app; standard/PPL builds use the selected target. Production builds must not fall back to local development values.
8. Use explicit builds followed by `cf deploy --prebuilt` in deployment wrappers, avoiding cf's default rebuild. Record the target and browser application ID beside build output and reject a prebuilt artifact belonging to another target.
9. Choose an explicit shared local persistence directory, preserving the current development state location where supported. Pass it consistently to development, local migrations, and storage tools. Use a separate temporary directory for migration verification.
10. Update `.gitignore` for generated `.cloudflare` output and any new runner caches. Keep authored TypeScript config and the shared target module tracked.

The plugin/config/CLI build-output combination is an early compatibility check in this step. Pin the combination that actually builds both Activity assets and its Worker; do not force-install incompatible peer ranges or assume the newest Cloudflare beta fixes an unexamined failure.

### Active command migration map

Prefer one small target/transport helper for active scripts. Normalize results there rather than duplicating CLI JSON parsing. Check each command's actual support: passing `--config cloudflare.config.ts` to every Wrangler command does not work.

| Files | Required change |
| --- | --- |
| Root and app manifests | Route lifecycle commands through selected targets; add bot build-only commands; migrate type generation and resource setup individually. |
| `scripts/dev.ts` | Replace its direct child commands as well as package scripts. Preserve ports 8787/5173, working directories, cached-preview/live modes, missing-build checks, and Windows process-tree cleanup. |
| `scripts/upload-worker-secrets.ts` | Keep the two-secret allowlist per Worker and stdin transport. Resolve the selected account/Worker explicitly. Its current dry run checks keys only; add an offline command/target check using fixture secrets. |
| `ppl/ppl.ts` | Keep migrations, bot, Activity, optional registration, and guarded BBG release in order. Add a command-preview path that returns before credentials are loaded or children are spawned; running with no arguments currently deploys. |
| `apps/bot/src/register.ts` and registration scripts | The registration entrypoint independently reads application/guild IDs from its environment. Supply the selected public target values through standard/PPL wrappers; keep development registration on its development environment. `CIVUP_TARGET` alone does not retarget registration. |
| `ppl/bbg-release.ts`, `ppl/season-history.ts` | Migrate shared identity lookup and D1/KV transport. Preserve version checks, pending markers, audited captures, and uncertain-outcome handling. |
| `ppl/civ-stats.shared.ts`, `ppl/ppl-civ-stats.ts`, `ppl/tournament-image-tools.shared.ts`, `ppl/ranked-preview.ts` | Replace their independent transports; include account/resource identity in cache provenance. A preview with a cache miss may make remote requests, so offline validation must use explicit fixtures/cache-only paths. |
| Standard and PPL `backfill-civ-leaderboard.ts`, bot `backfill-player-civ-stats.ts` | Preserve each command's existing local/remote defaults and write confirmations while changing target resolution and result parsing. The standard and PPL backfill defaults differ. |
| Bot `prepare-rating-read-models.ts` | Update shared config/transport dependencies without rerunning completed preparation. Preserve its journals and usage limits. |
| Bot `generate-tournament-emoji-icons.ts` | Its supported remote-D1 mode hardcodes the old PPL config. Migrate that reader with the other active callers. |
| Bot `seed-dev-leaders.ts`, `kv-local.ts`, `packages/db/drizzle.config.ts` | Use the selected persistence/resource identity or explicit SQLite override. Do not choose an unrelated database just because its schema or filename looks plausible. |

For D1, pass the database ID and explicit migration directory/pattern/table options required by `cf`. Preserve existing migration bookkeeping. For queries, preserve result rows and metadata used by maintenance code; successful process exit alone is insufficient.

For KV, distinguish absent values, empty strings, and failed requests; preserve TTL units and handle pagination. Check the resolved PPL namespace against the identity in its old binding config before replacing binding-based commands. The existing repository guidance warns that blindly using namespace-ID commands has selected the wrong data before.

For secrets, Worker type generation, or resource administration unsupported by the pinned CLI, keep a narrow documented Wrangler/SDK adapter with explicit account/resource selection. Do not create a second maintained copy of deployment configuration. Setup commands that formerly used `--update-config` must report the resource identity for the shared target file instead of attempting to edit generated config.

### Historical tools and documentation

Inventory the remaining old-config references before deleting the four Wrangler JSON/JSONC files. Update supported entrypoints. Label historical-only scripts with their original requirements; for example, `ppl/cancel-historical-rated-match.ts` targets a pre-0023 schema. Avoid making historical repairs appear supported against current data simply by updating a config path.

Completed rollout journals and old deployment notes remain records of what happened. Active setup/maintenance instructions must point to the new commands. `scripts/cloudflare-usage.ts` already uses HTTP APIs and needs no CLI rewrite.

## 7. Verification

Run focused checks as their owning step changes, then the final aggregate after integration.

| Area | Checks |
| --- | --- |
| Dependency/toolchain | Install with the committed lockfile; inspect Vite/Vitest/Solid resolution; confirm the documented Node/Bun versions work. Run an Activity build on Vite 8 before changing Solid. |
| Lint, formatting, types | Run read-only lint/format checks, copy-rule fixtures, `bun run check:copy`, and `bun run check`. Typecheck the new tool configs as well as app/package source. |
| Activity test conversion | Run all existing Activity suites under Vitest before and after Solid 2. Confirm that root `test`, coverage, and UI commands select the intended runner and do not load Cloudflare credentials. |
| Store/preferences | Extend existing store/UI suites to cover loading existing saved preferences, updater/value distinctions, reset behavior, and server snapshots replacing optimistic state. |
| Shell/navigation | Add a rendered shell/router integration test for within-surface navigation, crossing to practice/another surface, cleanup, browser back/resume behavior, and rejection of a stale launch response. Assert navigation and socket ownership rather than component internals. |
| Reconnect/preview | Exercise a selected-session reconnect with a newer server snapshot. Verify that previews are hydrated before sending, stale responses do not overwrite newer state, pending work is cancelled on disposal, and hiding/showing the Activity produces the expected connection lifecycle. |
| DOM interactions | Run grid, player-slot, and timeline suites for measurement, portals, scrolling, and selection. Exercise persisted UI scale and viewport changes in the interactive check. |
| Cloudflare targets | Load both configs under Node and compare their resolved public values with the old configs before deleting them. Check account/resource identities, service binding, Durable Object history, flags, and Discord build IDs. Tests should expose wrong-account selection, not just duplicate a table of constants. |
| Cloudflare artifacts | Build development, standard, and PPL Activity artifacts and both bot target artifacts locally. Check asset/Worker entry paths, WASM/font handling, and wrong-target prebuilt rejection. Do not use a deploy command as a build check. |
| Command adapters | Test command construction and result normalization with fixtures: account choice, local/remote flags, D1 rows/errors, KV missing/empty/error cases, pagination, and TTLs. Exercise secret filtering with fixture files only. |
| Local state | In a temporary persistence directory, run local migrations and storage operations through the same paths used by maintenance tools. Confirm each tool sees that database/namespace and does not select the existing development state. |
| Orchestration | Inspect standard/PPL command previews without credentials or subprocesses. When local development is requested, check cached-preview/live startup, process shutdown on Windows, and a tunnel-free mode. |
| Interactive Activity | With local development explicitly started, exercise embedded and browser launch, practice, lobby setup, draft picks/previews, reconnect, route back/resume, and reporting. DOM tests cannot establish Discord iframe/SDK behavior. |
| Final regression | Run the root workspace test command and the integrated type/copy/lint/format checks. Investigate lost test discovery rather than accepting a smaller passing suite count. |

Automated local runtime checks use placeholder Discord values and mocked authentication, without real OAuth, Discord registration, or remote Cloudflare operations. Add a tunnel-free option to `scripts/dev.ts` for these checks. The interactive Activity check requires a separately requested development-Discord session with working development credentials and tunnel; it exercises real SDK/OAuth behavior.

## 8. Finish the supported developer workflow

1. Update `README.md` with the Node requirement, Bun installation, new target/config paths, build/test commands, local persistence, and the meaning of standard versus PPL deployment commands.
2. Update current PPL operating instructions and relevant `AGENTS.md` tooling references. Retain historical deployment receipts and old completed-operation notes.
3. Update editor formatter/linter settings and remove unused ESLint, Bun Activity loader, or old configuration dependencies only after their callers are gone.
4. Keep formatting changes in a dedicated commit. Use GitButler for version-control writes and leave archived branches alone.
5. Document any retained Wrangler/SDK adapter with the command it supports and the concrete `cf` coverage gap. The remaining adapter should consume shared target data, not revive duplicated Worker configs.

Suggested implementation commit order: Vite+ foundation; lint/copy and TypeScript; Activity test runner; Solid runtime/stores/components; Router and shell behavior; shared Cloudflare target data; Worker configs and callers; mechanical formatting and final documentation. Keep tightly coupled Solid changes together if an intermediate commit cannot build.

The completed migration should provide one coherent workspace toolchain, Activity tests compiled through Vite, and one source of public Cloudflare target data consumed by both Workers and active operational tools.

## References

- [Vite+ migration](https://viteplus.dev/guide/migrate-rules), [lint configuration](https://viteplus.dev/guide/lint), and [formatting](https://viteplus.dev/guide/fmt).
- [Solid 1 to Solid 2](https://v2.solidjs.com/migration/from-solid-1), [Router migration](https://v2.solidjs.com/migration/from-solid-router), and the installed version's `CHEATSHEET.md`.
- [TypeScript 7 release and compiler-API compatibility](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
- [Cloudflare config loader runtime requirements](https://github.com/cloudflare/workers-sdk/blob/main/packages/config/src/load.ts) and [Wrangler new-config command coverage](https://github.com/cloudflare/cf/blob/main/test_bugs/new-config-unsupported-outside-five-commands.md).
