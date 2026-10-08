import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { cancellationCompletionBatch } from '../../scripts/season-cancellation-completion.ts'

const plan = { operationId: 'season-cancellation:1000:s9', generation: 3, cancelledAt: 1000, matchIds: ['a', 'b'] }

function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE rating_maintenance(id INTEGER, state TEXT, generation INTEGER);
    INSERT INTO rating_maintenance VALUES(1,'paused',3);
    CREATE TABLE rating_mutation_leases(id TEXT PRIMARY KEY,match_id TEXT,generation INTEGER,created_at INTEGER);
    CREATE TABLE matches(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE season_match_reports(match_id TEXT PRIMARY KEY,cancelled_at INTEGER);
    CREATE TABLE session_directory(match_id TEXT PRIMARY KEY,phase TEXT);
    CREATE TABLE match_participants(match_id TEXT,placement INTEGER,rating_before_mu REAL,rating_before_sigma REAL,rating_after_mu REAL,rating_after_sigma REAL);
    CREATE TABLE player_rating_events(match_id TEXT);
    CREATE TABLE match_civ_stat_contributions(match_id TEXT);
    CREATE TABLE match_player_civ_stat_contributions(match_id TEXT);
  `)
  db.query('INSERT INTO rating_mutation_leases VALUES(?,?,?,?)').run(plan.operationId, plan.operationId, 3, 1000)
  for (const id of plan.matchIds) {
    db.query("INSERT INTO matches VALUES(?,'cancelled')").run(id)
    db.query('INSERT INTO season_match_reports VALUES(?,1000)').run(id)
    db.query("INSERT INTO session_directory VALUES(?,'cancelled')").run(id)
    db.query('INSERT INTO match_participants VALUES(?,NULL,NULL,NULL,NULL,NULL)').run(id)
  }
  const complete = db.transaction(() => {
    for (const statement of cancellationCompletionBatch(plan)) db.query(statement.sql).all(...statement.params!)
  })
  return { db, complete }
}

test('releases the persistent cancellation only after every match finishes', () => {
  const { db, complete } = fixture()
  try {
    complete()
    expect(db.query('SELECT * FROM rating_mutation_leases').all()).toEqual([])
    expect(db.query('SELECT * FROM matches').all()).toHaveLength(2)
  } finally {
    db.close()
  }
})

for (const mutation of [
  "UPDATE rating_maintenance SET state='open'",
  'UPDATE rating_maintenance SET generation=4',
  "INSERT INTO rating_mutation_leases VALUES('other','a',3,1000)",
  "UPDATE matches SET status='completed' WHERE id='b'",
  "UPDATE season_match_reports SET cancelled_at=999 WHERE match_id='b'",
  "UPDATE session_directory SET phase='reported' WHERE match_id='b'",
  "DELETE FROM match_participants WHERE match_id='b'",
  "UPDATE match_participants SET placement=1 WHERE match_id='b'",
  "UPDATE match_participants SET rating_after_mu=25 WHERE match_id='b'",
  "INSERT INTO player_rating_events VALUES('b')",
  "INSERT INTO match_civ_stat_contributions VALUES('b')",
  "INSERT INTO match_player_civ_stat_contributions VALUES('b')",
]) {
  test(`retains the reporting blocker when ${mutation}`, () => {
    const { db, complete } = fixture()
    try {
      db.exec(mutation)
      expect(() => complete()).toThrow()
      expect(db.query('SELECT id FROM rating_mutation_leases WHERE id=?').get(plan.operationId)).toEqual({
        id: plan.operationId,
      })
    } finally {
      db.close()
    }
  })
}
