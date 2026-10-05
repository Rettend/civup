/* eslint-disable no-console */
import { fileURLToPath } from 'node:url'
import { repositoryRoot } from './local-storage.ts'
import { createMaintenanceClient } from './maintenance-cloudflare.ts'

type ReadRequest = { target?: string; defaultTarget: 'ppl' | 'standard'; location: 'local' | 'remote' } & (
  | { operation: 'd1Query'; sql: string }
  | { operation: 'kvGet'; key: string }
)

// Compatibility for synchronous local image tools. All storage transport and
// result validation still belong to cloudflare-client.ts, never another CLI.
export function readMaintenanceSync<T>(request: ReadRequest): T {
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url)], {
    cwd: repositoryRoot,
    env: process.env,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (child.exitCode !== 0) throw new Error(`Maintenance read failed: ${child.stderr.toString().trim()}`)
  return JSON.parse(child.stdout.toString()) as T
}

if (import.meta.main) {
  try {
    const request = JSON.parse(await Bun.stdin.text()) as ReadRequest
    const { client } = createMaintenanceClient(request, request.location)
    const value =
      request.operation === 'd1Query'
        ? await client.d1Query(request.sql)
        : request.operation === 'kvGet'
          ? await client.kvGet(request.key)
          : (() => {
              throw new Error('Unsupported synchronous maintenance read.')
            })()
    console.log(JSON.stringify(value))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
