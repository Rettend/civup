// Narrow Node-only fallback for cf beta.12's discarded KV pagination metadata.
// Wrangler's local key list also stops after one page. Return the SDK's actual page instead.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const cfRequire = createRequire(require.resolve('cf/package.json'))
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(cfRequire.resolve('miniflare')).href)
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
if (typeof input.namespaceId !== 'string' || !/^[a-f0-9]{32}$/i.test(input.namespaceId))
  throw new Error('Pass a KV namespace ID.')
if (typeof input.persistenceDirectory !== 'string' || !isAbsolute(input.persistenceDirectory))
  throw new Error('Pass an absolute local persistence directory.')
if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)
  throw new Error('Pass a KV list limit between 1 and 1000.')
const mf = new Miniflare(
  convertV4MiniflareOptions({
    script: 'addEventListener("fetch", e => e.respondWith(new Response(null, { status: 404 })))',
    resourcePersistencePath: join(input.persistenceDirectory, 'v3'),
    kvNamespaces: { NAMESPACE: input.namespaceId },
  }),
)
try {
  const namespace = await mf.getKVNamespace('NAMESPACE')
  const page = await namespace.list({ prefix: input.prefix, cursor: input.cursor, limit: input.limit })
  process.stdout.write(`${JSON.stringify(page)}\n`)
} finally {
  await mf.dispose()
}
