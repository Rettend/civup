# External Browser Access Plan

## Goal

Allow players who cannot launch Discord Activities to use the same CivUp lobby and draft experience in a normal browser.

The Discord Activity remains the default. A player can run `/settings` once to make the existing Join, Browse, and draft-opening interactions return a private browser link instead of trying to launch the Activity.

This is one application with two launch surfaces, not a second CivUp implementation:

```text
Discord Activity -> Embedded App SDK auth -> shared CivUp client
Web browser      -> Discord OAuth         -> shared CivUp client
                                                |
                                                v
                                      Activity Worker proxy
                                                |
                                                v
                                  Bot Worker + D1/KV/Durable Objects
```

The browser never connects directly to D1, KV, R2, or a Durable Object. It continues to use the Activity Worker as the authenticated same-origin proxy to the bot Worker.

## Product Decisions

- Keep the existing public message components. Do not add a third `Open in browser` button next to Join and Browse.
- Represent the per-user launch preference with one configured no-permission Discord role.
- Default role absence to Activity, preserving all existing behavior without a per-user storage lookup.
- Resolve the role synchronously from `interaction.member.roles` when a user clicks a button. Shared messages do not need to be rerendered per user.
- The browser branch responds with a persistent ephemeral message containing one `Open in Browser` link button.
- Preserve the current Join side effect. Clicking Join still attempts to add the player to the lobby before they open the browser.
- Use stable session and channel URLs. Never put an Activity session, Discord token, or other bearer credential in a browser launch URL.
- Use one shared Solid client. Extract platform/auth/navigation seams instead of copying lobby or draft pages.
- Treat authenticated PPL membership as the browser read boundary for the first release. A PPL member with a known session/channel URL may spectate it; Discord channel ACL mirroring is deferred unless PPL has private CivUp sessions that require it.
- Keep browser access disabled in bot setup state until an administrator enables it after production configuration is complete.
- Do not use Gau for this implementation. See [Gau Decision](#gau-decision).

## UX Constraint

A Discord custom button can return either:

- callback type 12 through `c.resActivity()`, which launches the Activity; or
- a normal/ephemeral interaction response containing a link button.

It cannot dynamically redirect the user's Discord client to an arbitrary URL. A URL button is a separate static component type and does not send an interaction to the bot.

Therefore preference-aware browser opening requires two clicks:

1. The player clicks the existing Join, Browse, or draft button.
2. CivUp responds privately with `Open in Browser`.
3. The player clicks that link to open the browser.

This second click is unavoidable if all of the following remain requirements:

- one shared public Join button;
- per-user Activity/browser behavior;
- current bot-side auto-join and tournament checks; and
- no extra public browser button.

The save catalog behaves differently because its external-link call runs after the Activity has already loaded. It currently calls `discordSdk.commands.openExternalLink()` and falls back to `window.open()` in `apps/activity/src/client/pages/uploads/AutosaveCatalogPage.tsx`. That mechanism cannot run when Discord blocks the Activity before CivUp is loaded.

## User Flows

### Configure Browser Opening

Run `/settings`, then press either **Discord Activity** or **Web browser** in the persistent ephemeral panel. The panel shows the current mode and explains that future CivUp launch buttons use it.

### Join an Open Lobby

1. The user clicks the existing Join button.
2. The handler resolves the clicked session and reads the preference role from the interaction payload (no storage request).
3. Existing admission checks and the background auto-join flow remain unchanged.
4. An Activity user receives callback type 12 as today.
5. A browser user receives a persistent ephemeral response linking to `/web/session/:sessionId`.
6. On first browser use, CivUp redirects through Discord OAuth and returns to the same session URL.
7. CivUp renders the shared lobby UI. If auto-join did not succeed, the existing Join Lobby action remains available.

### Browse a Channel

1. The user clicks the existing Browse button.
2. An Activity user gets the existing channel overview.
3. A browser user receives `/web/channel/:channelId`.
4. Selecting a lobby or match navigates to `/web/session/:sessionId`.

### Open a Draft or Active Match

The same Join button handler resolves the current lifecycle state. Browser users receive `/web/session/:sessionId`; the direct session endpoint materializes the current lobby, draft, swap, active, or reported state.

### Explicit Commands

- Preference-aware: message Join, Browse, legacy Open Draft, and the `/match join` branch that currently launches an existing live match.
- Unchanged: a normal successful `/match join` remains a deferred command response and does not open either surface.
- Unchanged in the first release: tournament creation keeps its current Activity response because it does too much creation work before its session ID exists to add another pre-response preference decision safely.
- Explicit override: `/match activity` continues to launch the Activity because the command explicitly asks for it.
- Deferred follow-up: consider `/match web` only if users need an explicit browser override later. It is not required for the first release.

## URL Model

### Stable Session

```text
/web/session/:sessionId
```

`sessionId` is the canonical aggregate identity from open lobby through draft, swap, active, reported, revert, and cancellation. The URL remains unchanged across lifecycle transitions.

Bot launch handlers must canonicalize legacy message mappings and match IDs to `sessionId` before building this URL. The direct context response should carry `sessionId` and `matchId` as separate fields even where current sessions use the same value. Session URLs and SessionDO rooms always use `sessionId`; match/report APIs continue to use `matchId` where required.

Expected behavior:

- `open`: render the existing draft setup/lobby page.
- `draft`, `swap`, or `active`: render the existing draft page and connect to the selected SessionDO.
- `reported`: render the existing reported state.
- `cancelled` or missing: render an ended/unavailable state at the same URL.
- `draft -> open` revert: switch back to the existing lobby page without changing the URL.

### Channel Overview

```text
/web/channel/:channelId
```

This is used only by Browse. It renders the existing overview/target-picker UI for that channel. Selecting a target navigates to its stable session URL instead of writing embedded Activity follow state.

### No Credential URLs

Browser launch URLs may contain only non-secret context such as `sessionId` or `channelId`. Authentication comes from the same-origin browser session cookie.

Do not use:

- the current eight-hour Activity session in a launch URL;
- a Discord OAuth access token in a launch URL;
- the two-minute Activity launch-target record as browser truth; or
- a new one-time launch-ticket system unless a later requirement needs user-bound links.

## Authentication Design

### Browser OAuth Routes

Add these routes to the Activity Worker:

```text
GET  /api/auth/discord?returnTo=/web/session/:sessionId
GET  /api/auth/discord/callback
GET  /api/auth/me
POST /api/auth/logout
```

`GET /api/auth/discord`:

- Accept only a same-origin relative `returnTo` under `/web/`.
- Reject absolute, protocol-relative, malformed, and callback-loop destinations.
- Generate a cryptographically random OAuth state and PKCE verifier.
- Store the state, verifier, validated return path, and expiration in a short-lived signed HttpOnly transaction cookie.
- Redirect to Discord's authorization endpoint.
- Request only `identify` and `guilds.members.read`.
- Use the configured public origin to construct the exact registered callback URI.

Suggested transaction cookie:

```text
__Host-civup-oauth
Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax
```

`GET /api/auth/discord/callback`:

- Handle user cancellation without an exception loop.
- Verify the transaction signature and expiration.
- Compare callback state with the transaction state.
- Exchange the code server-side with the exact callback URI and PKCE verifier.
- Reuse the existing Discord user/guild-member loading and display identity helpers.
- Require membership in the configured PPL guild in production.
- Reuse `createActivitySession()` for the CivUp identity session.
- Store that signed session in an HttpOnly browser cookie.
- Clear the transaction cookie on success and failure.
- Redirect with 303 to the validated return path.
- Discard the Discord access and refresh tokens after identity and membership verification. Do not persist or return them.

On cancellation, invalid state, non-membership, or token-exchange failure, return a small `Cache-Control: no-store` terminal error page with an explicit retry link. Do not redirect automatically to an unauthenticated `/web/...` route, because that would cause the browser adapter to start OAuth again and loop.

Suggested browser session cookie:

```text
__Host-civup-session
Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax
```

`GET /api/auth/me`:

- Verify either the browser cookie or existing explicit Activity credential.
- Return only `{ userId, displayName, avatarUrl }`.
- Return 401 for an absent or expired session.
- Never return a Discord access token or the signed CivUp session token.

`POST /api/auth/logout`:

- Require a same-origin request.
- Clear the browser session cookie.
- Let the client close sockets and return to a signed-out state.

### Embedded Authentication

Keep the current Embedded App SDK flow intact:

- `discordSdk.ready()` supplies channel context.
- Embedded authorize/authenticate continues to use the JavaScript-readable Discord and CivUp sessions it requires.
- Existing header/query authentication remains supported.
- Browser OAuth must not change the registered redirect behavior expected by the Embedded SDK token exchange.

Extract the shared server pieces from `apps/activity/src/server/index.ts` rather than implementing Discord identity normalization twice:

- authorization-code exchange;
- Discord user or guild-member lookup;
- display-name resolution;
- avatar resolution; and
- signed CivUp session creation.

## Session Transport

The Activity Worker remains the only public trusted proxy.

Extend `requireActivitySession()` to resolve identity in this order:

1. `X-CivUp-Activity-Session` header for embedded HTTP calls.
2. `activitySession` query parameter for embedded WebSocket/download compatibility.
3. `__Host-civup-session` cookie for normal browser calls.

After verification, continue forwarding only the existing internal secret and trusted identity headers to the bot. Do not forward the browser cookie or the original activity token.

### HTTP

- Embedded mode keeps adding the current activity header.
- Browser mode sends no JavaScript-readable identity credential; same-origin fetch includes the cookie.
- The API helper accepts an auth transport instead of assuming a token always exists.

### WebSockets

- Embedded mode keeps the generic activity session query parameter.
- Browser mode omits that parameter and relies on the same-origin Cookie header in the WebSocket upgrade.
- The per-session access token issued for a draft remains in memory and may remain in the selected-session socket query.
- Remove client-side early failures that require `getActivitySessionToken()` when the selected transport is `cookie`.
- Validate browser WebSocket `Origin` before accepting cookie authentication.
- Enforce the configured PPL guild again during selected-session and channel-feed socket admission. An HTTP context check alone does not authorize a later socket room chosen by the client.

## Browser Context APIs

### Direct Session Context

Add an authenticated bot endpoint behind the Activity Worker proxy:

```text
GET /api/activity/session/:sessionId
```

Use an explicit context contract instead of treating `matchId` as aggregate identity:

```ts
type BrowserSessionContext =
  | {
      status: 'available'
      sessionId: string
      matchId: string | null
      phase: 'open' | 'draft' | 'swap' | 'active' | 'reported'
      selection: ActivityLaunchSelection
    }
  | {
      status: 'ended'
      sessionId: string
      matchId: string | null
      phase: 'cancelled'
    }
```

Return 404 only when no terminal-aware directory record exists. Session access tokens must bind to canonical `sessionId` and socket admission must verify them against `SessionRecord.id`; `matchId` is only for match/report APIs and display data.

It must:

- derive the user from the trusted proxy identity, with no user ID parameter;
- look up a terminal-aware `session_directory` record by stable session ID rather than using a helper that excludes cancelled sessions;
- prefer the authoritative SessionDO record when available;
- reject sessions from a different configured guild;
- map the current phase to an existing lobby or match selection;
- compute host/member/spectator flags and join eligibility;
- issue the existing per-session access token for draft/swap/active state;
- return the existing `ActivityLaunchSnapshot`/selection shapes where practical; and
- avoid reading or writing embedded one-shot/follow target state.

Launch handlers that begin with a legacy `matchId` or message mapping must reverse-resolve the owning directory record before generating the URL. If canonicalization fails, return a private error rather than constructing a session URL from an unverified match ID.

Existing materialization logic in `apps/bot/src/routes/activity.ts` should be extracted and reused instead of copied.

### Browser Channel Overview

Add an authenticated endpoint such as:

```text
GET /api/activity/channel/:channelId
```

It must:

- derive the user from trusted proxy identity;
- return visible active targets for the channel;
- not consume one-shot Activity launch targets;
- not read or update embedded follow-target state; and
- support the existing overview feed socket for live updates.

The channel overview query and feed must filter records to `ALLOWED_DISCORD_GUILD_ID`. The first release does not reproduce Discord channel permission overwrites; its documented read policy is PPL membership plus possession of the channel/session URL.

When a browser user chooses a target, navigate directly to `/web/session/:sessionId`. Do not call the embedded `/api/activity/target` endpoint.

## Shared Client Refactor

Do not create `apps/web` or copy the Solid pages. Keep `apps/activity` as the single client and Worker deployment.

### Platform Contract

Introduce a small platform-neutral contract, for example:

```ts
type ClientSurface = 'discord-embedded' | 'web'
type AuthTransport = 'token' | 'cookie'

type LaunchContext =
  | { kind: 'channel', channelId: string }
  | { kind: 'session', sessionId: string }

interface ClientBootstrap {
  surface: ClientSurface
  identity: ActivityIdentity
  authTransport: AuthTransport
  launchContext: LaunchContext
}
```

Suggested modules:

```text
apps/activity/src/client/platform/types.ts
apps/activity/src/client/platform/discord-platform.ts
apps/activity/src/client/platform/browser-platform.ts
apps/activity/src/client/platform/external-links.ts
```

### Discord Platform

Move current `discord.ts` SDK setup behind the Discord platform adapter:

- construct and wait for `DiscordSDK` only in embedded mode;
- perform the existing embedded authorize/authenticate exchange;
- return a generic `ActivityIdentity`, token transport, and channel launch context; and
- expose SDK-backed external-link opening.

The browser route must not statically import a module that immediately constructs or waits for the SDK.

### Browser Platform

The browser platform adapter:

- obtains session/channel context from the `/web/...` route;
- calls `/api/auth/me`;
- redirects a 401 to `/api/auth/discord` with the full current relative URL;
- does not redirect again on 403 or a terminal OAuth error;
- returns cookie transport; and
- uses native browser opening/navigation for external links.

### User Store

Change `apps/activity/src/client/stores/user-store.ts` from the SDK `Auth` response to the existing platform-neutral `ActivityIdentity` shape.

Keep the current helper API where possible:

- `userId()`
- `displayName()`
- `avatarUrl()`

This minimizes downstream component changes.

### Shells and Controllers

Keep one shared controller implementation and thin launch wrappers:

```text
DiscordActivityShell -> channel context from SDK
WebChannelShell      -> channel context from URL
WebSessionShell      -> stable session context from URL
```

The existing lobby setup, draft, map vote, reporting, and shared UI components remain unchanged except where they currently import the Discord SDK directly. The WIP catalog/upload surface is not exposed through browser routes in the first release.

The direct session surface should subscribe only to the selected SessionDO. It does not need the channel-wide overview feed while viewing a session.

### Route Policy

Current route canonicalization is embedded and phase-oriented. Extract it from `ActivityShell.tsx` and make it surface-aware.

Embedded routes remain:

```text
/overview
/lobby/:lobbyId
/draft/:matchId
/uploads
```

Browser routes remain stable:

```text
/web/channel/:channelId
/web/session/:sessionId
```

Open-to-draft, revert, report, reconnect, and socket-race transitions must change rendered state without replacing the browser session URL.

### External Links and Downloads

Replace direct SDK imports in `SteamLobbyButton.tsx` and `AutosaveCatalogPage.tsx` with the platform external-link helper.

- Embedded mode: use `discordSdk.commands.openExternalLink()` with current fallbacks.
- Browser mode: use native browser opening.
- Embedded catalog downloads: keep the current query-token compatibility initially.
- Deferred browser catalog: add a stable browser catalog route, cookie-authenticated downloads, server-provided capability checks, and R2 CORS as a separate feature after lobby/draft browser access is stable.
- Follow-up hardening: replace the embedded general session query with a short-lived download-only ticket.

## Per-User Setting

### Command

Add `/settings` with no options. It returns a persistent ephemeral panel with the current launch mode and two idempotent buttons: **Discord Activity** and **Web browser**. Browser mode is unavailable unless an administrator has enabled Browser Access and the canonical public origin is configured.

### Preference Role

Use one bot-managed Discord role with no permissions:

- `/admin setup target:Browser Access value:on` verifies the saved role, adopts an existing safe `CivUp Web Browser` role, or creates it;
- setup state and the role ID are persisted under `system:browser-access` in bot KV;
- role absent means Activity;
- role present means browser;
- `/settings` adds or removes only this role through the existing Discord role helpers;
- the per-user preference reads only `interaction.member.roles` and performs no KV, D1, DO, or Discord API preference lookup;
- bot setup state is cached per Worker isolate for one minute instead of reading KV per click;
- missing interaction roles or incomplete enabled configuration fails privately rather than guessing a launch surface.

### Preference-Aware Response

Add a shared bot helper for launch responses. It receives the resolved target/context and returns either:

- Activity: store the current one-shot Activity target, then `c.resActivity()`; or
- Browser: return an immediate ephemeral message with a Link-style `Open in Browser` button.

The ephemeral browser response must not use the existing ten-second transient auto-delete behavior.

Load the cached setup state, then read the per-user preference synchronously from the interaction while resolving the clicked session. A cold Worker isolate performs one KV setup-state read; subsequent clicks in that isolate reuse it for one minute. The interaction must choose its callback within Discord's initial response deadline, and an Activity response cannot be produced after first deferring a normal message response.

Keep preference/target resolution inside a sub-three-second initial-response budget. Move auto-join, message refresh, and repair work to `waitUntil` as today. Only command branches that already return `resActivity()` become preference-aware; do not retrofit a launch onto deferred command branches.

Preserve the existing Join workflow in both branches:

- stale completed-session repair;
- target resolution;
- open-lobby auto-join;
- transfer from another open lobby;
- tournament admission checks;
- blocking live-match checks; and
- lobby message refresh.

The launch response choice should be the only behavioral branch.

## Configuration

Add a non-secret canonical origin to both Workers:

```text
ACTIVITY_PUBLIC_ORIGIN=https://civup-activity.thepeace.workers.dev
```

Browser enablement is bot-owned setup state rather than a Worker environment variable:

```text
/admin setup target:Browser Access value:on
/admin setup target:Browser Access value:off
```

New deployments default to off because no setup state exists. Enabling verifies or creates the no-permission role and saves its ID; disabling preserves the role and member preferences.

Use it for:

- bot-generated browser links;
- OAuth callback construction;
- return-to and request-origin validation; and
- browser WebSocket origin validation.

The Activity Worker returns 503 from browser OAuth/session entry points unless `ACTIVITY_PUBLIC_ORIGIN`, `ALLOWED_DISCORD_GUILD_ID`, and auth secrets are configured. The bot only offers Browser in `/settings`, launch responses, and browser context routes when Browser Access setup state is on and the public origin is configured.

If a browser OAuth request arrives through a noncanonical Worker/custom hostname, redirect to the same path on `ACTIVITY_PUBLIC_ORIGIN` before setting any host-only transaction cookie. Never construct a canonical callback while storing the transaction cookie on another host.

Add or verify:

```text
ALLOWED_DISCORD_GUILD_ID=<PPL guild ID>
```

For PPL, configure the known guild explicitly in both Worker configs:

```text
ALLOWED_DISCORD_GUILD_ID=1234044388733095946
```

Files to update during implementation:

- `apps/bot/src/env.ts`
- `apps/bot/wrangler.jsonc`
- `apps/bot/wrangler.ppl.jsonc`
- `apps/bot/.dev.vars.example`
- `apps/bot/.prod.secrets.example` if the project keeps the guild ID there
- `apps/activity/wrangler.jsonc`
- `apps/activity/wrangler.ppl.jsonc`
- `apps/activity/.dev.vars.example`
- `apps/activity/.prod.secrets.example` or vars example as appropriate
- `PPL.md`

Register this exact Discord OAuth redirect URI for each deployment origin:

```text
<ACTIVITY_PUBLIC_ORIGIN>/api/auth/discord/callback
```

## Security Requirements

- Validate OAuth state, transaction expiration, PKCE verifier, and exact callback URI.
- Restrict OAuth return paths to local `/web/` routes.
- Require PPL guild membership for production browser sessions.
- Filter direct-session HTTP, selected-session sockets, channel overview HTTP, and channel-feed sockets to the configured PPL guild.
- Document that the MVP does not mirror per-channel Discord ACLs; add a user-bound launch grant before release if private CivUp channels must remain hidden from other PPL members.
- Keep Discord provider tokens server-only and do not persist them.
- Use Secure, HttpOnly, host-only cookies with `SameSite=Lax`.
- Check exact `Origin` for cookie-authenticated unsafe HTTP methods.
- Check exact `Origin` for cookie-authenticated WebSocket upgrades.
- Continue requiring the internal secret between Activity and bot Workers.
- Continue rejecting body/path user IDs that differ from authenticated identity.
- Do not forward browser cookies or bearer credentials to the bot Worker.
- Do not treat session/channel IDs as authorization; every mutation still uses authenticated identity and existing permission checks.
- Add `Cache-Control: no-store` to OAuth, identity, and authenticated context responses.
- Clear OAuth transaction cookies on all terminal callback paths.
- Avoid logging OAuth codes, provider tokens, CivUp sessions, cookies, or signed query credentials.

## Gau Decision

Gau was evaluated from `https://gau.rettend.me/` and the local `../gau` repository.

Useful Gau capabilities include Discord OAuth, state/PKCE, return-to validation, cookies, JWT sessions, and Solid helpers. Its normal integration is not a good fit for this scoped feature because it also expects:

- a durable user/account adapter;
- new user and provider-account tables or a custom adapter;
- Gau-generated user IDs instead of Discord IDs as primary identity;
- provider access/refresh token persistence by default; and
- a second session model or a bridge back to CivUp's existing activity session.

CivUp already has the Discord code exchange, guild-member lookup, profile normalization, signed eight-hour identity, and trusted Worker proxy. Implementing the missing browser OAuth transaction and cookie handling is smaller and avoids retaining provider tokens.

Reconsider Gau only if CivUp later needs multi-provider accounts, account linking, durable account administration, or provider refresh-token access.

## Implementation Checklist

### Phase 1: Contracts and Regression Safety

- [x] Add browser/embedded platform and auth-transport types.
- [x] Change the user store to `ActivityIdentity` without changing rendered behavior.
- [ ] Extract route-policy helpers from `ActivityShell.tsx` and lock existing embedded behavior with tests.
- [x] Extract external-link opening behind a platform helper.
- [x] Confirm embedded Activity authentication, lobby selection, draft sockets, Steam links, and catalog downloads still behave unchanged.

### Phase 2: Browser OAuth

- [x] Extract shared Discord token-exchange and identity-resolution helpers from the Activity Worker entry file.
- [x] Add signed OAuth transaction serialization with a ten-minute TTL.
- [x] Add random state and S256 PKCE generation using Web Crypto.
- [x] Add `GET /api/auth/discord`.
- [x] Add `GET /api/auth/discord/callback`.
- [x] Add `GET /api/auth/me`.
- [x] Add `POST /api/auth/logout`.
- [x] Add browser session cookie parsing and clearing.
- [x] Require configured PPL membership for production browser auth.
- [x] Add a terminal no-store OAuth error page and verify failures cannot cause a redirect loop.
- [x] Canonicalize non-public OAuth entry origins before setting transaction cookies.
- [x] Keep the existing embedded `/api/token` exchange working with its current redirect URI.

### Phase 3: Cookie Authentication and Proxying

- [x] Extend `requireActivitySession()` to accept the browser cookie after explicit header/query credentials.
- [x] Add exact-origin checks for cookie-authenticated unsafe requests.
- [x] Add exact-origin checks for cookie-authenticated WebSocket upgrades.
- [x] Enforce PPL guild filtering during selected-session and activity-feed socket admission.
- [x] Ensure cookies and client credentials are stripped before bot service-binding/fetch proxying.
- [x] Make HTTP helpers support cookie transport without requiring a stored Activity token.
- [x] Make socket helpers support cookie transport without an `activitySession` query value.
- [x] Preserve the per-session draft access-token flow.

### Phase 4: Browser Context Endpoints

- [x] Add direct session lookup/materialization by stable `sessionId`.
- [x] Add legacy `matchId`/message mapping to canonical `sessionId` resolution for browser links.
- [x] Keep `sessionId` and `matchId` separate in direct-context contracts and tests.
- [x] Bind browser session-access tokens to canonical `sessionId` and verify them against `SessionRecord.id` during socket admission.
- [x] Reuse authoritative SessionDO records and existing selection serialization.
- [x] Add browser channel overview lookup without embedded launch/follow state.
- [x] Reject cross-guild and unavailable session context.
- [x] Define terminal behavior for cancelled, missing, and reported sessions.
- [x] Keep existing spectator and mutation authorization semantics.

### Phase 5: Shared Browser Client

- [x] Move Embedded App SDK setup into a lazily loaded Discord platform adapter.
- [x] Add a browser platform adapter using a combined identity/context bootstrap and OAuth redirects.
- [x] Add `/web/channel/:channelId`.
- [x] Add `/web/session/:sessionId`.
- [x] Reuse the existing lobby overview, lobby setup, draft, reporting, and socket stores.
- [x] Keep stable browser URLs across open, draft, revert, active, and reported transitions.
- [x] Use SPA navigation between direct sessions and channel overview while explicitly replacing the selected-session socket with the channel feed.
- [x] Navigate browser overview selections to stable session routes.
- [ ] Handle context/socket lifecycle races by refreshing direct context instead of redirecting.
- [x] Add native browser external-link behavior.
- [ ] Verify mobile and desktop browser layouts.

### Phase 6: Settings and Launch UX

- [x] Add a no-permission Discord role preference with cached setup state and no per-user preference storage reads.
- [x] Add `/settings` with a persistent ephemeral two-button panel and export it from the command barrel.
- [x] Add `ACTIVITY_PUBLIC_ORIGIN` to bot and Activity Worker environments.
- [x] Add admin-controlled Browser Access setup state and automatic safe-role provisioning.
- [x] Add a shared preference-aware launch-response helper.
- [x] Update Join while preserving all existing target and auto-join behavior.
- [x] Update Browse to return the browser channel route.
- [x] Update the legacy Open Draft handler for old Discord messages.
- [x] Update only implicit launch branches listed in the decisions above; leave tournament creation unchanged in the first release.
- [x] Keep `/match activity` as an explicit Activity override.
- [x] Ensure browser link responses are ephemeral and are not auto-deleted.
- [x] Ensure incomplete enabled browser configuration produces a clear private error.

### Phase 7: Hardening

- [x] Preserve current embedded catalog download behavior.
- [x] Keep catalog/upload navigation unavailable on the first browser surface.
- [ ] Track browser catalog routing, cookie downloads, capability checks, R2 CORS, and scoped embedded download tickets as separate follow-up work.
- [ ] Add appropriate CSP/frame/origin headers without breaking Discord embedding.
- [ ] Confirm logout and session-expiration UX.

### Phase 8: Release Prerequisites and Documentation

- [x] Document the browser OAuth callback URI that must be registered before enabling Browser Access.
- [x] Add PPL and development public origins.
- [x] Add/verify the PPL allowed guild ID.
- [x] Update `.dev.vars.example`, production examples, Wrangler configs, and `PPL.md`.
- [x] Update player-facing instructions in `GUIDE.md` or `MANUAL.md`.
- [x] Document `/settings` command registration as a separately authorized release action.
- [ ] Validate with an affected Korean player before making browser mode the recommended setting.

Do not register commands, change Developer Portal configuration, or deploy as part of code implementation unless explicitly requested.

## Test Checklist

### Activity Worker Auth

- [x] Authorization URL contains random state, S256 PKCE, exact callback URI, and only required scopes.
- [x] Transaction cookie has expected flags and expiry.
- [x] Valid same-origin `/web/` return paths survive OAuth.
- [x] External, protocol-relative, malformed, and callback-loop return paths are rejected.
- [x] Missing, mismatched, expired, tampered, and replayed state fails after the transaction cookie is cleared.
- [x] Discord cancellation renders a terminal retry state without looping.
- [x] Every callback failure mode ends on a no-store error page rather than restarting OAuth automatically.
- [x] Callback sends the exact redirect URI and PKCE verifier during exchange.
- [x] Guild member succeeds; non-member and verification failures fail closed.
- [x] Guild nickname/global name and guild/global avatar precedence remains correct.
- [x] Discord tokens never appear in browser responses, browser storage, or D1/KV.
- [x] Browser session expires and logout clears it.
- [x] Embedded `/api/token` behavior remains unchanged.

### Proxy and Transport

- [x] Header-authenticated embedded HTTP requests still work.
- [x] Query-authenticated embedded WebSockets still work.
- [x] Cookie-authenticated browser HTTP requests work.
- [x] Cookie-authenticated browser WebSockets work.
- [x] Cross-origin unsafe browser requests are rejected.
- [x] Cross-origin WebSocket upgrades are rejected.
- [ ] Cross-guild selected-session and channel-feed socket rooms are rejected.
- [x] Bot Worker receives only trusted internal identity headers.

### Browser Context and UI

- [ ] Direct open lobby renders the shared lobby setup UI.
- [ ] Existing Join Lobby action works when bot auto-join did not occur.
- [ ] Closed/full/blocking-match eligibility remains enforced.
- [x] Open-to-draft transition keeps the session URL.
- [x] Draft-to-open revert keeps the session URL.
- [x] Reported and cancelled states keep the session URL.
- [x] Legacy match IDs and message mappings resolve to canonical session URLs when IDs differ.
- [x] Session-access tokens remain valid only for their canonical `sessionId`, including when `matchId` differs.
- [ ] Direct session mode reconnects only the selected session.
- [ ] Browse renders channel targets and target selection opens a session URL.
- [ ] A context-open/socket-draft race refreshes and reconnects correctly.
- [x] Browser mode does not load the embedded Discord platform or call `discordSdk.ready()`.
- [x] Embedded mode still calls and uses the SDK normally.
- [x] Steam links work on both surfaces and existing embedded catalog downloads remain unchanged.

### Bot Settings and Responses

- [x] Missing preference role defaults to Activity.
- [x] Preference resolves from interaction roles; setup state is cached instead of read from KV per click.
- [x] Missing roles or incomplete enabled configuration fails privately.
- [x] `/settings` displays and idempotently updates the current preference ephemerally.
- [x] Activity preference yields interaction callback type 12.
- [x] Browser preference yields an ephemeral Link button with no credential in its URL.
- [x] Join, Browse, stale completed messages, and legacy draft buttons resolve the correct browser URL.
- [x] Browser Join preserves current auto-join and tournament behavior.
- [x] Successful deferred `/match join` behavior remains unchanged and does not unexpectedly launch a surface.
- [x] Browser responses do not use transient auto-deletion.
- [x] `/match activity` remains an Activity override.

## Verification Commands

Use focused checks during development:

```bash
bun run --filter civup-activity check
bun run --filter civup-bot check
bun run --filter civup-activity test
bun run --filter civup-bot test
```

Run the workspace type check before completion:

```bash
bun run check
```

Do not use `bun run lint` for this work. Do not deploy or register commands as part of implementation unless explicitly requested.

## Expected Change Areas

### Activity Client

- `apps/activity/src/client/App.tsx`
- `apps/activity/src/client/discord.ts`
- `apps/activity/src/client/activity/ActivityShell.tsx`
- `apps/activity/src/client/activity/activity-context.tsx`
- `apps/activity/src/client/lib/activity-session.ts`
- `apps/activity/src/client/stores/connection-store.ts`
- `apps/activity/src/client/stores/user-store.ts`
- `apps/activity/src/client/components/draft/SteamLobbyButton.tsx`
- `apps/activity/src/client/pages/uploads/AutosaveCatalogPage.tsx`
- new `apps/activity/src/client/platform/*` modules
- new thin web route/shell modules

### Activity Worker

- `apps/activity/src/server/index.ts`
- new browser-auth/cookie helpers if extraction keeps the entry file focused
- `apps/activity/wrangler.jsonc`
- `apps/activity/wrangler.ppl.jsonc`
- Activity environment examples

### Bot Worker

- `apps/bot/src/commands/settings.ts`
- `apps/bot/src/commands/index.ts`
- `apps/bot/src/commands/match/components.ts`
- the existing-live-match launch branch in `apps/bot/src/commands/match/command.ts`
- `apps/bot/src/routes/activity.ts`
- `apps/bot/src/services/activity/*`
- `apps/bot/src/session-runtime/session-do.ts`
- `apps/bot/src/session-runtime/activity-feed.ts`
- new `apps/bot/src/services/settings/user.ts`
- `apps/bot/src/env.ts`
- bot Wrangler configs and environment examples

### Shared Utilities and Tests

- `packages/utils/src/activity-auth.ts` only if generic signed OAuth transaction helpers belong there
- Activity Worker auth/proxy tests
- Activity route/platform/UI tests
- bot settings/command/component tests
- selected-session and activity-feed socket-admission tests

## Completion Criteria

The feature is complete when:

- an affected player can select Web browser with `/settings`;
- clicking the existing Join button privately returns a credential-free browser link;
- existing auto-join still occurs;
- first browser use completes Discord OAuth and verifies PPL membership;
- the shared lobby/draft client works through the full session lifecycle;
- HTTP and WebSocket traffic use the existing authenticated Worker proxy;
- unaffected users retain the current Discord Activity flow by default; and
- no second frontend, direct database access, or provider-token persistence has been introduced.
