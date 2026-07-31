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

1. Under **General Information**, copy the **Application ID** and **Public Key**. Copy the token from **Bot** and the client secret from **OAuth2**.
2. Under **Installation**, enable **Guild Install** under **Installation Contexts**. **User Install** is optional. Select **Discord Provided Link**, then add the `applications.commands` and `bot` scopes under **Default Install Settings** > **Guild Install**.
3. In the Guild Install bot permissions, select View Channels, Send Messages, Embed Links, Attach Files, and Manage Roles.
4. After installing it, keep the CivUp bot role above every role it manages.
5. Under **Activities** > **Settings**, turn on **Enable Activities** and select **Supported Platforms** > **Web**. Keep Discord's global **Launch** command.
6. Under **OAuth2** > **Redirects**, add the Activity origin itself and `<activity origin>/api/auth/discord/callback`.
7. Under **Activities** > **URL Mappings**, add prefix `/` with the Activity hostname as its target. The target must omit `https://`.

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

   Put the development app's public values and bot token in the bot file. Put its client ID and client secret in the Activity file. Both files need the same primary guild ID, comma-separated additional-guild list, and Activity tunnel origin. For a single-server setup, omit `ALLOWED_DISCORD_GUILD_IDS` instead of leaving it blank.

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

6. In the development Discord app, set the Interactions Endpoint URL to the bot tunnel URL. Add the Activity tunnel origin and callback under **OAuth2** > **Redirects**, then map `/` under **Activities** > **URL Mappings** to the Activity tunnel hostname without `https://`.
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

The account ID, primary guild ID, additional-guild list, and Activity origin must match. `ALLOWED_DISCORD_GUILD_ID` is the primary server; `ALLOWED_DISCORD_GUILD_IDS` is an optional comma-separated list of additional supported servers, and the primary server is included automatically. The Activity `DISCORD_CLIENT_ID` and bot `DISCORD_APPLICATION_ID` must be the production app ID, and the bot `DISCORD_PUBLIC_KEY` must be that app's 64-character public key.

Find or change the account's `workers.dev` subdomain on the Cloudflare **Workers & Pages** page under **Your subdomain**. With the checked-in Worker names, the Activity origin is `https://civup-activity.<account subdomain>.workers.dev`.

Keep the Activity `BOT` service binding pointed at the bot Worker's `name`. Activity-to-bot traffic uses this binding; Discord interactions still use the bot Worker's public URL.

### 2. Create Cloudflare storage

Create D1 and KV once, after selecting the right account.

```bash
bun run bot:d1:create
bun run bot:kv:create
```

Autosave uploads are optional. To enable this niche feature, keep the `AUTOSAVE_UPLOADS` R2 binding and create its bucket once:

```bash
bun run bot:r2:create
```

Otherwise, remove the `r2_buckets` block. The rest of the bot works normally and `/admin health` reports only a warning. Durable Objects are created automatically when the bot Worker deploys.

### 3. Upload the small secret set

Copy the examples without committing the copies.

```bash
cp apps/bot/.prod.secrets.example apps/bot/.prod.secrets
cp apps/activity/.prod.secrets.example apps/activity/.prod.secrets
```

Generate `CIVUP_SECRET` with `bunx @rttnd/gau secret` and use the same value for both Workers.

The bot file also supplies command registration. Fill its application ID, token, primary guild ID, and optional supported-guild list; the guild values must match both Wrangler configs.

```bash
bun run bot:secrets:prod
bun run a:secrets:prod
```

### 4. Deploy and connect Discord

For the first deployment, run:

```bash
bun run deploy:prod
```

The command keeps the existing order: remote D1 migration, bot deploy, Activity build, then Activity deploy. Check the public Wrangler values before running it.

After both URLs exist:

1. under **General Information**, set **Interactions Endpoint URL** to the bot Worker URL;
2. under **OAuth2** > **Redirects**, add the Activity origin and browser callback;
3. under **Activities** > **URL Mappings**, map `/` to the Activity hostname without `https://`;
4. install the app in every configured supported server;
5. register guild commands in all of them with `bun run bot:register:prod`.

For later releases, this does deploy plus registration:

```bash
bun run deploy:prod:full
```

The registration script requires valid approved-server configuration and registers commands in every supported server. It does not replace Discord's global Launch command.

When upgrading an existing single-server database to the scoped multi-server schema, record the millisecond timestamp immediately before deploying the scoped-write Worker. After the migration and Worker deploy, preview and apply the idempotent ownership/rating backfill before enabling partner servers:

```bash
bun run bot:backfill:multi-server preview --remote --cutoff <timestamp>
bun run bot:backfill:multi-server apply --remote --cutoff <timestamp> --execute --yes
```

Resolve every validation count before adding partner IDs. The report path keeps reading missing primary rating rows from the legacy tables during this short cutover, but the backfill remains required for complete scoped history and read views.

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
