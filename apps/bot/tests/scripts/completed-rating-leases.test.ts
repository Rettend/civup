import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { exactLeaseSourceGuard, validateCompletedLeaseSource } from '../../scripts/reconcile-completed-rating-leases.ts'

const now = 2_000_000
function source() {
  const participants = ['a', 'b'].map((player_id, index) => ({
    match_id: 'match',
    player_id,
    placement: index + 1,
    rating_before_mu: 25,
    rating_before_sigma: 8.33,
    rating_after_mu: index === 0 ? 28 : 22,
    rating_after_sigma: 8,
  }))
  return {
    leases: [{ id: 'reviewed', match_id: 'match', generation: 2, created_at: 100 }],
    matches: [{ id: 'match', status: 'completed', season_id: 's9', game_mode: '1v1', completed_at: 1000 }],
    reports: [{ match_id: 'match', season_id: 's9', sequence: 7, accepted_at: 1000, cancelled_at: null }],
    sessions: [{ match_id: 'match', phase: 'reported' }],
    participants,
    events: participants.flatMap(participant =>
      ['duel', 'global'].map(mode => ({
        ...participant,
        mode,
        season_id: 's9',
        public_sequence: 7,
        public_rating_before: 750,
        public_rating_after: participant.placement === 1 ? 800 : 700,
      })),
    ),
    civ: [{ match_id: 'match', payload: '{}' }],
    playerCiv: [{ match_id: 'match', payload: '{}' }],
  }
}

describe('reviewed completed rating operations', () => {
  test('requires a complete saved report, session, both rating tracks and statistics', () => {
    expect(validateCompletedLeaseSource(source(), ['reviewed'], now)).toEqual(['match'])
    const missingEvent = source()
    missingEvent.events.pop()
    expect(() => validateCompletedLeaseSource(missingEvent, ['reviewed'], now)).toThrow(
      'incomplete players or rating events',
    )
    const missingStats = source()
    missingStats.playerCiv = []
    expect(() => validateCompletedLeaseSource(missingStats, ['reviewed'], now)).toThrow('statistics')
    const pending = source()
    pending.sessions[0]!.phase = 'active'
    expect(() => validateCompletedLeaseSource(pending, ['reviewed'], now)).toThrow('closed session')
  })

  test('age alone never permits clearing an incomplete operation', () => {
    const incomplete = source()
    incomplete.participants[0]!.rating_after_mu += 1
    expect(() => validateCompletedLeaseSource(incomplete, ['reviewed'], now)).toThrow(
      'conflicting saved rating changes',
    )
    const recent = source()
    recent.leases[0]!.created_at = now - 1
    expect(() => validateCompletedLeaseSource(recent, ['reviewed'], now)).toThrow('too recent')
    expect(() => validateCompletedLeaseSource(source(), ['other'], now)).toThrow('exactly once')
  })

  test('a changed nullable field rolls back deletion and unrelated leases survive', () => {
    const db = new Database(':memory:')
    try {
      db.exec(
        'CREATE TABLE rating_mutation_leases(id TEXT PRIMARY KEY, match_id TEXT, generation INTEGER, created_at INTEGER); CREATE TABLE evidence(match_id TEXT, rating REAL, data TEXT);',
      )
      db.query('INSERT INTO rating_mutation_leases VALUES(?,?,?,?)').run('reviewed', 'match', 2, 100)
      db.query('INSERT INTO rating_mutation_leases VALUES(?,?,?,?)').run('unrelated', 'elsewhere', 2, 100)
      const rows = [{ match_id: 'match', rating: 28.123456789012344, data: null }]
      db.query('INSERT INTO evidence VALUES(?,?,?)').run('match', rows[0]!.rating, null)
      const guard = exactLeaseSourceGuard('evidence', 'match_id', ['match'], rows)
      const apply = db.transaction(() => {
        db.query(guard.sql).all(...guard.params!)
        db.query('DELETE FROM rating_mutation_leases WHERE id=?').run('reviewed')
      })
      db.query('UPDATE evidence SET data=?').run('null')
      expect(() => apply()).toThrow()
      expect(db.query('SELECT count(*) AS count FROM rating_mutation_leases').get()).toEqual({ count: 2 })
      db.exec('UPDATE evidence SET data=NULL')
      apply()
      expect(db.query('SELECT id FROM rating_mutation_leases').all()).toEqual([{ id: 'unrelated' }])
    } finally {
      db.close()
    }
  })

  test('additional source rows and an exact-double change reject the saved guard', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE evidence(match_id TEXT, rating REAL)')
      const rows = [{ match_id: 'match', rating: 28.123456789012344 }]
      db.query('INSERT INTO evidence VALUES(?,?)').run('match', rows[0]!.rating)
      const guard = exactLeaseSourceGuard('evidence', 'match_id', ['match'], rows)
      expect(db.query(guard.sql).all(...guard.params!)).toEqual([{ valid: 1 }])
      db.exec('INSERT INTO evidence SELECT * FROM evidence')
      expect(() => db.query(guard.sql).all(...guard.params!)).toThrow()
      db.exec('DELETE FROM evidence WHERE rowid=2')
      db.query('UPDATE evidence SET rating=?').run(rows[0]!.rating + 1e-12)
      expect(() => db.query(guard.sql).all(...guard.params!)).toThrow()
    } finally {
      db.close()
    }
  })
})
