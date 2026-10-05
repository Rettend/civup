# Player-facing wording

Write UI text, Discord replies, and API errors for someone who plays Civ and has never read this codebase. This includes messages returned by services and displayed by their callers.

- Say what happened using the player's words: match, result, player, team, leader, lobby, rating, season.
- Keep each message about the action the person just took. Do not combine reporting, corrections, and cancellations into one error.
- Give a next step only when it is useful and actually works. Do not tell players to retry a disabled feature or ask them to fix server settings.
- Keep implementation details in logs. Terms such as “season-isolated”, “seed-aware”, “projection”, “rating scope”, and “SessionDO binding” do not explain a problem to a player.
- Do not display arbitrary exception messages. Log unexpected errors with context and show a short message about the failed action. Preserve specific, deliberately written validation messages.
- Check the actual cause before rewriting an error. Fix a misleading validation path rather than giving the same wrong explanation in simpler words. Check match status before season permissions; a cancelled match is not a season configuration problem.
- Do not claim “nothing changed”, “failed safely”, or “no ratings were changed” unless the code guarantees it and the person needs to know. If part of an action succeeded, explain what is saved and what remains to do.
- Prefer direct instructions over descriptions of requirements: “Choose a leader for every player,” not “Leader assignments are required for all participants.”

Examples:

- “This match was cancelled. You cannot report a result for it.”
- “This match is from a past season. Its result can no longer be changed.”
- “The players changed. Check the player list and report the result again.”

Before finishing a change, read every new or changed user-facing message in the context where it appears. Could a player understand it without an explanation? Run `bun run check:copy`; it catches known jargon, but does not replace reading the wording.

# Tooling

- Use `bun run test` for the whole workspace. Activity tests use Vite+/Vitest and the Solid compiler; bot and package tests use Bun. Do not run Activity tests with `bun test`.
- `bun run check` includes copy, workspace, and tooling typechecks. Vite+ lint checks are read-only; `lint:fix` and `format` change files.
- Run Vite+ and Cloudflare CLIs under Node 24. Bun remains the package manager and script runner.
- Resolve Cloudflare accounts and resources through `config/cloudflare-targets.ts`. PPL settings stay in the git-ignored local JSON file. Choose local or remote storage separately and keep local tools on the same explicit persistence directory.
