# Tournament entries

Tournament competition identity is the `tournament_entries.id`, never an individual player ID. Each entry owns one to six ordered member snapshots. Qualifier standings, rematches, playoff pairings, series scores, winners, corrections, and cancellation repair all reference entry IDs.

Registration writes the full roster immediately during setup. Team modes require fully linked rosters; 1v1 CSV imports may retain a pending display-name snapshot and auto-link it later. Lobby admission uses the stored order to lock each member to a side and slot. The second qualifier entry is claimed with a conditional D1 update before SessionDO accepts the member.

The legacy `tournament_players` table and player-ID columns remain only for additive migrate-before-deploy compatibility. Migration `0021_tournament_entries.sql` backfills them into deterministic one-member entries. New tournament decisions use entry columns.

Loaders batch entries, members, matches, and series rows. Registration does not publish standings, and image rendering caps aggregate avatar fetches. No tournament state is stored in KV.
