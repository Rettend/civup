# Player data export

Server administrators can export player and match history from **Player Data** at the bottom of the full lobby overview. The action is hidden in the mini view and from users without the server-provided capability. **Saved Games** uses the same capability check and remains available only in the embedded Discord Activity.

The Activity requests the Discord `guilds` OAuth scope at sign-in and stores the configured guild's permission bitset in its signed session. Permissions are refreshed when the eight-hour Activity session is issued. The bot exposes authenticated capabilities at `GET /api/activity/admin/capabilities`; every export-feed request separately requires Administrator or Manage Server permission for `ALLOWED_DISCORD_GUILD_ID`.

`GET /api/activity/admin/player-data-export` returns a creation-time-cutoff keyset feed in server-enforced pages of 50 parents. It emits players and their ratings first, followed by matches with participants and bans. Mutable rows can change while the multi-request export runs, so this is a best-effort consistent export rather than a transactional snapshot. SQLite extracts legacy bans for only the current page; draft JSON is never returned to or parsed by the Worker. The feed does not use offsets or full-table counts.

The Activity fetches pages sequentially, then creates six sheets in the browser: `overview`, `players`, `ratings`, `matches`, `match_participants`, and `match_bans`. Repeated display names and derived rating values are omitted from detail sheets while the underlying IDs and rating parameters remain. Worksheet XML is streamed into the XLSX ZIP and strings use inline-string cells. The browser rejects exports above 500,000 source rows or Excel's per-sheet row limit instead of exhausting memory. The Worker does not build or attach a workbook. `/admin export` is retained as a lightweight pointer to the Activity action.

The downloaded filename is `export-YYYY-MM-DD.xlsx`. If an embedded iframe blocks the automatic download, the completed status keeps a **Download … again** link for a manual retry.
