# Manual

## What it does

- live lobby embeds in a Draft text channel
- the draft inside a Discord Activity
- result reporting and scrubs
- elo rating calculation
- ranked Discord roles
- leaderboard embeds

### Terms

- **Lobby**: an open queue before the draft starts
- **Draft**: the Activity phase where bans and picks happen
- **Match**: the game after the draft is completed
- **Reported match**: a finished match with placements, rating changes, and history

### Match flow overview

1. **someone runs `/match create`**, this creates the lobby embed and joins them as host
2. **players join**

    - directly, by clicking on the embed's Join button, or
    - using `/match join`, which does a little matchmaking and finds the best lobby

3. Optional: the **host can change configs** in the Activity, including the **Steam lobby link**
4. the host **starts the draft**
5. the players **complete the bans and picks**
6. they leave the activity and **play the game**
7. the host comes back and **reports the result** or scrubs the match

See more: [Match Flow](#match-flow)

## First-time setup

### 1. Set the system channels

Run these in the channels you want the bot to use:

- `/admin setup target:Draft` - required; this is where lobby embeds live
- `/admin setup target:Archive` - optional; the bot posts match results here
- `/admin setup target:Leaderboard` - optional; the bot sends an updating leaderboard

> [!IMPORTANT]
>
> - lobby messages appear in the configured Draft channel even if the slash command was run elsewhere
> - running `/admin setup` again in the same channel for the same target removes that target

### 2. Configure ranked roles

Use `/admin ranked set` to map your Discord roles to tiers:

- `tier1` is the highest role
- the last configured tier is the base role that players get after playing 3 games, otherwise they are Unranked
- bot supports 3 to 10 tiers

Useful commands:

- `/admin ranked roles` - show current mappings
- `/admin ranked set role1:@Role ...` - set mappings
- `/admin ranked unset slot:...` - clear one mapping

### 3. Mod command access

> [!TIP]
> Use `/help` to see all commands that you can use

There are 3 levels of access:

- **General**: commands that everyone can use
- **Mod**: can also use `/mod` commands
- **Admin**: can also use `/admin` commands

> [!NOTE]
>
> #### Configure Mod role
>
> - `/admin permission add role:@Mod`
>
> `@Mod` role can now use `/mod` commands.

### 4. Set server defaults (Optional)

Use `/admin config` to inspect and change the global default configs.

| Key | Note | Default |
| --- | --- | --- |
| `ban_timer` | time in seconds for the ban phase | `180` |
| `pick_timer` | time in seconds for a single player to pick a leader | `180` |
| `queue_timeout` | time in minutes before a queue is closed due to inactivity | `30` |

> [!NOTE]
>
> - leader pool size is hard-coded for each game mode not avaiable as a global config currently
> - hosts can override timers and leader pool size for their lobby before the draft starts
> - leaving a timer blank means "use the server default"
> - setting a timer to `0` means unlimited
> - if the last join was more than `queue_timeout` minutes ago a lobby is simply marked as inactive, but inactive lobbies are only cleaned up hourly

### 5. Start a season when ranked play should count

The bot can be used without an active season, but games will not be saved to a season in that case.

This matters because season start is a hard reset of:

- current ratings
- current ranked roles
- current leaderboard embeds

Use `/admin season start` to start a season, the name format is "Season {i}" and "S{i}" where i=1..n
Use `/admin season end` when the season is over

Both actions:

- require confirmation
- are not recoverable

## Match Flow

### Lobby

> [!TIP]
>
> The only command players have to use is `/match create` (host only), it's easier to click on the lobby embed's Join button, or simply join the activity and then browse the Lobby Overview page.

The `/match` command group manages the lobby.

- `/match create mode:... [steam_link]` creates an open lobby and auto-joins as host
- `/match join mode:... [teammates]` joins the best open lobby for that mode, specifying teammates will treat them as premades
- `/match status` lists active lobbies and IDs
- `/match leave` leaves the active lobby
- `/match cancel` host cancels their lobby

> [!NOTE]
>
> - players can only join one lobby, consequently a host can only host one lobby, re-running `/match create` reuses that lobby
> - team modes must be full to start, except FFA which can start with 6 to 10 players

### Activity

Pages:

- **Lobby Overview**: shows all lobbies and their status, can be accessed anytime with the top right corner button
- **Draft Setup**: the page that opens when a lobby is opened and before it's started, it shows the player seats and the lobby config
- **Draft**: where pick & ban happens
- **Post-draft**: shows the final draft, the host can report the match result here

#### Draft Setup

The host can:

- change game mode anytime before the draft has started
- place and remove players from slots
- link or unlink premades in team modes
- randomize or auto-balance teams
- set Matchmaking Min Rank (only affects `/match join`, any player can directly join any lobby)
- set the leader pool size
- set ban and pick timers
- set or update the Steam lobby link
- start, cancel, or later scrub the match

Players can:

- move themselves into open seats
- leave their own slot
- link themselves as premades to others
- see the current config and draft state

Team arrange notes:

- randomize keeps premades legal and shuffles the valid team layout
- auto-balance preserves premades and uses current ratings to choose the split closest to a 50/50 prediction

### Steam lobby links

Optional feature.

In the Activity:

- host sees a dark Steam button top left where they can set/update/clear the link anytime

Using commands:

- for a new lobby: `/match create` `steam_link` parameter
- existing lobby: `/match steam set` and `/match steam clear`

When the Steam lobby link is set, other players see a gold Steam button top left, clicking that will open Civ and join the lobby.

## Draft Rules

### Draft format

| Mode | Bans | Pick order |
| --- | --- | --- |
| `1v1` | 3 each | 12 |
| `2v2` | captains ban 3 each | 1221 |
| `3v3` | captains ban 3 each | 122112 |
| `4v4` | captains ban 3 each | 12212112 |
| `FFA` | 1 each | seat order |

> [!NOTE]
>
> Captains are the first seat in each team, only they can submit bans.

### Draft behavior

- bans are blind, all teams ban at the same time and bans are only revealed when the ban phase is completed
- if the time runs out, selected bans will be banned or random, and selected leaders will be picked or the draft is auto-scrubbed

#### Leader grid

- **The leader grid** can be opened by a small up arrow button at the bottom center
- **Search** by leader and civ name
- **Tag filters**, see [Tag filters](#tag-filters) below
- `left click` on a leader selects them, shows the leader details, and an during pick phase it shows the leader to teammates
- `right click` only opens the leader details panel
- `shift + left click` or holding `left click` selects additional leaders: when the timer runs out without confirming a pick it will pick the selected leader, if that was picked, it will select the next valid selected additional leader
- **Random** will chose a random leader when confirmed (no way to know beforehand)

### Leader pool size

Each draft uses a random subset of leaders.

Default leader pool sizes (and min allowed override):

- `1v1`: 24 (min 8)
- `2v2`: 32 (min 10)
- `3v3`: 40 (min 12)
- `4v4`: 48 (min 14)
- `FFA`: `4 x player count`: 24-40 for 6-10 players (min `2 x player count` 12-20 for 6-10 players)

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
- OR within a category, example: `Other = cavalry` and `Other = naval` means cavalry OR naval

## Result Reporting

Only host can report the result or scrub it.

### Reporting a result

Two ways to report a game result:

- inside the **Activity**: host can click on the team that won and then the `Confirm Result` button in the header, for FFA the host needs to select the players in order
- using **Commands**: `/match report winner:...` for duels and teamers, `/match report [...placements]` for FFA

### What a successful report does

- marks the lobby embed as completed, and posts it in the Archive channel too
- calculates placements and ratings, saves match data
- marks leaderboard and ranked roles dirty
- Scrubs won't be logged to the Archive channel, nor affect ratings

## Ranked

### Rating

3 separate leaderboards and separate elo scores:

- **Duel** = `1v1`
- **Teamers** = `2v2`, `3v3`, `4v4`
- **FFA** = `ffa`

Commands to view rating:

- `/leaderboard`: sends the Leaderboard embeds again
- `/stats`: the player's stats per game mode, top leaders, and recent games
- `/rank`: the player's stats per game mode, and the same for past seasons
- `/tiers`: live cutoffs and player distribution

### Elo system

- uses **OpenSkill** with parameters tuned for Civ 6: games are less frequent so it uses more uncertainty
- the **first ~10-20 games** are pretty volatile, but after that it gets very accurate
- new player **display elo** starts at `1000` and they are Unranked
- a player needs **3 games** in a game mode to get the first Ranked role and appear on the leaderboard

### Ranked roles

A player's overall role comes from their **best current role** in one of the modes, not an average of all modes

Example with 5 configured Ranked roles:

| Role | Earn | Keep |
| --- | --- | --- |
| `tier1` | 1.5% (top 1.5%) | 2.0% (Top 2.0%) |
| `tier2` | 4.0% (top 5.5%) | 4.5% (Top 6.5%) |
| `tier3` | 10.0% (top 15.5%) | 10.5% (Top 17.0%) |
| `tier4` | 20.0% (top 35.5%) | 20.5% (Top 37.5%) |
| `tier5` | everyone else (top 100.0%) | - |

There is a compounding 0.5% buffer for each tier, players earn the role when they reach the Earn threshold, and keep it until they drop below the Keep threshold.

> [!IMPORTANT]
>
> Demotion protection: players must stay below the Keep threshold for **7 days** before they lose the role.

### Tier unlocking

Higher tiers stay locked until enough players are ranked.

Example with 5 configured Ranked roles:

- `tier1`: 80 ranked players
- `tier2`: 40 ranked players
- `tier3`: 20 ranked players
- `tier4`: 8 ranked players

Until a tier unlocks, nobody earns it in that game mode.

### Sync

Ranked roles and the leaderboard are not updated after every single report. Instead they are updated periodically.

- **Leaderboard embeds**: every 2 minutes
- **Ranked roles**: every day at 9:00 UTC, or when `/admin ranked sync` is used
- **Inactive queue cleanup**: every hour on the hour

## Seasons

Seasons are basically groups for reported games, ratings, and ranked roles.

Ending a season will rotate the Leaderboard embeds, and give past season roles to everyone prefixed with the season number, for example `@Role1` becomes `@S1 Role1`.

Ending a season currently does a hard reset of all ratings.

## Correction tools for Mods

### `/mod`

- `/mod match cancel match_id:...` cancels an open lobby, live match, or completed result
- `/mod match resolve match_id:...` corrects the final result of a completed match

For completed matches, the bot recalculates the affected ratings.

### Getting Match ID

- `/match status` - lists active lobbies and match IDs
- right click on a lobby embed or result report embed, then `Apps > CivUp > Match ID` will show the match ID
