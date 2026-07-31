# Admin guide for mod commands

Use this guide to change lobbies and matches with `/mod` commands.

- Every `/mod` command runs immediately. There is no confirmation step.
- Command replies are private. The bot may also update the lobby or result message.
- You can only change a lobby or match from its stored owning server.
- A legacy or imported match without stored ownership must be backfilled or repaired before it can be changed.
- Resolving a completed rated match or changing its players recalculates that match and later matches in the same rating mode. Cancelling removes that match and recalculates later matches.
- These actions also recalculate later overall ratings across modes and can affect the next ranked role sync. Changing leaders does not change player ratings.
- Tournament matches stay out of normal ratings and leader stats. Cancel and resolve update their tournament result.
- When a command has `reason`, it is optional and has a 140-character limit.

## I want to give a role access to mod commands

You need Administrator or Manage Server permission.

1. Run `/admin permission add role:@Role`.
2. Run `/admin permission list`.
3. Check that the role is listed.

Administrator and Manage Server permission already grant access. They do not need a configured Mod role.

## I want to remove a role's access to mod commands

You need Administrator or Manage Server permission.

1. Run `/admin permission remove role:@Role`.
2. Run `/admin permission list`.
3. Check that the role is not listed.

Removing a role from this list does not remove the Discord role from any member.

## I want to find a lobby or match ID

1. For an active lobby or match, run `/match status`.
2. For a lobby or result message, right-click the message.
3. Select `Apps`, then `CivUp`, then `Match ID`.
4. Use the ID exactly as shown in the `match_id` option.

The message action posts the ID in the channel. It only works on stored match messages, usually for up to 180 days. It normally does not work on a new open lobby, so use `/match status` for that lobby ID.

## I want to cancel an open lobby, draft, active match, or completed match

1. Find the lobby or match ID.
2. Run `/mod match cancel match_id:ID`.
3. If needed, add `reason:Why it was cancelled`.
4. Check the private reply for `Cancelled open lobby` or `Cancelled match`.

Cancelling an open lobby closes it and removes its buttons. Cancelling a draft or active match marks it cancelled. Cancelling a completed rated match removes its result and rating changes, then recalculates later matches in the same rating mode and later overall ratings across modes.

The reason can appear on the cancelled lobby or match message. Cancelling a completed match can post a new Archive cancellation message; it does not remove or edit the old result there. You can run the command again on an already cancelled match if its old rating changes were not fully removed.

Use resolve, not cancel, when the match happened but its winner or placements are wrong.

## I want to report or correct a 1v1 or two-team result

1. Find the match ID.
2. Choose any player on the winning team.
3. Run `/mod match resolve match_id:ID winner:@Player`.
4. If needed, add `reason:Why the result was changed`.
5. Check the private reply for `Resolved match`.

Only set `winner`. The bot gives every player on that team first place and every player on the other team second place.

This works for a draft-complete match, a completed match, and a cancelled match. It does not work while the draft is still in progress.

The bot can update the lobby result and post a new Archive result. It does not edit an old Archive result. The reason can appear on the new result.

## I want to report or correct a six- or eight-player 2v2 result

A six-player 2v2 match has three teams. An eight-player 2v2 match has four teams. Use one player from each team to put the teams in placement order.

1. Find the match ID.
2. Set `winner` to a player on the first-place team.
3. Set `second` to a player on the second-place team.
4. Set `third` to a player on the third-place team.
5. For an eight-player match, set `fourth` to a player on the fourth-place team.
6. If needed, add `reason:Why the result was changed`.
7. Run the command and check the private reply for `Resolved match`.

Example:

```text
/mod match resolve match_id:ID winner:@FirstTeamPlayer second:@SecondTeamPlayer third:@ThirdTeamPlayer fourth:@FourthTeamPlayer
```

Do not list two players from the same team. If you omit a team, the bot puts every omitted team after the teams you listed.

The bot can update the lobby result and post a new Archive result. It does not edit an old Archive result. The reason can appear on the new result.

## I want to report or correct an FFA Classic result

1. Find the match ID.
2. Set `winner` to first place.
3. Set `second` to second place.
4. Continue in order through `twelfth` as needed.
5. If needed, add `reason:Why the result was changed`.
6. Run the command and check the private reply for `Resolved match`.

List each player once. Every player you omit shares the next place after the last player you listed. For example, if you only set `winner` and `second`, every other player ties for third.

Do not skip option names. The bot reads the supplied players in option order and closes gaps, so `winner:@A third:@B` records `@B` as second place.

The bot can update the lobby result and post a new Archive result. It does not edit an old Archive result. The reason can appear on the new result.

## I want to report or correct a Permanent Ally FFA result

1. Find the match ID.
2. Set `winner` and `second` to the two players who tied for first.
3. Set `third` and `fourth` to the two players who tied for second.
4. Continue until every player is listed exactly once.
5. Keep each pair of teammates next to each other.
6. If needed, add `reason:Why the result was changed`.
7. Run the command and check the private reply for `Resolved match`.

The option names only set the order. The bot records adjacent players as `1/1`, `2/2`, `3/3`, and so on. Permanent Ally FFA requires every player; you cannot omit the last-place pair.

The bot can update the lobby result and post a new Archive result. It does not edit an old Archive result. The reason can appear on the new result.

## I want to create a completed match that is missing from history

Use `/mod match manual`. This creates a new completed match. Do not use it to fix an existing match.

1. Choose the mode.
2. Fill `player_1` and `leader_1`.
3. Fill every player and leader slot in order, without gaps.
4. Choose every leader from autocomplete.
5. Check the slot order against the table below.
6. Run the command and save the new match ID from the private reply.

| Mode | Players | Slot order |
| --- | ---: | --- |
| `1v1` | 2 | Slot 1 wins. |
| `2v2` | 4 | Slots 1-2 win. Slots 3-4 lose. |
| `2v2` | 8 | Slots 1-2 place first, 3-4 second, 5-6 third, and 7-8 fourth. |
| `3v3` | 6 | Slots 1-3 win. Slots 4-6 lose. |
| `4v4` | 8 | Slots 1-4 win. Slots 5-8 lose. |
| `5v5` | 10 | Slots 1-5 win. Slots 6-10 lose. |
| `6v6` | 12 | Slots 1-6 win. Slots 7-12 lose. |
| `FFA` | 6, 8, 10, or 12 | Permanent Ally FFA. Adjacent pairs place `1/1`, `2/2`, and so on. |
| `FFA Classic` | 6 to 12 | Individual placement follows slot order. |

Every used slot needs both a player and a leader. A player or leader cannot appear twice.

Run this command in the server that should own the result. The bot creates a normal rated match, calculates that server's mode and overall ratings, and updates its player and leader stats. A manual match is added to the active season only when it is created in the configured primary server. It posts the result if an Archive channel is configured. It cannot create a tournament, Red Death, or CivBlitz match. `/mod match manual` has no `reason` option.

## I want to set one player's correct leader

The match must already be completed.

1. Find the match ID.
2. Run `/mod match swap match_id:ID player:@Player leader:Leader`.
3. Choose `leader` from autocomplete.
4. If needed, add `reason:Why the leader was changed`.
5. Check the old and new leader in the private reply.

For a normal match, this changes leader stats. It refreshes the lobby or Draft result, but does not edit an existing Archive result. It does not change placements or player ratings. The reason appears only in the private reply.

Autocomplete includes both current and beta leaders, but the match only accepts its own leader list. If a selected leader is rejected, choose one from the leader list used for that match. For Red Death, use `swap_with`; `leader` cannot set a faction.

## I want to swap the leaders of two players

The match must already be completed, and both players must already have leaders.

1. Find the match ID.
2. Run `/mod match swap match_id:ID player:@FirstPlayer swap_with:@SecondPlayer`.
3. If needed, add `reason:Why the leaders were swapped`.
4. Check both changes in the private reply.

Set `swap_with` or `leader`, never both. Both users must be participants in the match. For a normal match, this changes leader stats. It refreshes the lobby or Draft result, but does not edit an existing Archive result. It does not change placements or player ratings. The reason appears only in the private reply.

## I want to replace a player with a substitute

The match must be draft-complete or completed. You cannot use this on an open lobby or a draft in progress. Do not use it for a tournament match because it does not update the linked tournament players or winner.

1. Find the match ID.
2. Set `player` to the player being replaced.
3. Set `sub` to the replacement player.
4. Run `/mod match sub match_id:ID player:@OldPlayer sub:@NewPlayer`.
5. If needed, add `reason:Why the player was replaced`.
6. Check the changed seat in the private reply.

The replacement takes the old player's seat, team, leader, and placement. The command needs valid stored draft seats for every participant, so some old or imported matches cannot use it.

For a completed rated match, the bot recalculates that match, later matches in the same rating mode, and later overall ratings across modes. It refreshes the lobby or Draft result, but does not edit an existing Archive result.

For an active match, the stored match changes but the live Activity roster and host do not. Do not use this path if players need to continue through the live Activity. The reason appears only in the private reply.

## I want to swap the seats of two players

The match must be draft-complete or completed, and both users must already be participants. Do not use it for a tournament match because it does not update the linked tournament players or winner.

1. Find the match ID.
2. Set `player` to the first player.
3. Set `sub` to the other participant.
4. Run `/mod match sub match_id:ID player:@FirstPlayer sub:@SecondPlayer`.
5. If needed, add `reason:Why the players were swapped`.
6. Check both changed seats in the private reply.

Because leaders, teams, and placements belong to seats, the two players exchange those values. For a completed rated match, the bot recalculates that match, later matches in the same rating mode, and later overall ratings across modes. It refreshes the lobby or Draft result, but does not edit an existing Archive result.

For an active match, the stored match changes but the live Activity roster and host do not. Do not use this path if players need to continue through the live Activity. The reason appears only in the private reply.

## I want to know why a mod command failed

Check these points in order:

1. You have Administrator, Manage Server, or a configured Mod role.
2. You ran the command in the match's stored owning server. A match without stored ownership must be backfilled or repaired first.
3. The `match_id` is exact.
4. Every selected user is a participant when the command requires one.
5. The match is in the state required by the command.
6. Every leader came from autocomplete.
7. Manual match slots start at 1, have no gaps, and contain both a player and a leader.
8. Resolve input follows the correct team, FFA Classic, or Permanent Ally FFA order.

The database change and Discord message update are separate. A lobby, result, archive, leaderboard, or role update can appear later than the private success reply. If a command times out or returns a generic error, check the match before running it again.
