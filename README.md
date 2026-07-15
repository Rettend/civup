# CivUp

CivUp is a Civ VI draft bot with a Discord Activity. The bot and Activity are separate Cloudflare Workers.

This page is the setup guide. See the [Manual](MANUAL.md) for features and the [player guide](GUIDE.md) for everyday use.

## What you need

- [Bun](https://bun.sh/)
- a Cloudflare account
- `cloudflared` for local tunnels
- two Discord apps: one for development and one for production

No privileged Discord Gateway intents are needed.

## Discord apps

Do this once for each Discord app.

1. Copy the **Application ID**, **Public Key**, bot token, and OAuth client secret from the Developer Portal.
2. Under **Installation**, enable Guild Install with the `applications.commands` and `bot` scopes.
3. Give the bot View Channels, Send Messages, Embed Links, Attach Files, and Manage Roles.
4. After installing it, keep the CivUp bot role above every role it manages.
5. Enable Activities and Activity Web support. Keep Discord's global **Launch** command.
6. Add the Activity origin itself and `<activity origin>/api/auth/discord/callback` as OAuth redirects.
7. Add a root (`/`) Activity URL mapping to the Activity origin.

Use the development app only with local tunnels. Use the production app only with deployed Workers.

## Local setup

1. Install dependencies and copy the examples.

   ```bash
   bun install
   cp cloudflared.dev.example.yml cloudflared.dev.yml
   cp apps/bot/.dev.vars.example apps/bot/.dev.vars
   cp apps/activity/.dev.vars.example apps/activity/.dev.vars
   ```

2. Generate one shared secret and put it in both `.dev.vars` files as `CIVUP_SECRET`.

   ```bash
   bunx @rttnd/gau secret
   ```

   Put the development app's public values and bot token in the bot file. Put its client ID and client secret in the Activity file. Both files need the same guild ID and Activity tunnel origin.

3. Create the tunnel, route your two development hostnames to it, and fill `cloudflared.dev.yml`.

   ```bash
   cloudflared tunnel create civup-dev
   cloudflared tunnel route dns civup-dev bot-dev.example.com
   cloudflared tunnel route dns civup-dev activity-dev.example.com
   ```

   The bot hostname goes to port 8787 and the Activity hostname to 5173. Add your Activity hostname to `server.allowedHosts` in `apps/activity/vite.config.ts`.

4. Create the local database schema.

   ```bash
   bun run bot:l:migrate
   ```

   Local D1, KV, R2, and Durable Objects are created by Wrangler. They do not need remote resources.

5. Start the bot, Activity, and tunnel before saving the Discord endpoint.

   ```bash
   bun run dev:new
   ```

6. In the development Discord app, set the Interactions Endpoint URL to the bot tunnel URL. Set the redirects and root Activity mapping to the Activity tunnel URL.
7. Install the development app in the configured server, then register its guild commands.

   ```bash
   bun run bot:register
   ```

8. Try `/ping`, `/admin health`, and the Launch command.

`bun run dev` reuses the last Activity build. `bun run dev:live` uses Vite live mode.

## Production setup

### 1. Fill public config

Pick the Cloudflare account first. Confirm it with `bunx wrangler whoami`, then fill both standard Wrangler files:

- `apps/bot/wrangler.jsonc`
- `apps/activity/wrangler.json`

The account ID, guild ID, and Activity origin must match. The Activity `DISCORD_CLIENT_ID` and bot `DISCORD_APPLICATION_ID` must be the production app ID. Replace the checked-in `DISCORD_PUBLIC_KEY` placeholder in the bot config with the production app's 64-character public key before deploying.

Keep the Activity `BOT` service binding pointed at the bot Worker's `name`. Production traffic does not use a public bot host.

### 2. Create Cloudflare storage

Create D1 and KV once, after selecting the right account.

```bash
bun run bot:d1:create
bun run bot:kv:create
```

Saved-game uploads are optional. To enable them, keep the `AUTOSAVE_UPLOADS` R2 binding and create its bucket once:

```bash
bun run bot:r2:create
```

To disable uploads, remove the `r2_buckets` block. Everything else keeps working and `/admin health` reports a warning. Durable Objects are created automatically when the bot Worker deploys.

Failed and abandoned multipart uploads keep a D1 cleanup record. The bot retries cleanup in the background and during the hourly cleanup job, so recovery does not depend on the browser staying open.

Each member may have one multipart upload in progress and retain up to 100 saved-game uploads or 2 GiB, whichever comes first. Individual zip files are limited to 512 MiB; an admin can delete older uploads to free quota.

Migration `0022` removes legacy non-uploaded catalog rows because those rows predate persisted multipart IDs. Any corresponding pre-migration R2 objects or multipart fragments require bucket lifecycle or manual cleanup; completed uploaded rows are preserved.

### 3. Upload the small secret set

Copy the examples without committing the copies.

```bash
cp apps/bot/.prod.secrets.example apps/bot/.prod.secrets
cp apps/activity/.prod.secrets.example apps/activity/.prod.secrets
```

The bot Worker secrets are `DISCORD_TOKEN` and `CIVUP_SECRET`. Its file also contains the public `DISCORD_APPLICATION_ID` and `ALLOWED_DISCORD_GUILD_ID` values used by command registration; keep them in sync with `apps/bot/wrangler.jsonc`. Activity secrets are `DISCORD_CLIENT_SECRET` and `CIVUP_SECRET`. Vite reads the browser client ID from `apps/activity/wrangler.json`. Generate `CIVUP_SECRET` with `bunx @rttnd/gau secret` and use the same value for both Workers.

```bash
bun run bot:secrets:prod
bun run a:secrets:prod
```

### 4. Deploy and connect Discord

For the first deployment, run:

```bash
bun run deploy:prod
```

The command keeps the existing order: remote D1 migration, bot deploy, Activity build, then Activity deploy. Check the public Wrangler values and replace the bot public-key placeholder before running it.

After both URLs exist:

1. set the production Interactions Endpoint URL to the bot Worker URL;
2. add the Activity origin and browser callback OAuth redirects;
3. add the root Activity URL mapping;
4. install the app in the configured server;
5. register guild commands with `bun run bot:register:prod`.

For later releases, this does deploy plus registration:

```bash
bun run deploy:prod:full
```

The registration script always requires a guild. It does not replace Discord's global Launch command.

Browser access is optional. After its callback redirect exists, enable it with `/admin setup target:Browser Access value:on`. Keep the bot role above the zero-permission preference role it creates.

Smoke test `/ping`, `/admin health`, a Discord Activity launch, browser launch if enabled, and a saved-game upload if R2 is enabled.

## Local commands

```bash
bun run dev:new
bun run dev
bun run dev:live
bun run bot:l:migrate
bun run bot:register
bun run bot:kv:local
```

## Local cron triggers

Hourly cleanup:

```bash
curl.exe "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+%2A+%2A+%2A+%2A"
```

Leaderboard refresh every 15 minutes:

```bash
curl.exe "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=%2A%2F15+%2A+%2A+%2A+%2A"
```

Daily ranked-role sync at 00:00 UTC:

```bash
curl.exe "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+0+%2A+%2A+%2A"
```

## Cleaning up old remote values

After the new deployment passes its smoke tests, explicitly delete the obsolete public bot-host setting, R2 account/bucket vars, and R2 upload-key secrets from both Workers in Cloudflare. Revoke the old R2 API token and remove any old `/r2-upload` Discord URL mapping. This repository never changes deployed Worker settings for you.
