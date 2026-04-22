import { afterEach, describe, expect, test } from 'bun:test'
import { joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import { getRankedRoleConfig, resolveRankedRoleVisuals, setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { expectLobbyState } from './helpers/assertions.ts'
import { runSeededSystemSequence } from './helpers/seeded-runner.ts'
import { createSystemWorld } from './helpers/world.ts'

const worlds: Array<Awaited<ReturnType<typeof createSystemWorld>>> = []

afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

describe('system invariant runners', () => {
  for (const seed of ['phase8-seed-a', 'phase8-seed-b', 'phase8-seed-c']) {
    test(`seeded long sequence preserves invariants (${seed})`, async () => {
      const world = await createTrackedWorld()
      const result = await runSeededSystemSequence(world, seed, { cycles: 5 })

      expect(result.steps.length).toBeGreaterThanOrEqual(5)
    })
  }

  test('rank-gated join surfaces injected guild member lookup failures', async () => {
    const world = await createTrackedWorld()
    const guildId = 'guild-ranked-member'
    const hostId = 'rank-host'
    const joinerId = 'rank-joiner'
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: hostId }],
      hostId,
      guildId,
      channelId: 'channel-ranked-member',
    })

    await setRankedRoleCurrentRoles(world.kv, guildId, {
      tier5: '11111111111111111',
    })

    const configured = await world.lobby.config('1v1', {
      hostId,
      lobbyId: lobby.id,
      minRole: 'tier5',
    })
    expect(configured.status).toBe(200)
    await world.flushBackgroundTasks()

    world.discord.failNextGuildMemberLookup(guildId, joinerId, 503)

    await expect(joinLobbyAndMaybeStartMatch({
      env: {
        KV: world.kv,
        DISCORD_TOKEN: world.env.DISCORD_TOKEN,
        PARTY_HOST: world.env.PARTY_HOST,
        CIVUP_SECRET: world.env.CIVUP_SECRET,
      },
    }, '1v1', [{
      playerId: joinerId,
      displayName: joinerId,
      avatarUrl: '',
    }])).rejects.toThrow('Discord fetch guild member failed: 503')

    await expectLobbyState(world, {
      lobbyId: lobby.id,
      status: 'open',
      memberPlayerIds: [hostId],
    })
  })

  test('ranked role visuals surface injected guild role lookup failures and recover on retry', async () => {
    const world = await createTrackedWorld()
    const guildId = 'guild-ranked-roles'

    await setRankedRoleCurrentRoles(world.kv, guildId, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
    })
    world.discord.setGuildRoles(guildId, [
      { id: '11111111111111111', name: 'Bronze', color: 0xAA5500 },
      { id: '22222222222222222', name: 'Silver', color: 0xCCCCCC },
    ])

    const config = await getRankedRoleConfig(world.kv, guildId)
    world.discord.failNextGuildRolesLookup(guildId, 502)

    await expect(resolveRankedRoleVisuals(world.env.DISCORD_TOKEN!, guildId, config)).rejects.toThrow('Discord fetch guild roles failed: 502')

    const visuals = await resolveRankedRoleVisuals(world.env.DISCORD_TOKEN!, guildId, config)
    expect(visuals).toEqual([
      expect.objectContaining({ tier: 'tier4', label: 'Silver' }),
      expect.objectContaining({ tier: 'tier5', label: 'Bronze' }),
    ])
  })
})

async function createTrackedWorld() {
  const world = await createSystemWorld()
  worlds.push(world)
  return world
}
