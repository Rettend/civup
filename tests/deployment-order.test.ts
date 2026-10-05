import { expect, test } from 'bun:test'
import { runDeploymentCommands, standardDeploymentCommands } from '../scripts/deploy'

test('a failed bot deployment prevents Activity deployment and Discord registration', () => {
  const commands = standardDeploymentCommands(true)
  const visited: string[][] = []
  const exitCode = runDeploymentCommands(commands, command => {
    visited.push(command)
    return command.includes('deploy') && command.includes('bot') ? 7 : 0
  })
  expect(exitCode).toBe(7)
  expect(visited).toHaveLength(3)
  expect(visited.flat()).not.toContain('activity')
  expect(visited.flat()).not.toContain('register')
  expect(visited[0]).toContain('migrate')
})

test('standard releases use checked prebuilt artifacts and optionally register last', () => {
  const commands = standardDeploymentCommands(true)
  for (const command of commands) expect(command.at(command.indexOf('--target') + 1)).toBe('standard')
  for (const worker of ['bot', 'activity']) {
    const build = commands.findIndex(command => command.includes('build') && command.includes(worker))
    const deploy = commands.findIndex(command => command.includes('deploy') && command.includes(worker))
    expect(build).toBeLessThan(deploy)
    expect(commands[deploy]).toContain('--prebuilt')
  }
  expect(commands.at(-1)).toContain('register')
  expect(standardDeploymentCommands(false).flat()).not.toContain('register')
})
