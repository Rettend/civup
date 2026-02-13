# CivUp

Champ select for Civ VI that's a Discord Activity, and a fully featured Discord Bot

[**Demo video**](./civup_demo.mp4)

## Deployment

### Dependencies

- **Bun**: Package manager & runtime.
- **Wrangler**: Cloudflare Workers CLI.
- **PartyKit**: WebSocket server CLI.

### Environment

1. **Secrets**: Set via `wrangler secret put` (Bot/Activity) & `bunx partykit env add` (Party).
2. **Local**: Copy `.dev.vars.example` to `.dev.vars` in `apps/bot` & `apps/activity`.

### Database

```bash
bun run db:generate   # Generate migrations
bun run bot:r:migrate # Apply to production D1
```

### Deploy

#### Discord Bot

```bash
bun run bot:deploy
bun run bot:register  # Register slash commands
```

#### Activity UI

```bash
bun run a:deploy
```

#### PartyKit Server

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

## Project

- `apps/bot`: Slash command handler (Cloudflare Worker).
- `apps/activity`: Frontend (SolidJS).
- `apps/party`: Realtime backend (PartyKit).
- `packages/db`: Drizzle ORM & Schema.
