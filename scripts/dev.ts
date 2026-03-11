import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'bun'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const botRoot = resolve(repoRoot, 'apps', 'bot')
const activityRoot = resolve(repoRoot, 'apps', 'activity')
const partyRoot = resolve(repoRoot, 'apps', 'party')
const activityPreviewConfig = resolve(activityRoot, 'dist', 'civup_activity', 'wrangler.json')
const activityPreviewPersistDir = resolve(repoRoot, '.wrangler', 'activity-preview')

interface Service {
  name: string
  cmd: string[]
  cwd: string
}

const processes: Array<{ name: string, proc: ReturnType<typeof spawn> }> = []

const rebuildActivity = process.argv.includes('--rebuild-activity')
const activityLive = process.argv.includes('--activity-live')

const activityCommand = activityLive
  ? ['bun', 'x', 'vite', '--host', '0.0.0.0', '--port', '5173']
  : ['bun', 'x', 'wrangler', 'dev', '--config', 'wrangler.json', '--cwd', 'dist/civup_activity', '--persist-to', activityPreviewPersistDir, '--port', '5173', '--show-interactive-dev-session=false', '--log-level', 'log']

const services: Service[] = [
  {
    name: 'bot',
    cwd: botRoot,
    cmd: ['bun', 'x', 'wrangler', 'dev', '--show-interactive-dev-session=false', '--log-level', 'log'],
  },
  {
    name: 'activity',
    cwd: activityRoot,
    cmd: activityCommand,
  },
  {
    name: 'party',
    cwd: partyRoot,
    cmd: ['bun', 'x', 'wrangler', 'dev', '--port', '8788', '--show-interactive-dev-session=false', '--log-level', 'log'],
  },
  { name: 'tunnel', cwd: repoRoot, cmd: ['cloudflared', '--config', 'cloudflared.dev.yml', 'tunnel', 'run', 'civup-dev'] },
]

const requiredPorts = [8787, 8788, 5173]

let shuttingDown = false

if (rebuildActivity) {
  runCommand('activity build', ['bun', 'x', 'vite', 'build'], activityRoot)
}
else if (!activityLive && !existsSync(activityPreviewConfig)) {
  console.error('[dev] Activity preview bundle is missing. Run `bun run dev:new` or `bun run a:dev:new` first.')
  process.exit(1)
}

const occupiedPorts = findOccupiedPorts(requiredPorts)
if (occupiedPorts.length > 0) {
  console.error('[dev] Required dev ports are already in use:')
  for (const entry of occupiedPorts) {
    console.error(`[dev]   port ${entry.port} -> pid ${entry.pid}`)
  }
  console.error('[dev] Stop the stale processes first, then rerun `bun run dev`.')
  process.exit(1)
}

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
    cwd: svc.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  processes.push({ name: svc.name, proc })
  pipeProcessOutput(svc.name, proc.stdout, false)
  pipeProcessOutput(svc.name, proc.stderr, true)

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

function runCommand(name: string, cmd: string[], cwd: string) {
  console.log(`[dev] Running ${name}...`)
  const result = spawnSync({
    cmd,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (result.exitCode !== 0) {
    console.error(`[dev] ${name} failed with code ${result.exitCode ?? 1}`)
    process.exit(result.exitCode ?? 1)
  }
}

function findOccupiedPorts(ports: number[]): Array<{ port: number, pid: number }> {
  if (process.platform !== 'win32') return []

  const lookup = new Set(ports)
  const result = spawnSync({
    cmd: ['netstat', '-ano', '-p', 'tcp'],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  })

  if (result.exitCode !== 0) return []

  const output = result.stdout.toString()
  const matches = new Map<number, number>()
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0] !== 'TCP') continue
    const state = parts[3]
    if (state !== 'LISTENING') continue

    const localAddress = parts[1]
    const pid = Number(parts[4])
    const port = Number(localAddress.split(':').at(-1))
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue
    if (!lookup.has(port)) continue
    matches.set(port, pid)
  }

  return [...matches.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([port, pid]) => ({ port, pid }))
}

function pipeProcessOutput(
  name: string,
  stream: ReadableStream<Uint8Array> | null | undefined,
  isError: boolean,
) {
  if (!stream) return

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  void (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += sanitizeOutput(decoder.decode(value, { stream: true }))
      buffer = flushOutputBuffer(name, buffer, isError, false)
    }

    buffer += sanitizeOutput(decoder.decode())
    flushOutputBuffer(name, buffer, isError, true)
  })()
}

function flushOutputBuffer(name: string, buffer: string, isError: boolean, flushRemainder: boolean): string {
  const lines = buffer.split('\n')
  const pending = flushRemainder ? '' : lines.pop() ?? ''

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    const prefix = isError ? `[${name}:stderr]` : `[${name}]`
    console.log(`${prefix} ${line}`)
  }

  return pending
}

function sanitizeOutput(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
}
