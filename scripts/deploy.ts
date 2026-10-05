/* eslint-disable no-console */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'bun'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

export function standardDeploymentCommands(register: boolean): string[][] {
  const target = ['--target', 'standard']
  return [
    ['bun', 'scripts/cloudflare-admin.ts', 'migrate', ...target, '--remote'],
    ['bun', 'scripts/cloudflare-worker.ts', 'build', 'bot', ...target],
    ['bun', 'scripts/cloudflare-worker.ts', 'deploy', 'bot', ...target, '--prebuilt'],
    ['bun', 'scripts/cloudflare-worker.ts', 'build', 'activity', ...target],
    ['bun', 'scripts/cloudflare-worker.ts', 'deploy', 'activity', ...target, '--prebuilt'],
    ...(register ? [['bun', 'scripts/cloudflare-admin.ts', 'register', ...target]] : []),
  ]
}

export function runDeploymentCommands(commands: string[][], run: (command: string[]) => number): number {
  for (const command of commands) {
    const exitCode = run(command)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.some(argument => argument !== '--register' && argument !== '--print-commands')) {
    console.error('Usage: bun scripts/deploy.ts [--register] [--print-commands]')
    process.exitCode = 1
  }
  else {
    const commands = standardDeploymentCommands(args.includes('--register'))
    if (args.includes('--print-commands')) console.log(JSON.stringify({ target: 'standard', cwd: repositoryRoot, commands }, null, 2))
    else process.exitCode = runDeploymentCommands(commands, cmd => spawnSync({ cmd, cwd: repositoryRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exitCode ?? 1)
  }
}
