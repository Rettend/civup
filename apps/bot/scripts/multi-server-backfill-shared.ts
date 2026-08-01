export interface MultiServerBackfillConfig {
  primaryGuildId: string
  allowedGuildIds: readonly string[]
  cutoff: number
  guildMappings?: ReadonlyMap<string, string>
}

export function buildMultiServerBackfillSql(config: MultiServerBackfillConfig): string {
  validateConfig(config)
  const primary = sqlString(config.primaryGuildId)
  const primaryStatsKey = sqlString(`server:${config.primaryGuildId}`)
  const cutoff = Math.round(config.cutoff)
  const mappedDirectoryGuild = mappedGuildExpression('d.guild_id', config.guildMappings)
  const allowed = sqlStringList(config.allowedGuildIds)
  const statements: string[] = []

  for (const [from, to] of config.guildMappings ?? []) {
    statements.push(`update session_directory set guild_id = ${sqlString(to)} where guild_id = ${sqlString(from)} and created_at <= ${cutoff}`)
    statements.push(`update matches set guild_id = ${sqlString(to)} where guild_id = ${sqlString(from)} and created_at <= ${cutoff}`)
    statements.push(`update match_participants set source_guild_id = ${sqlString(to)} where source_guild_id = ${sqlString(from)} and match_id in (select id from matches where created_at <= ${cutoff})`)
  }

  statements.push(`with ownership_claims as (
    select d.match_id, min(${mappedDirectoryGuild}) as guild_id, count(distinct ${mappedDirectoryGuild}) as guild_count
    from session_directory d
    where d.match_id is not null
    group by d.match_id
  )
  update matches as m
  set guild_id = (select c.guild_id from ownership_claims c where c.match_id = m.id)
  where m.guild_id is null
    and m.created_at <= ${cutoff}
    and exists (
      select 1 from ownership_claims c
      where c.match_id = m.id and c.guild_count = 1 and c.guild_id in (${allowed})
    )`)

  statements.push(`update matches as m
  set guild_id = ${primary}
  where m.guild_id is null
    and m.created_at <= ${cutoff}
    and not exists (select 1 from session_directory d where d.match_id = m.id)`)

  statements.push(`insert into scoped_player_ratings (
    stats_key, player_id, mode, mu, sigma, public_rating, games_played, wins, imported_games, effective_games,
    wins_vs_tier_1, wins_vs_tier_2_plus, effective_wins_vs_tier_1, effective_wins_vs_tier_2_plus,
    last_played_at, updated_at
  )
  select
    ${primaryStatsKey}, player_id, mode, mu, sigma, public_rating, games_played, wins, imported_games, effective_games,
    wins_vs_tier_1, wins_vs_tier_2_plus, effective_wins_vs_tier_1, effective_wins_vs_tier_2_plus,
    last_played_at, updated_at
  from player_ratings where true
  on conflict(stats_key, player_id, mode) do update set
    mu = excluded.mu,
    sigma = excluded.sigma,
    public_rating = excluded.public_rating,
    games_played = excluded.games_played,
    wins = excluded.wins,
    imported_games = excluded.imported_games,
    effective_games = excluded.effective_games,
    wins_vs_tier_1 = excluded.wins_vs_tier_1,
    wins_vs_tier_2_plus = excluded.wins_vs_tier_2_plus,
    effective_wins_vs_tier_1 = excluded.effective_wins_vs_tier_1,
    effective_wins_vs_tier_2_plus = excluded.effective_wins_vs_tier_2_plus,
    last_played_at = excluded.last_played_at,
    updated_at = excluded.updated_at`)

  statements.push(`insert into scoped_player_rating_events (
    stats_key, match_id, player_id, mode, game_mode, rating_before_mu, rating_before_sigma,
    rating_after_mu, rating_after_sigma, public_rating_before, public_rating_after, games_delta, wins_delta, imported_games_delta,
    effective_games_delta, wins_vs_tier_1_delta, wins_vs_tier_2_plus_delta,
    effective_wins_vs_tier_1_delta, effective_wins_vs_tier_2_plus_delta,
    match_created_at, match_completed_at, updated_at
  )
  select
    ${primaryStatsKey}, match_id, player_id, mode, game_mode, rating_before_mu, rating_before_sigma,
    rating_after_mu, rating_after_sigma, public_rating_before, public_rating_after, games_delta, wins_delta, imported_games_delta,
    effective_games_delta, wins_vs_tier_1_delta, wins_vs_tier_2_plus_delta,
    effective_wins_vs_tier_1_delta, effective_wins_vs_tier_2_plus_delta,
    match_created_at, match_completed_at, updated_at
  from player_rating_events where true
  on conflict(stats_key, match_id, player_id, mode) do update set
    game_mode = excluded.game_mode,
    rating_before_mu = excluded.rating_before_mu,
    rating_before_sigma = excluded.rating_before_sigma,
    rating_after_mu = excluded.rating_after_mu,
    rating_after_sigma = excluded.rating_after_sigma,
    public_rating_before = excluded.public_rating_before,
    public_rating_after = excluded.public_rating_after,
    games_delta = excluded.games_delta,
    wins_delta = excluded.wins_delta,
    imported_games_delta = excluded.imported_games_delta,
    effective_games_delta = excluded.effective_games_delta,
    wins_vs_tier_1_delta = excluded.wins_vs_tier_1_delta,
    wins_vs_tier_2_plus_delta = excluded.wins_vs_tier_2_plus_delta,
    effective_wins_vs_tier_1_delta = excluded.effective_wins_vs_tier_1_delta,
    effective_wins_vs_tier_2_plus_delta = excluded.effective_wins_vs_tier_2_plus_delta,
    match_created_at = excluded.match_created_at,
    match_completed_at = excluded.match_completed_at,
    updated_at = excluded.updated_at`)

  statements.push(`update matches
  set draft_completed_at = cast(json_extract(draft_data, '$.completedAt') as integer)
  where draft_completed_at is null
    and created_at <= ${cutoff}
    and json_valid(draft_data)
    and json_type(draft_data, '$.completedAt') in ('integer', 'real')`)

  statements.push(`insert into match_repairs (
    id, idempotency_key, session_id, match_id, result_revision, repair_type, status,
    attempts, next_attempt_at, last_error, created_at, updated_at
  )
  select
    'migration-cancelled-at:' || m.id,
    'migration-cancelled-at:' || m.id,
    null,
    m.id,
    m.result_revision,
    'migration-cancelled-at-fallback',
    'completed',
    0,
    0,
    'No reliable historical cancellation timestamp; retained from migration cutoff.',
    ${cutoff},
    ${cutoff}
  from matches m
  where m.status = 'cancelled'
    and m.cancelled_at is null
    and m.created_at <= ${cutoff}
    and m.completed_at is null
    and not exists (
      select 1 from session_directory d
      where d.match_id = m.id and d.closed_at is not null
    )
  on conflict(idempotency_key) do nothing`)

  statements.push(`update matches as m
  set cancelled_at = coalesce(
    m.completed_at,
    (select max(d.closed_at) from session_directory d where d.match_id = m.id),
    ${cutoff}
  )
  where m.status = 'cancelled'
    and m.cancelled_at is null
    and m.created_at <= ${cutoff}`)

  statements.push(`update matches as m
  set result_revision = 1
  where m.result_revision = 0
    and m.created_at <= ${cutoff}
    and (
      m.status in ('completed', 'cancelled')
      or exists (select 1 from match_participants mp where mp.match_id = m.id and mp.placement is not null)
      or exists (select 1 from player_rating_events e where e.match_id = m.id)
      or exists (select 1 from scoped_player_rating_events e where e.match_id = m.id)
    )`)

  statements.push(`update match_participants as mp
  set source_guild_id = ${primary}, source_kind = 'legacy_primary'
  where mp.match_id in (
    select m.id from matches m
    where m.guild_id = ${primary} and m.created_at <= ${cutoff}
  )
    and mp.source_guild_id is null
    and mp.source_kind is null`)

  statements.push(`update match_participants as mp
  set source_kind = 'legacy_primary'
  where mp.source_guild_id = ${primary}
    and mp.source_kind is null
    and mp.match_id in (select m.id from matches m where m.created_at <= ${cutoff})`)

  return `${statements.map(statement => `${statement.trim()};`).join('\n')}\n`
}

export function buildMultiServerBackfillPreviewQueries(config: MultiServerBackfillConfig): Record<string, string> {
  validateConfig(config)
  const primary = sqlString(config.primaryGuildId)
  const primaryStatsKey = sqlString(`server:${config.primaryGuildId}`)
  const cutoff = Math.round(config.cutoff)
  const mappedDirectoryGuild = mappedGuildExpression('d.guild_id', config.guildMappings)
  const allowed = sqlStringList(config.allowedGuildIds)
  const conflict = `exists (
    select 1 from session_directory d
    where d.match_id = m.id
    group by d.match_id
    having count(distinct ${mappedDirectoryGuild}) > 1
  )`
  return {
    ownerFromDirectory: `select count(*) as count from matches m where m.guild_id is null and m.created_at <= ${cutoff} and exists (
      select 1 from session_directory d where d.match_id = m.id
      group by d.match_id having count(distinct ${mappedDirectoryGuild}) = 1 and min(${mappedDirectoryGuild}) in (${allowed})
    )`,
    ownerPrimaryFallback: `select count(*) as count from matches m where m.guild_id is null and m.created_at <= ${cutoff} and not exists (select 1 from session_directory d where d.match_id = m.id)`,
    conflictingDirectoryOwners: `select count(*) as count from matches m where m.created_at <= ${cutoff} and ${conflict}`,
    participantLegacyPrimary: `select count(*) as count from match_participants mp inner join matches m on m.id = mp.match_id where m.created_at <= ${cutoff} and coalesce(m.guild_id, ${primary}) = ${primary} and (mp.source_guild_id is null or mp.source_kind is null)`,
    draftCompletedFromJson: `select count(*) as count from matches m where m.draft_completed_at is null and m.created_at <= ${cutoff} and json_valid(m.draft_data) and json_type(m.draft_data, '$.completedAt') in ('integer', 'real')`,
    cancelledTimestampFallback: `select count(*) as count from matches m where m.status = 'cancelled' and m.cancelled_at is null and m.created_at <= ${cutoff} and m.completed_at is null and not exists (select 1 from session_directory d where d.match_id = m.id and d.closed_at is not null)`,
    resultRevision: `select count(*) as count from matches m where m.result_revision = 0 and m.created_at <= ${cutoff} and (m.status in ('completed', 'cancelled') or exists (select 1 from match_participants mp where mp.match_id = m.id and mp.placement is not null) or exists (select 1 from player_rating_events e where e.match_id = m.id) or exists (select 1 from scoped_player_rating_events e where e.match_id = m.id))`,
    primaryRatingRows: `select count(*) as count from player_ratings r where not exists (select 1 from scoped_player_ratings s where s.stats_key = ${primaryStatsKey} and s.player_id = r.player_id and s.mode = r.mode)`,
    primaryRatingEventRows: `select count(*) as count from player_rating_events e where not exists (select 1 from scoped_player_rating_events s where s.stats_key = ${primaryStatsKey} and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode)`,
  }
}

export function buildMultiServerValidationQueries(config: MultiServerBackfillConfig): Record<string, string> {
  validateConfig(config)
  const allowed = sqlStringList(config.allowedGuildIds)
  const primaryStatsKey = sqlString(`server:${config.primaryGuildId}`)
  const mappedDirectoryGuild = mappedGuildExpression('d.guild_id', config.guildMappings)
  return {
    matchesMissingOwner: 'select count(*) as count from matches where guild_id is null',
    matchesWithUnapprovedOwner: `select count(*) as count from matches where guild_id is not null and guild_id not in (${allowed})`,
    directoryWithUnapprovedOwner: `select count(*) as count from session_directory where guild_id not in (${allowed})`,
    participantsMissingSourceGuild: 'select count(*) as count from match_participants where source_guild_id is null',
    participantsMissingSourceKind: 'select count(*) as count from match_participants where source_kind is null',
    cancelledMatchesMissingTimestamp: "select count(*) as count from matches where status = 'cancelled' and cancelled_at is null",
    terminalMatchesMissingRevision: "select count(*) as count from matches where status in ('completed', 'cancelled') and result_revision = 0",
    conflictingDirectoryOwners: `select count(*) as count from (select d.match_id from session_directory d where d.match_id is not null group by d.match_id having count(distinct ${mappedDirectoryGuild}) > 1)`,
    scopedRatingEventsWithWrongOwner: `select count(*) as count from scoped_player_rating_events e inner join matches m on m.id = e.match_id where m.guild_id is null or e.stats_key != 'server:' || m.guild_id`,
    primaryRatingsMissingScopedRows: `select count(*) as count from player_ratings r where not exists (select 1 from scoped_player_ratings s where s.stats_key = ${primaryStatsKey} and s.player_id = r.player_id and s.mode = r.mode)`,
    primaryRatingEventsMissingScopedRows: `select count(*) as count from player_rating_events e where not exists (select 1 from scoped_player_rating_events s where s.stats_key = ${primaryStatsKey} and s.match_id = e.match_id and s.player_id = e.player_id and s.mode = e.mode)`,
  }
}

function mappedGuildExpression(column: string, mappings: ReadonlyMap<string, string> | undefined): string {
  if (!mappings || mappings.size === 0) return column
  return `case ${[...mappings].map(([from, to]) => `when ${column} = ${sqlString(from)} then ${sqlString(to)}`).join(' ')} else ${column} end`
}

function validateConfig(config: MultiServerBackfillConfig): void {
  if (!/^\d{17,20}$/.test(config.primaryGuildId)) throw new Error('Primary server ID is invalid')
  if (!Number.isSafeInteger(config.cutoff) || config.cutoff <= 0) throw new Error('Migration cutoff must be a positive millisecond timestamp')
  if (!config.allowedGuildIds.includes(config.primaryGuildId)) throw new Error('Allowed server IDs must include the primary server')
  for (const guildId of config.allowedGuildIds) if (!/^\d{17,20}$/.test(guildId)) throw new Error(`Allowed server ID is invalid: ${guildId}`)
  for (const [from, to] of config.guildMappings ?? []) {
    if (!/^\d{17,20}$/.test(from) || !config.allowedGuildIds.includes(to)) throw new Error(`Guild mapping is invalid: ${from}:${to}`)
  }
}

function sqlStringList(values: readonly string[]): string {
  return [...new Set(values)].map(sqlString).join(', ')
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
