# Team Tournament Plan

## Goal

Extend tournaments from 1v1 to team modes without turning a friendly community event into a permission system.

Players should use the lobby, Activity, draft, reporting, standings, and playoff flows they already know. Tournament features should add entry identity, registration, pairing, and history while staying permissive and easy to repair.

The first target is 2v2. The data model may support 1v1 through 6v6, but the 2v2 experience must be complete before treating larger modes as shipped.

## Product Stance

These decisions are fixed for this plan:

- The server is a trusted community. Default to allowing normal behavior, not anticipating every possible social abuse.
- Protect against accidental corruption, concurrency bugs, spam, impersonation, and destructive actions. Do not add bureaucracy for ordinary play.
- Prefer a visible warning, confirmation, audit event, or safe undo over blocking an action.
- Make consequential behavior explicit. Starting a tournament must not silently close registration, moving a player must not silently transfer a record, and editing a roster must show every affected entry.
- Most tournament policies that reasonably vary between events are organizer options, not hardcoded restrictions.
- Options belong in Discord modals, ephemeral management embeds, buttons, select menus, user selects, and role selects. Do not turn tournament commands into long lists of arguments.
- Commands are entry points into an interactive surface. They should not be the surface itself.
- There are no team captains or special entry-member permissions.
- Every member of an entry may create or reopen its tournament lobby.
- Custom team names are off by default. By default, the current players' display names form the team name, such as `Alice / Bob`.
- Do not add invitation, approval, check-in, or teammate-consent workflows unless a concrete event later needs them.
- Tournament entries own standings and bracket progress. Actual match participants are the historical truth for each game.

## Hard Blocks

Hard blocks should be limited to conditions where continuing would be ambiguous, destructive, or technically inconsistent:

- A Discord user cannot occupy two slots in one match.
- A 2v2 draft cannot start without four distinct participants.
- The two sides of a tournament match must reference two distinct tournament entries.
- A player cannot be silently present in multiple current entry rosters. Moving them is allowed, but the move and its effects must be confirmed explicitly.
- Concurrent requests cannot create duplicate live lobbies for one entry or duplicate lobbies for one playoff pairing.
- A stale client cannot overwrite a newer roster or tournament edit; show the new state and ask the user to retry.
- A reported match, historical lineup, or completed bracket cannot be silently rewritten.
- A normal correction cannot invalidate a downstream playoff match that is already drafting or active.
- Player-facing actions cannot perform server-admin operations.
- Display names are never authentication. Linked Discord user IDs are canonical.

Everything else should first be considered for allow, warning, organizer option, or repair.

## Discord UX

### Admin Setup

`/admin tournament create` opens a short modal for fields that are naturally typed:

- Tournament name
- Mode
- Minimum games
- Top cut

After submission, the bot opens a persistent ephemeral **Tournament Setup** panel. The panel shows a readable summary and uses buttons/select menus for policy choices.

The main panel sections are:

- **Registration**
- **Entries**
- **Lobby Rules**
- **Results**
- **Qualifiers**
- **Playoffs**
- **Recent Changes**

Advanced options stay behind an **Advanced** button. The default panel should not present every possible edge case at once.

`/admin tournament edit` and `/admin tournament status` reopen the same management panel. Do not duplicate configuration behavior across commands.

### Player Registration

`/tournament register` takes no teammate arguments. It opens a private registration panel:

- The current user is included automatically.
- A Discord user-select component fills the remaining roster slots.
- The panel previews the resulting entry name.
- If custom team names are enabled, a **Set Team Name** button opens a small modal.
- **Register** or **Update Roster** applies the displayed state after a concise confirmation.

If registration is admin-managed, the panel explains that organizers manage entries and does not pretend that registration is unavailable for an unrelated lifecycle reason.

### Admin Entry Management

The **Entries** panel lists current entries and provides:

- **Add Entry**
- **Edit Roster**
- **Move Player**
- **Mark Withdrawn**
- **Restore Entry**
- **Import**

Adding or editing an entry uses a Discord user-select sized for the tournament mode. Custom team-name controls appear only when that tournament option is enabled.

Bulk import remains an attachment workflow, but it starts from the management panel and always previews the result before applying it. Team import uses one row per entry and linked Discord user IDs. It must not destructively replace unrelated entries without an explicit replace confirmation.

### Buttons Instead Of Command Proliferation

Operational actions should be buttons on the tournament panel or relevant public embed:

- Open or close registration
- Start qualifiers
- Lock qualifiers
- Preview cut
- Create cut
- Cancel tournament
- Reopen tournament
- Release stale lobby
- Record forfeit
- Refresh public message
- View recent changes
- Undo a safe recent action

Do not add a separate slash command and several arguments for every recovery action.

## Organizer Options

The setup panel should expose these options. Defaults intentionally favor an informal trusted server.

| Option | Choices | Default |
|---|---|---|
| Registration management | Players and admins / Admins only | Players and admins |
| Registration state | Open / Closed | Open |
| Eligibility role | None / Selected role | None |
| Custom team names | Off / On | Off |
| Player roster editing | Allowed / Admins only / Locked | Allowed |
| Lineup enforcement | Flexible / Registered roster only | Flexible |
| Lobby settings | Host editable / Tournament locked | Host editable |
| Rematches in qualifiers | Allow / Warn / Block | Warn |
| Result confirmation | Immediate / Opponent confirmation | Immediate |
| Withdrawn-entry results | Keep / Organizer review | Keep |
| Cut behavior | Use byes / Reduce to full bracket | Use byes |

Registration management and registration state are separate:

- An admin-managed tournament can have registration open while only admins add entries.
- A player-managed tournament can explicitly close registration before qualifiers start.
- Starting qualifiers does not silently close registration. The start panel shows the current registration state and asks the organizer what to do if it is still open.
- Late entries are allowed while registration remains open. They begin with zero games.
- Qualifier lock closes registration as an explicit, visible part of locking because no new qualifier entrants can be seeded after the standings freeze.

Visibility is not the same as registration management. Initially, visibility follows Discord channel permissions. An admin-managed tournament can still have public standings and lobbies.

Do not build invite-only registration until an actual tournament requests it. Admin-managed registration already covers curated events without adding invitation state.

## Tournament Identity

### Entry

A tournament entry is the stable competitive identity that owns:

- Qualifier record
- Rematch history
- Cut seed
- Playoff pairing and series score
- Champion status

An entry contains:

- Stable entry ID
- Tournament ID
- Current roster
- Optional custom name when enabled
- Seed when applicable
- Current status
- Revision for conflict detection

There is no captain field.

### Display Name

When custom team names are off, format the current roster in stored position order:

```text
Alice / Bob
```

When custom names are on, show the custom name first and keep member names visible in details and result cards.

Changing a roster changes the current derived display name. Historical match cards continue to show the players who actually played that match.

### Roster Versus Match Lineup

The current roster is the default lineup and the entry's present membership. It is not historical match truth.

At draft start, snapshot the actual lobby sides into match participants:

```text
team 0 participants -> tournament match entry one
team 1 participants -> tournament match entry two
```

Reports, corrections, result images, and historical inspection use that match snapshot. A later roster edit must not make an old result invalid or change who appeared in it.

## Registration And Roster Changes

### Open Registration

- Any server member who passes the optional eligibility role may build an entry.
- Selecting teammates registers them immediately by default; this community does not require an approval workflow.
- Every affected user is visible in the confirmation, and the resulting entry appears in the tournament entry list.
- Repeating the same registration is an idempotent success.
- Registering the same players in a different order updates the displayed order instead of silently preserving an old order.
- Bots and unresolved Discord users are rejected because they cannot participate.

### Admin-Managed Registration

- Player registration opens an explanatory panel rather than returning a generic closed error.
- Admins add teams through **Entries -> Add Entry** with a user select.
- Admins can add entries before or during qualifiers while registration is open.
- Applying an admin import or roster edit shows all movements and incomplete entries before confirmation.

### Editing A Roster

When player roster editing is allowed, any current member may open the registration panel and edit the entry. There are no captain-only actions.

Before applying a roster edit, show:

- Old roster
- New roster
- Players moving from another entry
- Entries that will become incomplete
- Whether this entry already owns reported games or a playoff position
- The explicit statement that the entry's existing record remains with the entry

The user confirms the complete desired state. Do not make them perform a sequence of leave, invite, accept, and transfer actions.

If a player should start with a fresh record instead, the panel offers **Create New Entry** and explains that the old entry keeps its history.

Roster edits are allowed after qualifiers start when the configured policy permits them. Existing match history remains untouched. Administrators may repair rosters regardless of the player setting until qualifier lock; playoff roster repair remains possible but requires an explicit impact confirmation.

### Leaving And Withdrawal

- **Leave Entry** removes only the current user from the current roster.
- The entry may remain incomplete; incomplete state is allowed and visible.
- Leaving does not erase teammates or historical results.
- An empty entry becomes inactive.
- Any current member can open and edit a nonempty entry when player editing is enabled.
- Entry-wide withdrawal is an organizer action from the Entries panel because it changes standings eligibility for everyone.
- Completed games remain by default when an entry withdraws.
- A withdrawn entry remains available in history and can be restored explicitly when safe.

### Concurrent Edits

Roster changes use an expected entry revision. If two family members edit at once, the later stale submission shows the newly saved roster and asks whether they still want to apply their change. Never silently overwrite or merge two different rosters.

## Lobby Flow

### Creating

- Every member of an active entry may run `/tournament create`.
- If that entry already has an open tournament lobby, return and open the existing lobby instead of creating another or showing a permission error.
- Creating a qualifier lobby associates the creator's entry with one side.
- A playoff lobby already knows both entries from the pairing.
- The lobby uses the normal SessionDO lifecycle.

### Joining And Claiming

- The first player associated with another qualifier entry may claim the open opponent side.
- The claim is atomic so two entries cannot win it concurrently.
- If lobby transfer or SessionDO admission fails, release the claim automatically.
- Once both entries are known, normal lobby placement rules apply according to the tournament's lineup-enforcement option.
- A failed or abandoned claim must not reserve a lobby forever. Stale claims expire automatically and organizers can release them from the panel.

### Flexible Lineups

Flexible is the default:

- Registered players are prefilled or suggested.
- Empty positions can be filled by substitutes.
- Same-side seat movement is allowed.
- A player may move across sides before draft start, but the Activity clearly labels which entry each side represents.
- Moving sides does not silently edit either official roster.
- If a substitute belongs to another current entry, show a stronger warning and the affected entry name.
- The actual side at draft start determines which entry receives that player's result for the match.

Registered-roster-only is an organizer option for stricter events. It requires the current roster on each side but still does not lock players to arbitrary within-side positions.

### Host And Lobby Controls

- Tournament host is an operational role for one lobby, not entry authority.
- Host transfer is allowed using the normal lobby behavior.
- All entry members may create lobbies; whoever creates or resumes the lobby may host it.
- Tournament mode and player count are inherent and cannot change inside the lobby.
- Other lobby settings follow the tournament option: host editable or tournament locked.
- If tournament settings are locked, configure them in the tournament panel and show them read-only in Activity.
- Closing a lobby, timers, leader data version, and other ordinary settings should not be secretly half-locked. Their availability follows the displayed tournament policy.

### Starting

Draft start validates only what is needed for the configured policy:

- Four distinct players for 2v2
- Two distinct entry sides
- Exact current rosters only when registered-roster-only is enabled
- No stale session revision
- Tournament and pairing still accept this match

The Activity previews off-roster players and side-to-entry credit before the final **Start Draft** action.

### Cancellation And Recovery

- Before draft start, normal host cancellation is allowed.
- Cancellation releases qualifier and playoff claims through the same tournament-aware path, including moderator cancellation.
- Revert and timeout reopen the same tournament match rather than creating a second record.
- A completed draft cannot be copied into a new tournament game through normal repeat-draft behavior. Technical resume of the same draft remains supported.
- Organizers can release a stuck lobby from the tournament panel.

## Substitutions

- Before draft start, use the normal lobby and flexible-lineup behavior.
- After draft completion, the existing moderator substitution tool works for tournament matches instead of rejecting them categorically.
- Substitution updates the actual match lineup while preserving the entry assigned to that side.
- It does not silently edit the entry's current roster.
- The correction is announced and recorded in recent changes.
- Tournament matches remain unrated and excluded from normal civ-stat contributions after substitution.

## Results And Disputes

### Immediate Results

Immediate is the trusted-community default:

- Any participant may report.
- The first valid report completes the match.
- The result message identifies the reporter.
- A **Dispute** button remains available and alerts organizers without automatically deleting the result.
- A contradictory report should be recorded as a dispute, not treated as a meaningless duplicate.

### Optional Confirmation

When opponent confirmation is enabled:

- The first report becomes pending.
- Any member of the opposing entry may confirm or dispute it.
- No captain is required.
- A pending playoff result does not advance the bracket.
- Organizers can resolve a stale pending result from the management panel.

### Destructive Result Actions

- Players cannot scrub or erase a reported tournament result.
- Organizers may correct, cancel, or void it with a confirmation showing standings and bracket impact.
- If downstream playoff work has not started, repair it automatically.
- If a downstream draft is active, stop and require an explicit reopen decision because both outcomes cannot remain true.
- Corrections preserve old result artifacts as superseded history and publish a clearly marked corrected result.

### Forfeits

Forfeit is an organizer button, not a fake match report:

- Qualifier forfeits are optional and should only count when the event intentionally treats an arranged match as owed.
- Playoff forfeits advance the pairing directly.
- A forfeit does not invent two or three played wins for a best-of series.
- The public result says `Advanced by forfeit`.

## Standings

- Standings belong to entries.
- Qualifier games count only after a valid reported or confirmed result, depending on configuration.
- Tournament matches remain unrated.
- Withdrawn entries are not eligible for future pairing or cut selection but remain visible in historical details.
- Completed games against a withdrawn entry remain by default.
- Publish the actual ordering rules in the standings surface.
- Do not use opaque entry-ID order as an unexplained cut-boundary tiebreak.
- If a boundary tie remains, the cut preview asks the organizer to choose a recorded draw, tiebreak game, or explicit ordering. Do not decide silently.
- Show when only part of a large standings table is rendered and provide a complete view.

The initial scoring model remains open win rate:

1. Minimum-games eligibility
2. Win rate
3. Wins
4. Opponent win rate
5. Seed or explicit cut-boundary decision

The status panel warns when a `block` rematch policy makes the minimum-games target impossible for the number of entries.

## Rematches

- Rematch policy applies to qualifiers only.
- `allow` permits silently.
- `warn` permits and shows a persistent warning.
- `block` prevents the qualifier pairing.
- Playoff series, tiebreakers, and later bracket meetings are never blocked by qualifier rematch policy.
- Corrected or cancelled qualifier results update rematch history consistently.

## Qualifier Lock

Qualifier lock is explicit and uses the tournament management panel:

1. Organizer presses **Lock Qualifiers**.
2. The panel closes registration and blocks new qualifier lobbies.
3. It lists open, drafting, active, pending, disputed, or otherwise unresolved qualifier matches.
4. Existing active matches may finish or be resolved.
5. When blockers reach zero, the system freezes the standings used for the cut.
6. The organizer sees a cut preview before pairings are created.

Do not create a cut from changing live standings. Reopening qualifiers is an explicit organizer action and invalidates the frozen preview before playoff drafts start.

## Cut And Playoffs

### Cut Preview

The preview shows:

- Eligible entries
- Frozen order and tiebreaks
- Actual cut size
- Byes or excluded entries according to configuration
- Initial pairings
- Series format
- Any unresolved roster or result warnings

The organizer confirms with **Create Playoffs**.

### Byes

Byes are the default rather than silently reducing six eligible entries in a configured top eight to four:

- A bye advances the entry without creating a fake game or win.
- Bracket rendering labels the bye.
- The alternative `Reduce to full bracket` remains an explicit tournament option.

### Series

- Series games reference the specific pairing, not only the two entry IDs and round name.
- Qualifier rematch policy does not apply.
- Required wins are stored with the pairing and shown publicly.
- Side or first-pick behavior must be shown in the playoff panel if it differs from the normal draft behavior.
- One active lobby is allowed per pairing.
- A non-clinching report returns the pairing to ready for its next game while preserving series score.
- A clinching confirmed result advances the winner.
- Corrections remove stale downstream scheduled pairings atomically.

### Withdrawal During Playoffs

- Roster changes follow the configured roster policy and explicit impact confirmation.
- Entry withdrawal uses the organizer's **Forfeit** or **Withdraw Entry** action.
- Historical games remain.
- Double withdrawal does not invent a winner; the organizer chooses a bye, replacement, or tournament cancellation from the panel.

## Tournament Lifecycle

Tournament state and registration state are visible separately.

```text
Tournament: setup -> qualifiers -> qualifier_locked -> playoffs -> completed
Registration: open <-> closed
```

Exceptional tournament states:

```text
cancelled
```

Actions are explicit:

- Creating does not start qualifiers.
- Starting does not silently close registration.
- Closing registration does not start qualifiers.
- Locking qualifiers closes registration and explains that consequence before confirmation.
- Creating playoffs requires a frozen preview.
- Reporting the confirmed final completes the tournament.
- Correcting an old final does not silently make an old tournament the current one.
- Reopening or cancelling a tournament is an organizer panel action with an impact preview.

## Safety Without Bureaucracy

### Transparency

Publish concise notices for actions that affect other players:

- Roster changed
- Player moved between entries
- Entry withdrawn or restored
- Result disputed or corrected
- Playoff pairing changed
- Forfeit recorded
- Tournament reopened or cancelled

Avoid noisy DMs and mandatory acknowledgements by default. Use the tournament channel and management panel as the shared source of truth.

### Audit And Undo

Store a lightweight tournament event history containing actor, action, affected IDs, reason when supplied, before/after summary, and timestamp.

The **Recent Changes** panel offers **Undo** only when reversal is still safe. For example, a roster edit can be undone before a newer roster edit or active match makes that state stale. Unsafe undo explains the conflict and opens the relevant repair panel instead of partially reverting.

### Spam And Abuse

Use narrow safeguards rather than broad permissions:

- Rate-limit repeated registration and lobby creation attempts.
- Return existing lobbies idempotently.
- Require confirmation for roster moves, withdrawal, cut creation, cancellation, and result correction.
- Recheck Discord admin permission when a modal or button is submitted.
- Never trust mutable display names to claim imported entries.
- Keep cross-guild data isolated.

## Guild And Tournament Scope

- Every tournament belongs to a Discord guild.
- Commands resolve the current tournament for the interaction guild.
- Historical admin operations include an explicit tournament selection inside the management panel.
- One current tournament per guild is the initial default; history remains addressable without becoming current again.
- Tournament channels and public messages are guild-scoped.
- General match moderators may use ordinary match correction tools, but tournament-impacting changes show their bracket impact and enter tournament history.

## Projection And Recovery

D1 and SessionDO remain canonical. Discord messages and images are repairable projections.

- Leaderboard and bracket renders carry a tournament revision so an older render cannot overwrite a newer one.
- Failed refreshes retry or remain visibly dirty in the management panel.
- Missing/deleted messages can be recreated from current state.
- Stale qualifier and playoff claims expire and can be released manually.
- Admin status surfaces incomplete entries, unresolved identities, live matches blocking lock, stale claims, disputes, and missing channel configuration.
- Public output includes a small textual fallback when image delivery fails.

## Migration And Compatibility

- Keep migration `0021_tournament_entries.sql` as the additive entry-model foundation.
- Convert legacy tournament scripts and production repair tools to entry IDs before using team tournaments in production.
- Do not let old `tournament_players` data remain a competing source of truth for team decisions.
- Remove display-name auto-claim as authentication; unresolved legacy names require explicit admin linking from the Entries panel.
- Verify legacy match and playoff rows received entry IDs before rollout.
- Preserve migrate-before-deploy compatibility until the old Worker can no longer write legacy-only tournament rows.

## Current Branch Rework

The existing `team-tournament-2v2` branch provides useful foundations but is not the final product behavior.

Keep:

- Entry and member tables
- Entry-based standings, rematches, winners, and playoff pairings
- Team result rendering
- Atomic playoff claim pattern
- Tournament exclusion from ratings and civ statistics
- SessionDO lifecycle integration
- Additive legacy migration

Rework:

- Replace unconditional `configLocked` and `rosterLocked` behavior with tournament options.
- Remove permanent exact-position locking; strict mode locks sides and roster membership, not arbitrary within-side order.
- Add player and admin registration panels using Discord components.
- Add admin-managed registration.
- Separate registration state from tournament stage.
- Allow roster edits and explicit player movement according to configuration.
- Snapshot match lineups rather than validating old results against the current roster.
- Allow tournament-aware moderator substitutions.
- Release qualifier claims when admission fails.
- Return an entry's existing lobby for duplicate/concurrent creation attempts.
- Allow host transfer and normal permitted lobby actions.
- Scope rematch blocking to qualifiers.
- Add real qualifier locking before cut creation.
- Prevent player scrub of reported tournament results.
- Prevent completed-draft copying into new tournament games.
- Repair playoff corrections atomically.
- Add revisioned audit and projection state.

## Implementation Order

### 1. Configuration And Interaction Surfaces

- Add guild scope, registration state, and the initial organizer options.
- Build the reusable admin management embed and component handlers.
- Change registration and entry editing to user-select panels.
- Add admin entry creation and team CSV preview.

### 2. Entry Mutability And History

- Add entry revisions and optional names.
- Implement declarative roster replacement with a full impact preview.
- Support explicit player moves, incomplete entries, withdrawal, and restore.
- Add tournament event history and safe undo metadata.

### 3. Lobby And Lineup Behavior

- Make lobby creation idempotent per entry.
- Make qualifier claims compensating/expiring.
- Implement flexible versus registered-only lineups.
- Snapshot actual participants to entry sides at draft start.
- Restore host transfer and policy-controlled lobby settings.

### 4. Reporting And Repair

- Add disputes and optional opponent confirmation.
- Disable player result scrub.
- Enable tournament-aware moderator substitutions.
- Add forfeit and corrected-result projection behavior.

### 5. Qualifier Lock And Playoffs

- Implement explicit lock and frozen standings manifest.
- Scope rematches to qualifiers.
- Add cut preview, byes, pairing-bound series games, and atomic downstream repair.
- Make completion, reopen, and cancellation explicit.

### 6. Production Readiness

- Convert legacy scripts.
- Add consistency diagnostics and recovery actions.
- Revision and retry public projections.
- Test concurrency and component authorization.
- Run focused capacity checks for standings, rendering, and component interactions.

## Acceptance Scenarios

The feature is ready for user testing when all of these work without hidden API calls:

1. An open 2v2 tournament lets a player build a roster through a user-select panel.
2. An admin-managed 2v2 tournament clearly disables player registration and lets admins add all entries through the Entries panel or CSV import.
3. Custom team names are absent by default and derived player names appear everywhere.
4. Turning custom names on exposes name controls without changing existing entry IDs or history.
5. Any member of either entry can create or reopen the correct lobby.
6. Two simultaneous create requests return one lobby.
7. An admin or allowed member changes a roster and sees every affected entry before confirming.
8. A roster change after reported games preserves old lineups and the entry's existing record.
9. Flexible mode allows a substitute with a visible warning and credits the side's entry correctly.
10. Registered-only mode rejects the same substitute but permits same-side reordering.
11. A failed opponent join does not leave the qualifier lobby claimed.
12. A tournament with admin-only registration can remain publicly visible.
13. Registration can remain open during qualifiers and closes only through an explicit action or confirmed qualifier lock.
14. Rematch block affects qualifier opponents but never blocks a playoff series.
15. Qualifier lock refuses to freeze while unresolved matches exist and lists them in the panel.
16. A six-entry top-eight cut displays two byes when bye mode is selected.
17. An immediate result can be disputed without being silently erased.
18. Opponent-confirmation mode does not advance a playoff until any opposing member confirms.
19. Moderator substitution updates a tournament match without adding rating or civ-stat effects.
20. Correcting a semifinal before the final starts removes or repairs stale downstream pairings.
21. Cancelling or reopening a tournament requires an explicit impact confirmation and remains in audit history.
22. Missing public Discord messages can be recreated from canonical state.

## Non-Goals

- No team captains.
- No mandatory teammate approval.
- No invitation system until requested by a real tournament.
- No default custom team names.
- No long argument-heavy tournament commands.
- No separate tournament match runtime.
- No speculative no-show scheduling system for open qualifiers.
- No attempt to encode every community rule as a hard permission check.
- No silent lifecycle transitions or hidden side effects.
