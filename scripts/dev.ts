import { spawn, spawnSync } from 'bun'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const processes: Array<{ name: string, proc: ReturnType<typeof spawn> }> = []

const services = [
  { name: 'bot', cmd: ['bun', 'run', 'bot:dev'] },
  { name: 'activity', cmd: ['bun', 'run', 'a:dev'] },
  { name: 'party', cmd: ['bun', 'run', 'party:dev'] },
  { name: 'tunnel', cmd: ['cloudflared', '--config', 'cloudflared.dev.yml', 'tunnel', 'run', 'civup-dev'] },
]

let shuttingDown = false

function killProcessTree(pid: number) {
  if (process.platform === 'win32') {
    spawnSync({
      cmd: ['taskkill', '/PID', String(pid), '/T', '/F'],
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  }
  catch {}
}

function shutdown(code: number) {
  if (shuttingDown) return
  shuttingDown = true

  for (const { proc } of processes) {
    if (proc.pid) killProcessTree(proc.pid)
  }

  process.exit(code)
}

for (const svc of services) {
  const proc = spawn({
    cmd: svc.cmd,
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  processes.push({ name: svc.name, proc })

  void proc.exited.then((exitCode) => {
    if (shuttingDown) return

    if (exitCode !== 0) {
      console.error(`[dev] ${svc.name} exited with code ${exitCode}`)
      shutdown(exitCode || 1)
      return
    }

    console.warn(`[dev] ${svc.name} exited; stopping remaining services`)
    shutdown(0)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

await Promise.all(processes.map(({ proc }) => proc.exited))
