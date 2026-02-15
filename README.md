# CivUp

Champ select for Civ VI that's a Discord Activity, and a fully featured Discord Bot

<https://github.com/user-attachments/assets/e3ac25bf-27b1-4549-9a4d-3666560230d6>

## Deployment

### One-time setup

1. Install deps: `bun install`
2. Provision infra (only if D1/KV do not already exist):

```bash
bun run bot:d1:create
bun run bot:kv:create
```

1. Create production env files:

```bash
cp apps/bot/.prod.secrets.example apps/bot/.prod.secrets
cp apps/activity/.prod.secrets.example apps/activity/.prod.secrets
cp apps/activity/.prod.vars.example apps/activity/.prod.vars
```

1. Fill in secrets/vars in those files.
2. Upload Worker secrets:

```bash
bun run bot:secrets:prod
bun run a:secrets:prod
```

### Discord Developer Portal Setup

#### Interactions Endpoint URL

Prod: <https://civup-bot.rettend.workers.dev>
Dev: <https://bot-dev.rettend.me> (your cloudflared tunnel to local wrangler dev)

#### Activity URL Mapping (Embedded App)

Prod: <https://civup-activity.rettend.workers.dev>
Dev: <https://activity-dev.rettend.me> (your cloudflared tunnel to local wrangler dev)

### Production URLs and bindings

Production runtime URLs are configured in:

- `apps/bot/wrangler.jsonc`
- `apps/activity/wrangler.jsonc`

Current defaults:

- `BOT_HOST=https://civup-bot.rettend.workers.dev`
- `PARTY_HOST=https://civup-party.rettend.partykit.dev`

If you switch to custom domains, update both Wrangler configs.

### Deploy

Deploy DB schema + Bot + Activity:

```bash
bun run deploy:prod
```

Register slash commands after deploy:

```bash
bun run bot:register:prod
```

Or run the full flow in one command:

```bash
bun run deploy:prod:full
```

PartyKit deploy remains:

```bash
bun run party:deploy
```

## Development

```bash
bun run bot:dev    # Bot (Cloudflare Worker)
bun run a:dev      # Activity (Vite)
bun run party:dev  # Party Server
bun run tunnel     # Cloudflared tunnel for local bot dev
```

For local activity-to-bot proxying in dev, use this in `apps/activity/.dev.vars`:

```bash
BOT_HOST=https://bot-dev.rettend.me
PARTY_HOST=https://civup-party.rettend.partykit.dev
```

## Project

- `apps/bot`: Slash command handler (Cloudflare Worker).
- `apps/activity`: Frontend (SolidJS).
- `apps/party`: Realtime backend (PartyKit).
- `packages/db`: Drizzle ORM & Schema.
