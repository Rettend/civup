-- Correct historical per-match ban submissions and their visible aggregate deltas.
WITH excess AS (
  SELECT c.mode_scope, json_extract(e.value, '$.civId') AS civ_id,
    sum(json_extract(e.value, '$.bans') - 1) AS duplicates
  FROM match_civ_stat_contributions c,
    json_each(CASE WHEN json_type(c.contributions_json) = 'array'
      THEN c.contributions_json ELSE json_extract(c.contributions_json, '$.entries') END) e
  WHERE c.visible = 1 AND c.completed_match_count > 0 AND json_extract(e.value, '$.bans') > 1
  GROUP BY c.mode_scope, civ_id
)
UPDATE civ_stats SET bans = max(0, bans - coalesce((
  SELECT duplicates FROM excess WHERE excess.mode_scope = civ_stats.mode_scope AND excess.civ_id = civ_stats.civ_id
), 0))
WHERE EXISTS (SELECT 1 FROM excess WHERE excess.mode_scope = civ_stats.mode_scope AND excess.civ_id = civ_stats.civ_id);

UPDATE match_civ_stat_contributions
SET contributions_json = CASE WHEN json_type(contributions_json) = 'array' THEN (
  SELECT json_group_array(json_set(e.value, '$.bans', min(1, coalesce(json_extract(e.value, '$.bans'), 0))))
  FROM json_each(contributions_json) e
) ELSE json_set(contributions_json, '$.entries', json((
  SELECT json_group_array(json_set(e.value, '$.bans', min(1, coalesce(json_extract(e.value, '$.bans'), 0))))
  FROM json_each(contributions_json, '$.entries') e
))) END
WHERE EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_type(contributions_json) = 'array'
    THEN contributions_json ELSE json_extract(contributions_json, '$.entries') END) e
  WHERE json_extract(e.value, '$.bans') > 1
);
