# Public PPL website

The Activity Worker serves the public `/`, `/leaderboards`, `/rules`, and `/creators` SPA routes while preserving the embedded Activity routes. At `/`, the Activity starts only for a framed Discord launch with the required launch query values. During local Vite development, `/?activity_dev=1` is the explicit embedded-Activity escape hatch.

The exact public leaderboard proxy is `GET /api/public/leaderboards`. It defaults to the primary approved server and accepts one optional approved `server` query value. Other query values and methods are rejected.

The bot projection reads stored player and civilization snapshots only. A public read never creates a missing snapshot. Successful display-only payloads are cached per approved-server configuration in bot KV for 15 minutes and may be edge-cached by the Activity Worker for 5 minutes. Errors are not cached. Player IDs, hidden rating values, activity timestamps, and avatar URLs are excluded from the public contract.

Replace the intentionally empty rules and creator copy in `apps/activity/src/client/public/content.ts` only with approved text and verified creator URLs.

Build the PPL site without deploying it:

```bash
bun run --filter civup-activity build:ppl
```
