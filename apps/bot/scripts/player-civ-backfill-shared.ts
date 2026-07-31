import type { StatsContext } from '../src/services/stats/context.ts'
import { redDeathLeaderMap } from '@civup/game'

export function buildPlayerCivBackfillSql(statsContext: StatsContext, updatedAt: number): string {
  const statsKey = sqlString(statsContext.statsKey)
  const guildId = sqlString(statsContext.guildId)
  const seasonId = statsContext.seasonPolicy === 'ppl-seasons' ? "coalesce(m.season_id, '')" : "''"
  const eligible = eligibleWhere(guildId)
  const entries = `select
      m.id as match_id,
      ${seasonId} as season_id,
      m.game_mode as game_mode,
      mp.player_id as player_id,
      mp.civ_id as civ_id,
      count(*) as picks,
      sum(case when mp.placement = 1 then 1 else 0 end) as wins
    from matches m
    inner join match_participants mp on mp.match_id = m.id
    where ${eligible}
    group by m.id, ${seasonId}, m.game_mode, mp.player_id, mp.civ_id`

  return `delete from scoped_match_player_civ_stat_contributions where stats_key = ${statsKey};
delete from scoped_player_civ_stats where stats_key = ${statsKey};
with eligible_entries as (${entries})
insert into scoped_player_civ_stats (stats_key, season_id, game_mode, player_id, civ_id, picks, wins, updated_at)
select ${statsKey}, season_id, game_mode, player_id, civ_id, sum(picks), sum(wins), ${Math.round(updatedAt)}
from eligible_entries
group by season_id, game_mode, player_id, civ_id;
with eligible_entries as (${entries})
insert into scoped_match_player_civ_stat_contributions (stats_key, match_id, contributions_json, updated_at)
select
  ${statsKey},
  match_id,
  json(json_group_array(json_object(
    'seasonId', season_id,
    'gameMode', game_mode,
    'playerId', player_id,
    'civId', civ_id,
    'picks', picks,
    'wins', wins
  ))),
  ${Math.round(updatedAt)}
from (select * from eligible_entries order by match_id, season_id, game_mode, player_id, civ_id)
group by match_id;
`
}

export function buildPlayerCivBackfillEstimateQueries(statsContext: StatsContext): Record<string, string> {
  const statsKey = sqlString(statsContext.statsKey)
  const guildId = sqlString(statsContext.guildId)
  const eligible = eligibleWhere(guildId)
  return {
    eligibleMatches: `select count(distinct m.id) as count from matches m inner join match_participants mp on mp.match_id = m.id where ${eligible}`,
    eligibleParticipantRows: `select count(*) as count from matches m inner join match_participants mp on mp.match_id = m.id where ${eligible}`,
    currentContributionRows: `select count(*) as count from scoped_match_player_civ_stat_contributions where stats_key = ${statsKey}`,
    currentAggregateRows: `select count(*) as count from scoped_player_civ_stats where stats_key = ${statsKey}`,
  }
}

export function buildPlayerCivBackfillValidationQueries(statsContext: StatsContext): Record<string, string> {
  const statsKey = sqlString(statsContext.statsKey)
  const guildId = sqlString(statsContext.guildId)
  const eligible = eligibleWhere(guildId)
  return {
    missingContributionMatches: `select count(*) as count from (
      select distinct m.id from matches m
      inner join match_participants mp on mp.match_id = m.id
      left join scoped_match_player_civ_stat_contributions c on c.stats_key = ${statsKey} and c.match_id = m.id
      where ${eligible} and c.match_id is null
    )`,
    orphanContributionMatches: `select count(*) as count from scoped_match_player_civ_stat_contributions c
      where c.stats_key = ${statsKey} and not exists (
        select 1 from matches m inner join match_participants mp on mp.match_id = m.id
        where m.id = c.match_id and ${eligible}
      )`,
    invalidContributionPayloads: `select count(*) as count from scoped_match_player_civ_stat_contributions
      where stats_key = ${statsKey} and (not json_valid(contributions_json) or json_type(contributions_json) != 'array')`,
  }
}

function eligibleWhere(guildId: string): string {
  const redDeathIds = [...redDeathLeaderMap.keys()]
  const excludedLeaders = redDeathIds.length > 0 ? `and mp.civ_id not in (${redDeathIds.map(sqlString).join(', ')})` : ''
  return `m.guild_id = ${guildId}
    and m.status = 'completed'
    and mp.civ_id is not null
    ${excludedLeaders}
    and not exists (
      select 1 from tournament_matches tm
      where tm.match_id = m.id or tm.session_id = m.id
    )
    and case
      when m.draft_data is null then 1
      when not json_valid(m.draft_data) then 1
      when coalesce(json_extract(m.draft_data, '$.redDeath'), 0) = 1 then 0
      when coalesce(json_extract(m.draft_data, '$.civBlitz'), 0) = 1 then 0
      else 1
    end = 1`
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
