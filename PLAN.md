# Deployment Cleanup Plan

## Answers

### R2 and large autosave files

Yes. We can split every autosave into 80 MiB parts and upload those parts through the existing `AUTOSAVE_UPLOADS` R2 Worker binding. A 100 MiB save becomes two parts. This uses `createMultipartUpload`, `uploadPart`, and `complete` from the R2 binding and does not need the S3-compatible API.

We can remove all of these:

```text
R2_ACCOUNT_ID
AUTOSAVE_UPLOAD_BUCKET
R2_UPLOAD_ACCESS_KEY_ID
R2_UPLOAD_SECRET_ACCESS_KEY
```

We can also remove the presigned URL code, SigV4 code, `/r2-upload` URL handling, and the old direct upload route. There is no need for compatibility code because autosave upload has not been released for real use.

An R2 binding still needs a bucket name in Wrangler:

```jsonc
{
  "r2_buckets": [
    {
      "binding": "AUTOSAVE_UPLOADS",
      "bucket_name": "civup-autosave-uploads"
    }
  ]
}
```

Local Wrangler can create local R2 storage automatically. A production bucket is not created by a normal `wrangler deploy`; it must be created once:

```bash
bunx wrangler r2 bucket create civup-autosave-uploads
```

No R2 API token or S3 credentials are needed after that. The Worker receives access through the binding.

R2 will remain optional in the application code. If `AUTOSAVE_UPLOADS` is not bound, normal bot and Activity features continue working and upload requests return a clear "Saved game uploads are not configured" response. `/admin health` reports uploads as disabled instead of treating that as a broken installation. Self-hosters who do not want uploads can omit the `r2_buckets` block.

### `CIVUP_SECRET`

`bunx @rttnd/gau secret` is suitable. It generates a long, random base64url value. CivUp uses the configured string as an HMAC-SHA-256 key, so the value after `AUTH_SECRET=` can be used as `CIVUP_SECRET` in both Workers.

The README will show:

```bash
bunx @rttnd/gau secret
```

The same generated value must be uploaded to the bot and Activity Workers.

### Health output

`/admin health` will be short and practical. It will list successful checks, warnings, and failures with a useful reason. It will not explain implementation limitations or discuss what it cannot edit.

Example:

```text
CivUp health
OK Discord application and server
OK Commands
OK D1 and KV
OK Activity
WARN Saved game uploads are disabled
```

## Goals

- Keep the bot and Activity as separate Workers.
- Keep the existing deployment command names and deployment order.
- Add no new steady-state storage or API reads.
- Reduce required environment variables and secrets.
- Make R2 uploads optional and remove R2 credentials.
- Add a small, on-demand `/admin health` command.
- Replace the incomplete README setup instructions with a short, accurate guide.
- Do not add deploy buttons or runtime configuration storage.

## Target Configuration

### Bot secrets

```text
DISCORD_TOKEN
CIVUP_SECRET
```

### Activity secrets

```text
DISCORD_CLIENT_SECRET
CIVUP_SECRET
```

Local builds read `DISCORD_CLIENT_ID` from `.dev.vars`. Production builds read it from the selected Activity Wrangler JSON file. Vite exposes the selected value to browser code as `import.meta.env.VITE_DISCORD_CLIENT_ID`.

### Public Wrangler configuration

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_CLIENT_ID
ALLOWED_DISCORD_GUILD_ID
ACTIVITY_PUBLIC_ORIGIN
```

The application ID and client ID are the same Discord application ID. The guild ID and Activity origin remain in both Worker configs because both Workers use them synchronously.

### Optional binding

```text
AUTOSAVE_UPLOADS
```

### Removed configuration

```text
BOT_HOST
VITE_ACTIVITY_HOST
R2_ACCOUNT_ID
AUTOSAVE_UPLOAD_BUCKET
R2_UPLOAD_ACCESS_KEY_ID
R2_UPLOAD_SECRET_ACCESS_KEY
ENABLED_GAME_MODES
```

`ENABLE_DEBUG_LOBBY_FILL` becomes local-only and must also be running on a development hostname before it has any effect.

## Implementation

### 1. Simplify Worker routing

- Remove `BOT_HOST` from source, examples, and Wrangler configs.
- Require the `BOT` service binding in production Activity requests.
- Return `503` if the production service binding is missing.
- Use `http://127.0.0.1:8787` only during recognized local development.
- Use the incoming request URL for bot development checks.
- Remove the unused `BOT_HOST` declaration from the session runtime.
- Add tests for service-binding routing, local fallback, and production failure.

### 2. Simplify Activity build configuration

- Remove `VITE_ACTIVITY_HOST` and its Vite definition.
- Use `window.location.host` for client socket routing.
- Use Vite development mode and the current hostname for development checks.
- Map `DISCORD_CLIENT_ID` from the selected Activity Wrangler JSON file to `import.meta.env.VITE_DISCORD_CLIENT_ID` in Vite config.
- Keep `.dev.vars` as the fallback for local development with a separate Discord app.
- Select the PPL Wrangler file with Cloudflare's `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`; production never falls back to `.dev.vars`.
- Build with `vite build` and deploy directly with the normal Wrangler config instead of generating isolated config files.
- Remove the target enum, JSONC parser, deployment preflight, and Activity build wrappers.

### 3. Make autosave upload multipart-only

- Use the R2 binding multipart API for every autosave upload.
- Keep the current 80 MiB part size so each Worker request stays below the request body limit.
- Keep the current overall upload size limit unless testing shows it should change.
- Remove the single-file presigned upload mode.
- Remove the old streaming direct-upload route.
- Remove all SigV4 and presigned URL helpers.
- Remove `/r2-upload` rewriting from the Activity client.
- Remove all four R2 S3 configuration values from types, examples, configs, and docs.
- Abort multipart uploads and remove pending D1 rows when initialization, part upload, or completion fails.
- Keep the existing friendly `503` behavior when the R2 binding is absent.
- Make the client show a short "Saved game uploads are not configured" message for that response.
- Remove `remote: true` so local development uses local R2 storage.
- Add an optional production R2 bucket creation command.

Focused tests will cover:

- Files below, at, and above the 80 MiB part boundary.
- A save around 100 MiB becoming two parts.
- Multipart initialization, part upload, completion, and abort.
- Authentication and upload ownership checks.
- D1 and R2 cleanup after failures.
- Missing optional R2 binding.
- Activity-to-bot body streaming and metadata.

### 4. Separate public values from secrets

- Put `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` in bot Wrangler vars.
- Keep `DISCORD_CLIENT_ID` in Activity Wrangler vars.
- Keep guild ID and Activity origin as public vars in both Worker configs.
- Reduce bot production secrets to `DISCORD_TOKEN` and `CIVUP_SECRET`.
- Reduce Activity production secrets to `DISCORD_CLIENT_SECRET` and `CIVUP_SECRET`.
- Keep local public overrides in `.dev.vars` for separate development Discord apps.
- Update `register.ts` to read application and guild IDs from its selected environment file.
- Keep the public registration inputs in `.prod.secrets` and `.ppl.secrets` alongside the actual bot secrets.
- Require guild registration so bulk registration cannot replace Discord's global Activity Launch command.
- Keep checked public-key placeholders in the Wrangler files and document replacing them before deployment instead of adding validation wrappers.
- Update `.gitignore` for PPL secret files.
- Document explicit cleanup of old deployed variables and secrets after the test deployment passes.

Only Vite reads the Activity Wrangler JSON file at build time. Runtime code does not parse deployment config.

### 5. Remove unused Discord OAuth scopes

- Remove `rpc.voice.read` because CivUp does not use Discord voice APIs.
- Remove `guilds` because membership verification uses `guilds.members.read`.
- Keep `identify` and `guilds.members.read`.

### 6. Add `/admin health`

Add an administrator-only, ephemeral `/admin health` subcommand. Checks run concurrently with short timeouts and only when the command is used.

Checks:

- Required bot configuration is present and correctly formatted.
- Discord bot token works.
- Discord application ID and public key match the current application.
- The interactions endpoint matches the current bot Worker.
- The bot can access the configured Discord server.
- Expected guild commands are registered.
- D1 responds to a small read-only query.
- KV responds to a harmless read.
- R2 responds to a one-object list when configured.
- Activity public origin responds.
- Browser Access configuration and preference role are valid when enabled.

R2 absence is a warning that saved-game uploads are disabled, not a failure. Results use short `OK`, `WARN`, and `FAIL` lines with the actual failure reason. Secret values are never shown.

### 7. Rewrite setup documentation

Keep README prose short, casual, and direct.

Discord setup will include:

- Create separate development and production Discord apps.
- Copy the application ID, public key, bot token, and client secret.
- Enable Guild Install with `applications.commands` and `bot`.
- Grant View Channels, Send Messages, Embed Links, Attach Files, and Manage Roles.
- Put the CivUp bot role above roles it manages.
- Enable Activities and Web support.
- Keep Discord's global Launch command.
- Add the Activity origin and browser callback OAuth redirects.
- Add the root Activity URL mapping.
- No privileged Gateway intents are needed.

Local setup will include:

- Install dependencies and copy the reduced example files.
- Generate `CIVUP_SECRET` with GAU and put the same value in both Workers.
- Create and configure the `civup-dev` tunnel.
- Apply local D1 migrations.
- Start the bot, Activity, and tunnel before saving the Discord interactions endpoint.
- Install the app before registering guild commands.
- Note that local D1, KV, R2, and Durable Objects do not need remote resources.
- Test `/ping`, `/admin health`, and an Activity launch.

Production setup will include:

- Select the Cloudflare account before creating resources.
- Create D1 and KV.
- Optionally create R2 and keep or remove the R2 binding.
- Explain that Durable Objects are created by Worker deployment.
- Fill public Wrangler values.
- Upload the reduced Worker secrets.
- Deploy the bot before the Activity.
- Add Discord endpoints, redirects, and the root URL mapping after URLs exist.
- Install the app before first command registration.
- Use `deploy:prod` for the first deployment and `deploy:prod:full` later.
- Enable Browser Access only if wanted.
- Include a short smoke-test checklist.
- Correct the local cron examples.

Update `PPL.md` anywhere the removed vars files, R2 credentials, or build commands are referenced.

## Verification Before Handoff

- Run focused bot upload tests.
- Run focused Activity proxy and configuration tests.
- Run `/admin health` unit tests for success, warnings, failures, and timeouts.
- Run the full bot and Activity test suites.
- Run `bun run check`.
- Build the standard production Activity target without deploying.
- Build the PPL Activity target without deploying.
- Run the bot capacity test and review its snapshot and assumptions.
- Do not start development servers or deploy to any environment.

## Manual Test Checklist

### Local development

- Start the normal local stack.
- Save and verify the Discord interactions endpoint.
- Register guild commands.
- Run `/ping`.
- Run `/admin health`.
- Launch the Activity and complete OAuth.
- Upload an autosave larger than 100 MiB and confirm multipart completion.
- Confirm the app still works with the R2 binding removed.

### Test-server production

- Add public Discord values to Wrangler config.
- Upload the reduced secrets with the same `CIVUP_SECRET` in both Workers.
- Create the R2 bucket if uploads will be tested.
- Deploy with the existing bot-then-Activity flow.
- Verify Discord interactions and guild commands.
- Run `/ping` and `/admin health`.
- Launch the Activity and test Browser Access if enabled.
- Upload and download a large autosave.
- Remove obsolete Worker vars and secrets.
- Revoke the old R2 API token after confirming no code uses it.
- Remove the old `/r2-upload` Discord URL mapping.
