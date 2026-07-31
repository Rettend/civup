# Manual

## What the bot does

- live lobby embeds
- the draft inside a Discord Activity
- result reporting
- elo rating calculation
- ranked Discord roles
- leaderboard embeds

### Terms

- **Lobby**: an open queue before the draft is started, this allows joining, leaving and changing configs
- **Draft**: the phase where bans and picks happen in the Activity
- **Match**: the game after the draft is completed, this one's result can be reported
- **Reported match**: a finished match with placements and rating changes

### Match flow overview

1. **someone runs `/match create`**, this creates the lobby embed and joins them as host
2. **players join**
   - directly, by clicking on the embed's Join button, or
   - using `/match join`, which does a little matchmaking and finds the best lobby
   - of if they are inside the Activity, they can join through the Lobby Overview page

3. Optional: the **host can change configs** in the Activity, including the **Steam lobby link**
4. the host **starts the draft**
5. the players **complete the bans and picks**
6. they leave the activity and **play the game**
7. a player comes back and **reports the result** or the host scrubs the match

See more: [Match Flow](#match-flow)

## First-time setup

When one application supports several Discord servers, repeat setup in each server. Channels, defaults, permissions, browser access, ranked roles, leaderboards, ratings, and stats are stored separately per server.

### 1. Set the system channels

Run these in the channels you want the bot to use:

- `/admin setup target:Draft` - required; this is where lobby embeds are posted
- `/admin setup target:Archive` - optional; the bot posts match results here
- `/admin setup target:Bot Commands` - optional; channel for general bot commands like /stats
- `/admin setup target:Leaderboard` - optional; the bot sends an updating leaderboard embed

> [!IMPORTANT]
>
> - lobby messages appear in the configured Draft channel even if the slash command was run elsewhere
> - running `/admin setup` again in the same channel for the same target removes that target

### 2. Configure ranked roles

Use `/admin ranked set` to map Discord roles to tiers:

- `tier1` is the highest role
- the last configured tier is the base role for qualified ranked players
- bot supports 3 to 10 tiers

Commands:

- `/admin ranked roles` - show current mappings
- `/admin ranked set role1:@Role ...` - set mappings
- `/admin ranked unset slot:...` - clear one mapping

### 3. Mod command access

> [!TIP]
> Use `/help` to see all the commands that you can use

There are 3 levels of access:

- **General**: commands that everyone can use
- **Mod**: can also use `/mod` commands, requires to have a configured Mod role
- **Admin**: can also use `/admin` commands, requires Admin permissions in the discord server

> [!NOTE]
>
> #### Configure Mod role
>
> - `/admin permission add role:@Mod`
>
> `@Mod` role can now use `/mod` commands.

### 4. Set server defaults (Optional)

Use `/admin config` to inspect and change this server's default configs.

| Key          | Note                                                 | Default |
| ------------ | ---------------------------------------------------- | ------- |
| `ban_timer`  | time in seconds for the ban phase                    | `180`   |
| `pick_timer` | time in seconds for a single player to pick a leader | `180`   |

> [!NOTE]
>
> - default leader pool size is rank-based for each game mode and not available as a global config currently
> - hosts can override timers and leader pool size for their lobby before the draft starts
> - leaving a timer blank means "use the server default"
> - setting a timer to `0` means unlimited

### 5. Start a season when ranked games should count

The bot can be used without an active season, but games will not be saved to a season in that case. In a multi-server installation, seasons and tournaments are available only in the configured primary server; partner-server stats remain all-time.

This matters because season start will:

- optionally soft-reset current ratings and clear current ranked roles
- rotate leaderboard embeds

Commands:

- `/admin season start [season_number] [soft_reset]` to start a season, the name is automatically created in this format: `Season {i}` and `S{i}` where `i=1..n`
- `/admin season end` when the season is over

## Match Flow

### Lobby

> [!TIP]
>
> The only command players have to use is `/match create` (host only), then others just click on the lobby embed's Join button, or simply join the activity and then browse the Lobby Overview page.

The `/match` command group manages the lobby:

- `/match activity` opens the Activity showing the Lobby Overview or your previous match
- `/match create mode:... [steam_link]` creates an open lobby and auto-joins as host
- `/match join mode:...` joins the best open lobby for that mode
- `/match status` lists active lobbies and IDs
- `/match leave` leaves the active lobby
- `/match bump` reposts the current lobby embed again
- `/match cancel` host cancels their lobby

> [!NOTE]
>
> - team modes must be full to start
> - regular `FFA` uses 8 seats by default and can expand to 12 seats; 8-seat FFA can start with 6 or 8 players, and 12-seat FFA can start with 6, 8, 10, or 12 players
> - expanded `2v2` lobbies can start with 6 players as `2v2v2`, or 8 players as `2v2v2v2`
> - Red Death FFA can start with 4, 6, 8, or 10 players

### Activity

Pages:

- **Lobby Overview**: shows lobbies from every supported server and can be accessed anytime with the top right corner button. It defaults to the server where the Activity was opened; use the server filters or **All** to change the list.
- **Draft Setup**: the page that opens when a lobby is opened and before it's started, it shows the player seats and the lobby config
- **Draft**: where pick & ban happens
- **Post-draft**: shows the final draft, any player can report the match result here

#### Draft Setup

The host can:

- change game mode anytime before the draft has started
- place and remove players from slots
- shuffle players across the full slot order
- shuffle teams while keeping current players and re-splitting them evenly
- auto-balance teams, this uses players' ratings
- set Min and Max Rank. Joining players are checked against the owning server's calculated standings, and every slotted player is checked again when the draft starts.
- set the leader pool size
- set ban and pick timers
- set or update the Steam lobby link
- toggle BBG live and beta, this will change the leader details inside the draft
- start, cancel, or later scrub the match

Players can:

- move themselves into open seats
- leave their own slot
- see the current config and draft state

In team modes, the first player in an empty team column locks that column to the server they joined from. Only players from that server can use it until the column is empty again. FFA has no team-column lock.

#### Spectators

Users who join the Activity but don't take a lobby seat are Spectators, they can see the draft happening but can't interact with it.

It's possible to spectate another lobby while being a player in a different lobby.

### Steam lobby links

Optional feature.

In the Activity:

- host sees a dark Steam button top left where they can set/update/clear the link anytime

Using commands:

- for a new lobby: `/match create` `steam_link` parameter
- existing lobby: `/match steam set` and `/match steam clear`

When the Steam lobby link is set, other players see a gold Steam button top left, clicking that will open Civ and join the Civ lobby.

## Draft Rules

### Draft format

| Mode  | Bans                | Pick order                |
| ----- | ------------------- | ------------------------- |
| `1v1` | 3 each              | 12                        |
| `2v2` | captains ban 3 each | 1221                      |
| `3v3` | captains ban 3 each | 122112                    |
| `4v4` | captains ban 3 each | 12212112                  |
| `5v5` | captains ban 3 each | 1221211212                |
| `6v6` | captains ban 3 each | 122121122112              |
| `FFA` | 2 each              | seat order / simultaneous |

> [!NOTE]
>
> Captains are the first seat in each team, only they can submit bans, and during the pick phase, they can also lock the current pick for teammates.
> Expanded `2v2` snakes by active teams: `123321` for `2v2v2`, `12344321` for `2v2v2v2`.

### Draft behavior

- `Blind Bans` is ON by default: all teams ban at the same time and bans are only revealed when the ban phase is completed
- with `Blind Bans` OFF, `1v1` uses `121212`, and team modes use `122112` for the ban phase
- unsupported formats still force blind bans: `FFA`, `Red Death`, and expanded `2v2` formats with extra teams
- if the time runs out, selected bans will be banned or random, and selected leaders will be picked or, when no valid queued pick remains, the draft auto-scrubs and reopens the lobby for everyone except the timed-out player

#### Leader grid

- **The leader grid** can be opened by a small up arrow button in the bottom center
- **Search** by leader and civ name
- **Filters by tags**, see [Tag filters](#tag-filters) below
- `left click` on a leader selects them, shows the leader details, and during pick phase it shows the leader to teammates
- `right click` only opens the leader details panel
- **Random** will chose a random leader when confirmed (no way to know beforehand)

### Leader pool size

Each draft uses a random subset of leaders.

For non-Red Death drafts, blank leader pool size uses the average rank of the slotted lobby players. Unranked, missing-rank, or no-role servers count as `rank5`.

Default leader pool sizes by average lobby rank:

| Rank    | 1v1 | 2v2 | 3v3 | 4v4 | 5v5 | 6v6 | FFA 8p |
| ------- | --: | --: | --: | --: | --: | --: | -----: |
| `rank1` |  24 |  32 |  40 |  48 |  56 |  64 |     44 |
| `rank2` |  26 |  34 |  42 |  50 |  58 |  66 |     46 |
| `rank3` |  28 |  36 |  44 |  52 |  60 |  68 |     48 |
| `rank4` |  30 |  38 |  46 |  54 |  62 |  70 |     50 |
| `rank5` |  32 |  40 |  48 |  56 |  64 |  72 |     52 |

Min allowed override:

- `1v1`: 8
- `2v2`: 10
- `3v3`: 12
- `4v4`: 14
- `5v5`: 16
- `6v6`: 18
- `FFA`: `3 x player count`: 18-36 for 6-12 players

Max allowed override is all leaders (85).

### Tag filters

Tag categories:

- **Economy** - `gold`, `faith`, `production`, `food`
- **Win Path** - `domination`, `science`, `culture`
- **Power Spike** - `early`, `mid`, `late`
- **Role** - `frontline`, `backline`, `flex`
- **Other** - `cavalry`, `naval`, `defense`, `diplo`, `greatpeople`, `greatworks`

Filter logic:

- AND between categories, example: `Role = backline` and `Win Path = science` means backline science leaders
- OR within a category, example: `Other = cavalry` and `Other = naval` means cavalry or naval leaders

## Result Reporting

Any player that participated in the draft can report the result from any supported server. Reporting and moderation still use the match's owning server. Only the host can scrub the match.

The bot will send reminder DMs to the host roughly 3 and 6 hours after a draft is completed if it hasn't been reported.

### Reporting a result

Two ways:

- inside the **Activity**: any player can click on the team that won and then the `Confirm Result` button in the header; for FFA they select every player in placement order
- using **Commands**:
  - **Duel** and **Teamers**: `/match report winner:...`
  - **FFA**: `/match report winner:... second:... [third/fourth...]`

### What a successful report does

- marks the lobby embed as completed, and posts it in the Archive channel too
- calculates placements and ratings, saves match data
- marks leaderboard and ranked roles dirty for the next sync
- Scrubs won't be logged to the Archive channel, nor affect ratings

## Ranked

Ratings, history, leader stats, leaderboards, rank gates, and ranked roles are scoped to the server where the command or Activity is opened. A reported match updates only its owning server's stats, while still including every participant regardless of where they joined from.

Every reported game updates ratings and adds hidden evidence.
Once a player has enough evidence, the bot assigns a ranked role.

### Commands

- `/leaderboard`: sends leaderboard embeds
- `/stats`: shows player stats, ratings, top leaders, and recent games
- `/rank`: shows player rank history, including past seasons
- `/tiers`: shows current role cutoffs and player distribution

### Rating modes

The bot keeps separate ratings for each game mode:

- **Duel** = `1v1`
- **Duo** = `2v2`
- **Squad** = `3v3`, `4v4`, `5v5`, `6v6`
- **FFA** = `ffa`
- **Red Death** = any Red Death mode

Every ranked game also updates the player's overall ranked rating which Discord ranked roles use.

### Activity-adjusted leaderboard placement

Current per-mode leaderboard placement discourages inactivity at the top without changing ratings:

- only the raw top 20 can receive an inactivity placement adjustment
- the first one-place adjustment occurs after 120 days without a current, non-imported game in that mode, then increases by one place per 30 days up to 20
- playing and reporting a current game clears the adjustment for that mode; imported or historical games do not
- the displayed Elo, rating uncertainty, rating history, and ranked Discord roles remain unchanged

Leaderboard images mark adjusted rows with `↓N`. Persistent images pick up time-based placement changes when that mode is next refreshed by the dirty-check flow, rather than exactly when a boundary is crossed.

### Leader ranks

Leader ranks use a smoothed win rate plus current global elo and a volume bonus:

```txt
serverWinRate = serverWins / serverPicks

adjustedWinRate =
  (playerWins + serverWinRate * 20)
  / (playerPicks + 20)

confidence = playerPicks / (playerPicks + 20)

globalEloBonus =
  clamp(((globalElo - 1000) / 500) * 20pp, -20pp, 20pp)
  * confidence

volumeBonus = min(log1p(playerPicks) / log1p(25), 1) * 2pp

score = adjustedWinRate + globalEloBonus + volumeBonus
```

- `20` is the smoothing strength, it acts like 20 virtual games at the leader's server win rate, so that someone with 100% win rate and few games does not automatically beat everyone else
- the volume bonus is capped at 2 percentage points, grows slower as games go up, and reaches the cap at 25 games, it only helps break close cases, it does not let games played beat much better win rate or global Elo

Players are ranked by:

- total score, highest first
- adjusted win rate
- global Elo
- games on the leader
- wins on the leader
- player id as a stable tie-breaker

### Ranked roles

Example with 5 configured roles:

| Role    | Overall pool |
| ------- | ------------ |
| `tier1` | top 5%       |
| `tier2` | next 15%     |
| `tier3` | next 20%     |
| `tier4` | next 50%     |
| `tier5` | bottom 10%   |

Players with less than **8 games** are `Unranked`, which means the bot won't touch their roles.

### How ratings work

- Ratings use **OpenSkill**, tuned for Civ 6.
- New players start around `1000` display rating.
- The first 10 games move the rating more due to uncertainty.
- In team game modes, players are rated individually. A stronger teammate gains less for a win and loses more for a loss than a weaker teammate.
- There is an anti-farming system, which reduces elo gains from expected wins when expected winrate is above 70%.
- And there is an stablished protection system, veteran players can get partial protection from very large losses to highly uncertain lower rated players. This only reduces the losing player's loss, winner gains are unchanged.

### Extra requirements for high ranks

- Tier 1 needs at least 18 games.
- Tier 1 also needs at least 1 win against a tier-1 opponent and at least 4 wins against tier-2-or-better opponents.
- Tier 2 needs at least 16 games.
- Tier 3 needs at least 8 games.

### Ranked floors

Ranked floors allow a player to get a higher ranked role, even if their current rating is not high enough, based on their performance in games.

Quality wins are wins against opponents who already have qualified high ranked roles:

- `tier1` win: defeated a `tier1` opponent
- `tier2+` win: defeated a `tier1` or `tier2` opponent
- **effective wins** are wins scaled down based on team size, so a 1v1 win counts more than a 4v4 win.

Floors can raise a player to `tier4`, `tier3`, or `tier2`.

`tier4` floor can apply when:

- at least **30 games**
- at least **5 wins**

`tier3` floor requires at least **8 games**, and one of these:

- the player has `tier2` or better in any game mode and at least 20 games in that mode
- the player's overall role is `tier4`, and they have at least 1/2 effective `tier1` wins
- the player's overall role is `tier4`, and they have at least 2 `tier2+` wins worth at least 1/3 effective `tier2+` wins

`tier2` floor requires at least **16 games**, and one of these:

- overall role is `tier3` or better, with at least 3 `tier1` wins and at least 15 `tier2+` wins
- `tier2` or better in any game mode with at least 20 games in that mode, and at least 3 `tier1` wins
- `tier3` or better in any game mode with at least 18 games in that mode, overall ranked-role rating at least `900`, and at least 2 `tier1` wins

These rules do not chain.

### Demotion protection

The bot uses a small keep-role buffer so players do not promote and demote constantly.

Any role retained or raised above the raw overall ladder placement is a grace role. A grace role can be at most one tier above the player's best game mode in which they have at least 10 games.

If a qualified player falls below the keep line, the demotion is delayed. They need to remain below the keep line for 7 days before the bot demotes them.

Promotions can happen immediately with the daily sync.

### Sync

Ranked roles and leaderboards are not updated after every single report. The bot periodically checks if it needs to make updates.

- **Leaderboard embeds**: dirty updates are checked every 15 minutes
- **Ranked roles**: every day at 0:00 UTC, or when `/admin ranked sync` is used
- **Inactive lobby cleanup**: every hour

## Seasons

Seasons are basically groups for reported games, ratings, and ranked roles.

Ending a season will rotate the Leaderboard embeds, and give past season roles to everyone.

**Season roles** are Ranked roles prefixed with the season number, for example `@Role1` becomes `@S1 Role1`. These are only kept for the past 4 seasons, ratings after that can only be viewed with the `/rank` command.

Starting a season with soft reset enabled resets ratings instead of wiping them: players keep their skill estimate but their uncertainty is increased. Starting a season without soft reset only begins assigning new matches to that season and preserves past games.

## Mod Tools

### `/mod`

- `/mod match cancel match_id:...` cancels an open lobby, live match, or completed result; can be used to remove stuck lobbies
- `/mod match resolve match_id:...` corrects the final result of a completed match; can be used to fix reporting mistakes

For completed matches, the bot recalculates the affected ratings.

### Getting Match ID

- `/match status` - lists active lobbies and their match IDs
- right click on a lobby embed or result report embed, then `Apps > CivUp > Match ID` will show the match ID
