import { describe, expect, test } from 'bun:test'
import * as commands from '../../src/commands/index.ts'
import { EXPECTED_GUILD_COMMANDS } from '../../src/commands/expected.ts'
import { factory } from '../../src/setup.ts'

describe('expected guild commands', () => {
  test('stays aligned with registration definitions', () => {
    const registered = factory.getCommands(Object.values(commands))
      .map(command => command.toJSON() as { name: string, type?: number })
      .map(command => `${command.type ?? 1}:${command.name}`)
      .sort()
    const expected = EXPECTED_GUILD_COMMANDS.map(command => `${command.type}:${command.name}`).sort()
    expect(registered).toEqual(expected)
  })
})
