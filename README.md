# CivUp

CivUp is a Civ VI draft bot with a Discord Activity. The bot and Activity are separate Cloudflare Workers.

This page is the setup guide. See the [Manual](MANUAL.md) for features and the [player guide](GUIDE.md) for everyday use.

## What you need

- [Bun](https://bun.sh/) 1.4.2
- Node.js 24 (the repository pins 24.21.0 in `.node-version`)
- a Cloudflare account
- `cloudflared` for local tunnels
- two Discord apps: one for development and one for production

No privileged Discord Gateway intents are needed.

Bun installs dependencies and runs workspace scripts. Vite+ and Cloudflare commands run under Node.

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

   Local D1, KV, R2, and Durable Objects use `apps/bot/.wrangler/state`. Development and maintenance commands share this directory; they do not need remote resources. `DRIZZLE_DB_URL` can select an explicit SQLite file for Drizzle.

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

Pass `--no-tunnel` to run only the local Workers. Add `--print-commands` to inspect the commands without starting them:

```bash
bun run dev:live --no-tunnel --print-commands
```

## Production setup

### 1. Fill public config

Pick the Cloudflare account first, then fill its public settings in `config/cloudflare-targets.ts`. Both Workers read this data:

- `apps/bot/cloudflare.config.ts`
- `apps/activity/cloudflare.config.ts`

Set the account ID, guild ID, Activity origin, and Discord application ID and public key. The configs derive both Workers' public variables and service binding from these values. Keep secrets in the secret files.

Find or change the account's `workers.dev` subdomain on the Cloudflare **Workers & Pages** page under **Your subdomain**. With the checked-in Worker names, the Activity origin is `https://civup-activity.<account subdomain>.workers.dev`.

`deploy:prod` selects the `standard` target. PPL uses `config/cloudflare-targets.local.json`, which is git-ignored; copy the adjacent example when setting up that target. Both targets use the same Worker names in different accounts. Selecting a target does not select remote storage: migration and maintenance commands choose local or remote separately.

Authenticate with `bunx cf auth login`. The retained Wrangler adapters also need authentication: use `bunx wrangler login`, or supply `CLOUDFLARE_API_TOKEN` for both tools. Commands select the account from the target settings.

### 2. Create Cloudflare storage

Create D1 and KV once, after selecting the right account.

```bash
bun run bot:d1:create
bun run bot:kv:create
```

Copy the returned database and namespace IDs into the selected target settings. These commands do not edit configuration files.

Autosave uploads are optional. To enable this niche feature, keep the `AUTOSAVE_UPLOADS` R2 binding and create its bucket once:

```bash
bun run bot:r2:create
```

Otherwise, remove the target's `r2` entry. The rest of the bot works normally and `/admin health` reports only a warning. Durable Objects are created automatically when the bot Worker deploys.

### 3. Upload the small secret set

Copy the examples without committing the copies.

```bash
cp apps/bot/.prod.secrets.example apps/bot/.prod.secrets
cp apps/activity/.prod.secrets.example apps/activity/.prod.secrets
```

The bot Worker secrets are `DISCORD_TOKEN` and `CIVUP_SECRET`. Activity secrets are `DISCORD_CLIENT_SECRET` and `CIVUP_SECRET`. Upload commands select only these keys and send their values over stdin. Registration and production Activity builds take their public Discord IDs from the selected target. Generate `CIVUP_SECRET` with `bunx @rttnd/gau secret` and use the same value for both Workers.

```bash
bun run bot:secrets:prod
bun run a:secrets:prod
```

### 4. Deploy and connect Discord

For the first deployment, run:

```bash
bun run deploy:prod
```

The command runs remote D1 migrations, builds and deploys the bot, then builds and deploys the Activity. Each deployment checks that its prebuilt files belong to the selected target. Inspect the sequence without running it with `bun run deploy:prod --print-commands`.

After both URLs exist:

1. under **General Information**, set **Interactions Endpoint URL** to the bot Worker URL;
2. under **OAuth2** > **Redirects**, add the Activity origin and browser callback;
3. under **Activities** > **URL Mappings**, map `/` to the Activity hostname without `https://`;
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

## Builds and checks

```bash
bun install --frozen-lockfile
bun run check
bun run lint
bun run format:check
bun run test
bun run --filter civup-bot build
bun run --filter civup-activity build:prod
```

Build commands only create local files. Activity's plain `build` uses the development Discord app; `build:prod` uses standard settings and `build:ppl` uses local PPL settings.

Activity tests run through Vite+ and Vitest with the Solid compiler. Bot and package tests use Bun. `bun run test:cov` writes separate reports under `coverage/`; `bun run test:ui` opens the Activity test UI. Use `lint:fix` and `format` to apply lint and formatting changes.

`bun run test:cloudflare:local` checks migrations and D1/KV operations in temporary storage with fixture identities. It does not use the development database or remote resources.

The `tsc` command uses native TypeScript 7. The `typescript` dependency supplies TypeScript 6's JavaScript API for lint plugins that still need it.

Wrangler remains installed for bot bundling and operations the pinned `cf` cannot preserve: the bot's tagged Durable Object migrations and `keep_vars`, stdin secret uploads, and complete remote KV listing. Local D1 typed bindings and SQL scripts use Miniflare where `cf` would lose values or results; local KV listing also uses Miniflare. These adapters consume the shared target data. Generated configuration and build output live under ignored `.cloudflare` directories.

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
