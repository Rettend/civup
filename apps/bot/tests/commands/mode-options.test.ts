import { describe, expect, test } from 'bun:test'
import { command_history } from '../../src/commands/history.ts'
import { command_leaders } from '../../src/commands/leaders.ts'
import { RANK_GRAPH_MODE_CHOICES } from '../../src/commands/rank.ts'
import { command_stats } from '../../src/commands/stats.ts'
import { command_tiers } from '../../src/commands/tiers.ts'
import { factory } from '../../src/setup.ts'

interface CommandOptionJson {
  name?: string
  choices?: Array<{ name?: string, value?: string }>
  options?: CommandOptionJson[]
}

interface CommandJson {
  name?: string
  options?: CommandOptionJson[]
}

describe('command mode options', () => {
  test('omits explicit all choices where omitted mode is the default', () => {
    const commands = registeredCommands()

    expect(choiceValues(commands, 'stats', 'mode')).not.toContain('all')
    expect(choiceValues(commands, 'history', 'mode')).not.toContain('all')
    expect(choiceValues(commands, 'leaders', 'mode')).not.toContain('all')
    expect(choiceValues(commands, 'tiers', 'mode')).not.toContain('all')
  })

  test('rank graph modes do not include red death', () => {
    expect(RANK_GRAPH_MODE_CHOICES.map(choice => choice.value)).toEqual(['overall', 'duel', 'duo', 'squad', 'ffa'])
  })
})

function registeredCommands(): CommandJson[] {
  return factory.getCommands([command_stats, command_history, command_leaders, command_tiers]) as CommandJson[]
}

function choiceValues(commands: readonly CommandJson[], commandName: string, optionName: string): string[] {
  const command = commands.find(command => command.name === commandName)
  const option = command?.options?.find(option => option.name === optionName)
  return option?.choices?.flatMap(choice => typeof choice.value === 'string' ? [choice.value] : []) ?? []
}
