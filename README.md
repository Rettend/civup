# CivUp

Draft bot for Civ VI that uses Discord Activities

## Requirements

- Bun
- Cloudflare account
- Discord app created in the Discord Developer Portal
- `cloudflared` locally for dev

## Local setup

1. Install deps:

    ```bash
    bun install
    ```

2. Copy the dev env files:

    ```bash
    cp cloudflared.dev.example.yml cloudflared.dev.yml
    cp apps/bot/.dev.vars.example apps/bot/.dev.vars
    cp apps/activity/.dev.vars.example apps/activity/.dev.vars
    cp apps/party/.dev.vars.example apps/party/.dev.vars
    ```

    and fill them in. glhf

3. Apply the local DB schema:

    ```bash
    bun run bot:l:migrate
    ```

4. Set up Cloudflare Tunnels

    Update `cloudflared.dev.yml` with your domains and create tunnels, also update `apps/activity/vite.config.ts`.

5. Set these in the Discord Developer Portal:

    - Interactions Endpoint URL: your bot tunnel URL
    - Activity URL Mapping: your activity tunnel URL

6. Register bot commands in your guild:

    ```bash
    bun run bot:register
    ```

7. Start the full local stack:

    It runs these: 1. Bot, 2. Activity, 3. Partyserver, 4. Tunnels

    ```bash
    bun run dev:new
    ```

    This will rebuild the activity app, use `bun run dev` to skip that.

## Local commands

```bash
bun run dev:new
bun run dev

bun run bot:l:migrate
bun run bot:dev
bun run a:dev:new
bun run a:dev
bun run party:dev
bun run tunnel
bun run bot:kv:local
```

Trigger the leaderboard cron locally:

```bash
curl.exe "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=%2A%2F2+%2A+%2A+%2A+%2A"
```

## Production setup

1. Provision Cloudflare resources once:

    ```bash
    bun run bot:d1:create
    bun run bot:kv:create
    ```

2. Copy the production env files:

    ```bash
    cp apps/bot/.prod.secrets.example apps/bot/.prod.secrets
    cp apps/activity/.prod.secrets.example apps/activity/.prod.secrets
    cp apps/activity/.prod.vars.example apps/activity/.prod.vars
    cp apps/party/.prod.secrets.example apps/party/.prod.secrets
    ```

    fill them in again :)

3. Update Cloudflare config to use your own account, URLs, and routes:

    - `apps/bot/wrangler.jsonc`
    - `apps/activity/wrangler.jsonc`
    - `apps/party/wrangler.jsonc`

    At minimum:

    - set `BOT_HOST` to your deployed bot worker URL
    - set `PARTY_HOST` to your deployed party worker URL
    - set `VITE_ACTIVITY_HOST` to your deployed activity host without protocol
    - replace account IDs, database IDs, KV IDs, and route/domain values that still point at a different account

4. Upload secrets:

    ```bash
    bun run bot:secrets:prod
    bun run a:secrets:prod
    bun run party:secrets:prod
    ```

5. In the Discord Developer Portal:

    - Interactions Endpoint URL: your bot worker URL
    - Activity URL Mapping: your activity worker URL

6. Deploy:

    ```bash
    bun run deploy:prod
    ```

    That runs the remote DB migration and deploys bot, activity, and party.

7. Register slash commands:

    ```bash
    bun run bot:register:prod
    ```

    Or do deploy + register in one step:

    ```bash
    bun run deploy:prod:full
    ```

## Project layout

- `apps/bot`: Discord interactions worker
- `apps/activity`: Discord Activity frontend
- `apps/party`: realtime draft partyserver
- `packages/db`: Drizzle schema and migrations
- `packages/game`: shared game data and draft logic
- `packages/rating`: elo system
- `packages/utils`: shared utils
