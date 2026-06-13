/* eslint-disable no-console */
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { redDeathLeaderMap } from '@civup/game'
import { Database } from 'bun:sqlite'

const SEED_PREFIX = 'dev-leaders'
const RETTEND_ID = '361534796830081024'
const RETTEND_NAME = 'Rettend'
const BOT_COUNT = 40
const BASE_TIME = Date.now() - 14 * 86_400_000

type GameMode = '1v1' | '2v2' | '3v3' | 'ffa'
type RatingMode = 'duel' | 'duo' | 'squad' | 'ffa'

interface SeedParticipant {
  playerId: string
  team: number | null
  placement: number
  civId: string
  ratingBeforeMu?: number | null
  ratingBeforeSigma?: number | null
  ratingAfterMu?: number | null
  ratingAfterSigma?: number | null
}

interface SeedMatch {
  id: string
  gameMode: GameMode
  seasonId: string | null
  createdAt: number
  completedAt: number
  participants: SeedParticipant[]
}

const botLeaders = [
  'rome-trajan',
  'china-yongle',
  'babylon-hammurabi',
  'japan-hojo-tokimune',
  'france-catherine-de-medici-magnificence',
  'inca-pachacuti',
  'korea-seondeok',
  'mali-sundiata-keita',
  'germany-ludwig-ii',
  'byzantium-theodora',
  'cree-poundmaker',
  'maori-kupe',
  'persia-cyrus',
  'america-abraham-lincoln',
  'indonesia-gitarja',
  'england-victoria-age-of-steam',
  'egypt-cleopatra-egyptian',
] as const

const db = new Database(resolveLocalD1SqlitePath())
db.run('PRAGMA foreign_keys = ON')

try {
  const seasonId = selectDisplaySeasonId(db)
  const matches = buildSeedMatches(seasonId)

  db.exec('begin transaction')
  cleanPreviousSeed(db)
  seedPlayers(db)
  insertMatches(db, matches)
  seedRettendRatings(db, summarizeRettendRatings(matches), Math.max(...matches.map(match => match.completedAt)))
  rebuildPlayerCivStats(db, Date.now())
  db.exec('commit')

  const summary = summarizeRettendRatings(matches)
  console.log(`Seeded ${matches.length} dev leader matches with Rettend in every game.`)
  console.log(`Season scope: ${seasonId ?? 'none'}`)
  for (const [mode, stats] of Object.entries(summary)) {
    console.log(`${mode}: ${stats.games}g, ${stats.wins} wins`)
  }
}
catch (error) {
  db.exec('rollback')
  throw error
}
finally {
  db.close()
}

function buildSeedMatches(seasonId: string | null): SeedMatch[] {
  const matches: SeedMatch[] = []
  let matchIndex = 0
  let botCursor = 0
  let botLeaderCursor = 0
  let yongleOpponentLosses = 8
  let trajanOpponentWins = 10

  const nextBotId = () => {
    const id = botId(botCursor % BOT_COUNT)
    botCursor += 1
    return id
  }

  const nextBotLeader = (avoid?: string) => {
    for (let tries = 0; tries < botLeaders.length; tries += 1) {
      const leader = botLeaders[botLeaderCursor % botLeaders.length]
      botLeaderCursor += 1
      if (leader !== avoid) return leader
    }
    return 'rome-trajan'
  }

  const nextDuelOpponentLeader = (rettendWon: boolean, rettendLeader: string) => {
    if (rettendWon && yongleOpponentLosses > 0 && rettendLeader !== 'china-yongle') {
      yongleOpponentLosses -= 1
      return 'china-yongle'
    }
    if (!rettendWon && trajanOpponentWins > 0 && rettendLeader !== 'rome-trajan') {
      trajanOpponentWins -= 1
      return 'rome-trajan'
    }
    return nextBotLeader(rettendLeader)
  }

  const createMatch = (gameMode: GameMode, participants: SeedParticipant[]) => {
    matchIndex += 1
    const completedAt = BASE_TIME + matchIndex * 45 * 60_000
    matches.push({
      id: `${SEED_PREFIX}-${String(matchIndex).padStart(3, '0')}`,
      gameMode,
      seasonId,
      createdAt: completedAt - 20 * 60_000,
      completedAt,
      participants,
    })
  }

  const addDuelSeries = (civId: string, games: number, wins: number) => {
    for (let index = 0; index < games; index += 1) {
      const didWin = index < wins
      createMatch('1v1', [
        rettendParticipant({ team: 0, placement: didWin ? 1 : 2, civId, matchIndex }),
        { playerId: nextBotId(), team: 1, placement: didWin ? 2 : 1, civId: nextDuelOpponentLeader(didWin, civId) },
      ])
    }
  }

  const addTeamSeries = (gameMode: '2v2' | '3v3', civId: string, games: number, wins: number) => {
    const teamSize = gameMode === '2v2' ? 2 : 3
    for (let index = 0; index < games; index += 1) {
      const didWin = index < wins
      const participants: SeedParticipant[] = [
        rettendParticipant({ team: 0, placement: didWin ? 1 : 2, civId, matchIndex }),
      ]

      for (let teammate = 1; teammate < teamSize; teammate += 1) {
        participants.push({ playerId: nextBotId(), team: 0, placement: didWin ? 1 : 2, civId: nextBotLeader(civId) })
      }
      for (let opponent = 0; opponent < teamSize; opponent += 1) {
        participants.push({ playerId: nextBotId(), team: 1, placement: didWin ? 2 : 1, civId: nextBotLeader(civId) })
      }
      createMatch(gameMode, participants)
    }
  }

  const addFfaSeries = (civId: string, games: number, firsts: number) => {
    for (let index = 0; index < games; index += 1) {
      const didWin = index < firsts
      const participants: SeedParticipant[] = [
        rettendParticipant({ team: null, placement: didWin ? 1 : 3, civId, matchIndex }),
      ]
      for (let seat = 1; seat < 8; seat += 1) {
        participants.push({
          playerId: nextBotId(),
          team: null,
          placement: didWin ? seat + 1 : seat === 1 ? 1 : seat + 1,
          civId: nextBotLeader(civId),
        })
      }
      createMatch('ffa', participants)
    }
  }

  addDuelSeries('inca-pachacuti', 12, 8)
  addDuelSeries('korea-seondeok', 9, 7)
  addDuelSeries('babylon-hammurabi', 8, 3)
  addDuelSeries('japan-hojo-tokimune', 6, 6)
  addDuelSeries('rome-trajan', 5, 1)
  addDuelSeries('china-yongle', 4, 4)
  addDuelSeries('france-catherine-de-medici-magnificence', 4, 3)

  addTeamSeries('2v2', 'maori-kupe', 8, 5)
  addTeamSeries('2v2', 'persia-cyrus', 6, 2)
  addTeamSeries('2v2', 'america-abraham-lincoln', 6, 5)

  addTeamSeries('3v3', 'byzantium-theodora', 6, 5)
  addTeamSeries('3v3', 'germany-ludwig-ii', 5, 2)
  addTeamSeries('3v3', 'cree-poundmaker', 4, 4)

  addFfaSeries('indonesia-gitarja', 8, 3)
  addFfaSeries('england-victoria-age-of-steam', 6, 4)
  addFfaSeries('egypt-cleopatra-egyptian', 5, 1)

  return matches
}

function rettendParticipant(input: { team: number | null, placement: number, civId: string, matchIndex: number }): SeedParticipant {
  const beforeMu = 25 + (input.matchIndex % 16) * 0.08
  const afterMu = beforeMu + (input.placement === 1 ? 0.35 : -0.22)
  return {
    playerId: RETTEND_ID,
    team: input.team,
    placement: input.placement,
    civId: input.civId,
    ratingBeforeMu: beforeMu,
    ratingBeforeSigma: 8,
    ratingAfterMu: afterMu,
    ratingAfterSigma: 7.95,
  }
}

function seedPlayers(db: Database): void {
  db.query(`insert into players (id, display_name, avatar_url, created_at)
    values (?1, ?2, null, ?3)
    on conflict(id) do update set display_name = excluded.display_name`).run(RETTEND_ID, RETTEND_NAME, Date.now())

  const insert = db.query(`insert into players (id, display_name, avatar_url, created_at)
    values (?1, ?2, null, ?3)
    on conflict(id) do update set display_name = excluded.display_name`)
  for (let index = 0; index < BOT_COUNT; index += 1) {
    insert.run(botId(index), `Dev Leader Bot ${index + 1}`, Date.now())
  }
}

function insertMatches(db: Database, matches: SeedMatch[]): void {
  const insertMatch = db.query(`insert into matches (id, game_mode, status, is_old, season_id, draft_data, created_at, completed_at)
    values (?1, ?2, 'completed', 0, ?3, null, ?4, ?5)`)
  const insertParticipant = db.query(`insert into match_participants (
    match_id,
    player_id,
    team,
    civ_id,
    placement,
    rating_before_mu,
    rating_before_sigma,
    rating_after_mu,
    rating_after_sigma
  ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)

  for (const match of matches) {
    insertMatch.run(match.id, match.gameMode, match.seasonId, match.createdAt, match.completedAt)
    for (const participant of match.participants) {
      insertParticipant.run(
        match.id,
        participant.playerId,
        participant.team,
        participant.civId,
        participant.placement,
        participant.ratingBeforeMu ?? null,
        participant.ratingBeforeSigma ?? null,
        participant.ratingAfterMu ?? null,
        participant.ratingAfterSigma ?? null,
      )
    }
  }
}

function cleanPreviousSeed(db: Database): void {
  const like = `${SEED_PREFIX}-%`
  db.query('delete from player_civ_stats').run()
  db.query('delete from match_player_civ_stat_contributions').run()
  db.query('delete from player_rating_events where match_id like ?1').run(like)
  db.query('delete from match_bans where match_id like ?1').run(like)
  db.query('delete from match_participants where match_id like ?1').run(like)
  db.query('delete from tournament_matches where match_id like ?1 or session_id like ?1').run(like)
  db.query('delete from matches where id like ?1').run(like)
  db.query(`delete from player_ratings where player_id like '${SEED_PREFIX}-bot-%'`).run()
  db.query(`delete from players where id like '${SEED_PREFIX}-bot-%'`).run()
}

function seedRettendRatings(db: Database, summary: Partial<Record<RatingMode, { games: number, wins: number }>>, lastPlayedAt: number): void {
  const ratingByMode: Record<RatingMode, { mu: number, sigma: number }> = {
    duel: { mu: 30.6, sigma: 6.1 },
    duo: { mu: 31.4, sigma: 5.9 },
    squad: { mu: 29.8, sigma: 6.2 },
    ffa: { mu: 28.9, sigma: 6.5 },
  }
  const upsert = db.query(`insert into player_ratings (
    player_id,
    mode,
    mu,
    sigma,
    games_played,
    wins,
    imported_games,
    effective_games,
    wins_vs_tier_1,
    wins_vs_tier_2_plus,
    effective_wins_vs_tier_1,
    effective_wins_vs_tier_2_plus,
    last_played_at,
    updated_at
  ) values (?1, ?2, ?3, ?4, ?5, ?6, 0, ?5, 0, 0, 0, 0, ?7, ?8)
  on conflict(player_id, mode) do update set
    mu = excluded.mu,
    sigma = excluded.sigma,
    games_played = excluded.games_played,
    wins = excluded.wins,
    imported_games = excluded.imported_games,
    effective_games = excluded.effective_games,
    last_played_at = excluded.last_played_at,
    updated_at = excluded.updated_at`)

  for (const [mode, stats] of Object.entries(summary) as Array<[RatingMode, { games: number, wins: number }]>) {
    const rating = ratingByMode[mode]
    upsert.run(RETTEND_ID, mode, rating.mu, rating.sigma, stats.games, stats.wins, lastPlayedAt, Date.now())
  }

  const total = Object.values(summary).reduce((acc, stats) => ({ games: acc.games + (stats?.games ?? 0), wins: acc.wins + (stats?.wins ?? 0) }), { games: 0, wins: 0 })
  upsert.run(RETTEND_ID, 'global', 31.2, 6.0, total.games, total.wins, lastPlayedAt, Date.now())
}

function summarizeRettendRatings(matches: readonly SeedMatch[]): Partial<Record<RatingMode, { games: number, wins: number }>> {
  const summary: Partial<Record<RatingMode, { games: number, wins: number }>> = {}
  for (const match of matches) {
    const mode = toRatingMode(match.gameMode)
    const participant = match.participants.find(row => row.playerId === RETTEND_ID)
    if (!participant) continue
    const current = summary[mode] ?? { games: 0, wins: 0 }
    current.games += 1
    if (participant.placement === 1) current.wins += 1
    summary[mode] = current
  }
  return summary
}

function rebuildPlayerCivStats(db: Database, updatedAt: number): void {
  const redDeathIds = [...redDeathLeaderMap.keys()].map(sqlString).join(', ')
  const eligibleWhere = `m.status = 'completed'
    and mp.civ_id is not null
    and mp.civ_id not in (${redDeathIds})
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

  db.query('delete from match_player_civ_stat_contributions').run()
  db.query('delete from player_civ_stats').run()
  db.exec(`insert into match_player_civ_stat_contributions (match_id, contributions_json, updated_at)
    select
      grouped.match_id,
      json_group_array(json_object(
        'seasonId', grouped.season_id,
        'gameMode', grouped.game_mode,
        'playerId', grouped.player_id,
        'civId', grouped.civ_id,
        'picks', grouped.picks,
        'wins', grouped.wins
      )),
      ${updatedAt}
    from (
      select
        m.id as match_id,
        coalesce(m.season_id, '') as season_id,
        m.game_mode as game_mode,
        mp.player_id as player_id,
        mp.civ_id as civ_id,
        count(*) as picks,
        sum(case when mp.placement = 1 then 1 else 0 end) as wins
      from matches m
      inner join match_participants mp on mp.match_id = m.id
      where ${eligibleWhere}
      group by m.id, coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id
      order by m.id, coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id
    ) grouped
    group by grouped.match_id`)
  db.exec(`insert into player_civ_stats (season_id, game_mode, player_id, civ_id, picks, wins, updated_at)
    select
      coalesce(m.season_id, '') as season_id,
      m.game_mode as game_mode,
      mp.player_id as player_id,
      mp.civ_id as civ_id,
      count(*) as picks,
      sum(case when mp.placement = 1 then 1 else 0 end) as wins,
      ${updatedAt}
    from matches m
    inner join match_participants mp on mp.match_id = m.id
    where ${eligibleWhere}
    group by coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id`)
}

function selectDisplaySeasonId(db: Database): string | null {
  const active = db.query('select id from seasons where active = 1 order by starts_at desc limit 1').get() as { id: string } | undefined
  if (active) return active.id
  const latest = db.query('select id from seasons order by season_number desc limit 1').get() as { id: string } | undefined
  return latest?.id ?? null
}

function toRatingMode(gameMode: GameMode): RatingMode {
  if (gameMode === '1v1') return 'duel'
  if (gameMode === '2v2') return 'duo'
  if (gameMode === 'ffa') return 'ffa'
  return 'squad'
}

function botId(index: number): string {
  return `${SEED_PREFIX}-bot-${String(index + 1).padStart(2, '0')}`
}

function resolveLocalD1SqlitePath(): string {
  const d1Dir = resolve(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(d1Dir)) throw new Error(`Local D1 directory not found: ${d1Dir}`)

  for (const file of readdirSync(d1Dir)) {
    if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
    const sqlitePath = resolve(d1Dir, file)
    const db = new Database(sqlitePath, { readonly: true })
    try {
      const tables = new Set((db
        .query("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>).map(row => row.name))
      if (tables.has('matches') && tables.has('match_participants') && tables.has('player_civ_stats')) return sqlitePath
    }
    finally {
      db.close()
    }
  }

  throw new Error(`Could not find a local CivUp D1 SQLite file in ${d1Dir}`)
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
