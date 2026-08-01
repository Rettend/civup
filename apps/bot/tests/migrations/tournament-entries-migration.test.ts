import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

describe('tournament entries migration', () => {
  test('backfills linked, pending, withdrawn, reported, and playoff 1v1 data', async () => {
    const sqlite = new Database(':memory:')
    sqlite.run('PRAGMA foreign_keys = ON')
    try {
      sqlite.exec('CREATE TABLE players (id text PRIMARY KEY NOT NULL)')
      for (const id of ['p1', 'p2', 'p3', 'p4']) sqlite.prepare('INSERT INTO players (id) VALUES (?)').run(id)
      await applyMigration(sqlite, '0017_tournaments.sql')
      sqlite.prepare(`INSERT INTO tournaments (id, name, mode, status, scoring, rematch_policy, min_games, top_cut, created_by_id, created_at, updated_at)
        VALUES ('cup', 'Migration Cup', '1v1', 'top_cut', 'open_win_rate', 'warn', 1, 4, 'admin', 1, 1)`).run()
      insertLegacyPlayer(sqlite, 'Linked', 'p1', 1, true)
      insertLegacyPlayer(sqlite, 'Pending', null, 2, true)
      insertLegacyPlayer(sqlite, 'Withdrawn', 'p2', 3, false)
      insertLegacyPlayer(sqlite, 'Playoff A', 'p3', 4, true)
      insertLegacyPlayer(sqlite, 'Playoff B', 'p4', 5, true)
      sqlite.prepare(`INSERT INTO tournament_matches
        (session_id, tournament_id, match_id, stage, status, player_one_id, player_two_id, winner_id, created_at, updated_at)
        VALUES ('qualifier-session', 'cup', 'qualifier-match', 'qualifier', 'reported', 'p1', 'p2', 'p1', 1, 1)`).run()
      sqlite.prepare(`INSERT INTO tournament_matches
        (session_id, tournament_id, match_id, stage, status, player_one_id, player_two_id, winner_id, created_at, updated_at)
        VALUES ('playoff-session', 'cup', 'playoff-match', 'final', 'reported', 'p3', 'p4', 'p3', 1, 1)`).run()
      sqlite.prepare(`INSERT INTO tournament_cut_pairings
        (id, tournament_id, round, seed_one, seed_two, player_one_id, player_two_id, session_id, match_id, winner_id, status, created_at, updated_at)
        VALUES ('final-pairing', 'cup', 'final', 4, 5, 'p3', 'p4', 'playoff-session', 'playoff-match', 'p3', 'reported', 1, 1)`).run()

      await applyMigration(sqlite, '0021_tournament_entries.sql')

      const entries = sqlite.prepare('SELECT id, seed, status FROM tournament_entries ORDER BY seed').all() as Array<{ id: string, seed: number, status: string }>
      expect(entries).toEqual([
        { id: 'legacy:cup:4C696E6B6564', seed: 1, status: 'active' },
        { id: 'legacy:cup:50656E64696E67', seed: 2, status: 'active' },
        { id: 'legacy:cup:57697468647261776E', seed: 3, status: 'withdrawn' },
        { id: 'legacy:cup:506C61796F66662041', seed: 4, status: 'active' },
        { id: 'legacy:cup:506C61796F66662042', seed: 5, status: 'active' },
      ])
      const pending = sqlite.prepare(`SELECT player_id AS playerId, display_name AS displayName, active FROM tournament_entry_members WHERE display_name = 'Pending'`).get() as { playerId: string | null, displayName: string, active: number }
      expect(pending).toEqual({ playerId: null, displayName: 'Pending', active: 1 })
      const qualifier = sqlite.prepare(`SELECT entry_one_id AS oneId, entry_two_id AS twoId, winner_entry_id AS winnerId FROM tournament_matches WHERE session_id = 'qualifier-session'`).get()
      expect(qualifier).toEqual({ oneId: 'legacy:cup:4C696E6B6564', twoId: 'legacy:cup:57697468647261776E', winnerId: 'legacy:cup:4C696E6B6564' })
      const playoff = sqlite.prepare(`SELECT entry_one_id AS oneId, entry_two_id AS twoId, winner_entry_id AS winnerId FROM tournament_cut_pairings WHERE id = 'final-pairing'`).get()
      expect(playoff).toEqual({ oneId: 'legacy:cup:506C61796F66662041', twoId: 'legacy:cup:506C61796F66662042', winnerId: 'legacy:cup:506C61796F66662041' })
      expect(() => sqlite.prepare(`INSERT INTO tournament_entry_members
        (entry_id, tournament_id, position, player_id, display_name, active, created_at, updated_at)
        VALUES ('legacy:cup:50656E64696E67', 'cup', 1, 'p1', 'Duplicate', true, 1, 1)`).run()).toThrow(/unique constraint/i)
    }
    finally {
      sqlite.close()
    }
  })
})

async function applyMigration(sqlite: Database, fileName: string): Promise<void> {
  const migration = await Bun.file(new URL(`../../../../packages/db/migrations/${fileName}`, import.meta.url)).text()
  for (const statement of migration.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) sqlite.exec(sql)
  }
}

function insertLegacyPlayer(sqlite: Database, displayName: string, playerId: string | null, seed: number, confirmed: boolean): void {
  sqlite.prepare(`INSERT INTO tournament_players
    (tournament_id, seed, player_id, display_name, confirmed, linked_at, created_at, updated_at)
    VALUES ('cup', ?, ?, ?, ?, ?, 1, 1)`).run(seed, playerId, displayName, confirmed, playerId ? 1 : null)
}
