import type { ContributionRow, CivLeaderboardDisplayConfig } from '../../src/services/leaderboard/civ-snapshot.ts'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb, civReleaseDirty, civReleaseProjections, matches, matchCivStatContributions } from '@civup/db'
import { advanceCivReleaseProjection, readCivReleaseSnapshots } from '../../src/services/leaderboard/civ-release.ts'
import {
  CIV_LEADERBOARD_MODE_SCOPES,
  selectReleaseContributions,
  snapshotFromContributionRows,
} from '../../src/services/leaderboard/civ-snapshot.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('release deltas match the full sample through growth, cancellations, pool-only eligibility, and racing corrections', async () => {
  const { sqlite } = await createTestDatabase()
  const reads: Array<{ query: string; rows: number }> = []
  const client = createSqliteD1Database({
    exec: sqlite.exec.bind(sqlite),
    prepare: ((query: string) => {
      const statement = sqlite.prepare(query)
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property === 'values' || property === 'all')
            return (...args: unknown[]) => {
              const result = value.apply(target, args)
              reads.push({ query, rows: result.length })
              return result
            }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }) as typeof sqlite.prepare,
  })
  const db = createDb(client)
  const source = new Map<string, ContributionRow & { matchId: string }>()
  const config: CivLeaderboardDisplayConfig = {
    version: 1,
    label: 'Release',
    liveFrom: 1000,
    betaFrom: 0,
    betaUntil: 1000,
    pendingBetaFrom: 1000,
    betaReplacement: 'one-for-one',
    betaSeedMatchIds: Array.from({ length: 80 }, (_, i) => `beta-${i}`),
  }
  const payload = (civId: string) =>
    JSON.stringify({
      version: 2,
      poolCivIds: ['rome-trajan', 'greece-pericles'],
      entries: [{ civId, picks: 1, wins: 1, bans: 3 }],
    })
  async function add(id: string, kind: 'live' | 'beta', index: number) {
    const row = {
      matchId: id,
      completedMatchCount: 1,
      contributionsJson: payload(index % 2 ? 'rome-trajan' : 'greece-pericles'),
      source: kind,
      modeScope: CIV_LEADERBOARD_MODE_SCOPES[1 + (index % 3)]!,
      completedAt: kind === 'beta' ? index : 2000 + index,
      visible: true,
    }
    await db.insert(matches).values({ id, status: 'completed', gameMode: '1v1', createdAt: kind === 'beta' ? 0 : 1000 })
    await db.insert(matchCivStatContributions).values({ ...row, updatedAt: 5000 })
    source.set(id, row)
  }
  async function drain() {
    for (let i = 0; i < 60; i++) if (await advanceCivReleaseProjection(db, config)) return
    throw new Error('Release preparation did not drain')
  }
  async function compare() {
    const actual = await readCivReleaseSnapshots(db, config, CIV_LEADERBOARD_MODE_SCOPES, 5000, true)
    const selected = selectReleaseContributions([...source.values()])
    for (const scope of CIV_LEADERBOARD_MODE_SCOPES)
      expect(actual.get(scope)).toEqual({
        ...snapshotFromContributionRows(selected, scope, config.label, 5000, true),
        periodId: 'Release:1000',
      })
  }
  try {
    for (let i = 0; i < 80; i++) await add(`beta-${i}`, 'beta', i)
    for (let i = 0; i < 40; i++) await add(`live-${i}`, 'live', i)
    await expect(readCivReleaseSnapshots(db, config, ['all'], 5000, true)).rejects.toThrow('still being prepared')
    await drain()
    await compare()
    await db
      .update(matchCivStatContributions)
      .set({ updatedAt: 6000 })
      .where(eq(matchCivStatContributions.matchId, 'live-0'))
    await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'live-0'))
    expect(await db.select().from(civReleaseDirty)).toHaveLength(0)
    reads.length = 0
    expect(await advanceCivReleaseProjection(db, config)).toBe(true)
    expect(reads).toHaveLength(1)
    await db.insert(matches).values({ id: 'pending-contribution', status: 'active', gameMode: '1v1', createdAt: 1000 })
    await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'pending-contribution'))
    expect(await db.select().from(civReleaseDirty)).toHaveLength(0)
    const pending = { ...source.get('live-0')!, matchId: 'pending-contribution', completedAt: 2500 }
    await db.insert(matchCivStatContributions).values({ ...pending, updatedAt: 6000 })
    source.set(pending.matchId, pending)
    expect(await db.select().from(civReleaseDirty)).toHaveLength(1)
    await drain()
    await compare()
    for (let i = 40; i < 1040; i++) await add(`live-${i}`, 'live', i)
    reads.length = 0
    await drain()
    expect(
      Math.max(...reads.filter(row => row.query.includes('from "match_civ_stat_contributions"')).map(row => row.rows)),
    ).toBeLessThanOrEqual(50)
    await compare()
    // Live replacements are global: cancellations in any mode restore the correct frozen beta member.
    for (let i = 20; i < 1040; i++) {
      await db
        .update(matches)
        .set({ status: 'cancelled' })
        .where(eq(matches.id, `live-${i}`))
      source.delete(`live-${i}`)
    }
    await drain()
    await compare()
    await db.update(matches).set({ draftData: '{"redDeath":true}' }).where(eq(matches.id, 'beta-79'))
    source.delete('beta-79')
    await drain()
    await compare()
    await db
      .update(matchCivStatContributions)
      .set({ contributionsJson: payload('rome-trajan') })
      .where(eq(matchCivStatContributions.matchId, 'live-0'))
    const batch = client.batch.bind(client)
    const before = await db.select().from(civReleaseProjections)
    client.batch = (async statements => {
      client.batch = batch
      sqlite.exec(
        `update match_civ_stat_contributions set contributions_json='${payload('greece-pericles')}' where match_id='live-0'`,
      )
      return batch(statements)
    }) as typeof client.batch
    await expect(advanceCivReleaseProjection(db, config)).rejects.toThrow()
    expect(await db.select().from(civReleaseProjections)).toEqual(before)
    expect(await db.select().from(civReleaseDirty)).toHaveLength(1)
    source.set('live-0', { ...source.get('live-0')!, contributionsJson: payload('greece-pericles') })
    await drain()
    await compare()
    reads.length = 0
    await readCivReleaseSnapshots(db, config, ['duel'], 5000, true)
    expect(reads).toHaveLength(1)
    expect(reads[0]!.rows).toBe(1)
    expect(reads[0]!.query).not.toContain('match_civ_stat_contributions')
  } finally {
    sqlite.close()
  }
})
