import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')
const cwd = process.cwd().replace(/\\/g, '/')
const args = Bun.argv.slice(1).map(arg => arg.replace(/\\/g, '/'))
const targetArgs = args.filter(arg => arg !== 'test' && !arg.startsWith('-'))

function targetsActivityDomSetup(arg: string) {
  const normalized = arg.replace(/^\.\//, '')
  return normalized === 'apps/activity/tests/dom-setup.test.ts'
    || normalized.endsWith('/apps/activity/tests/dom-setup.test.ts')
}

const isActivityCwd = cwd === `${repoRoot}/apps/activity`

if (isActivityCwd || targetArgs.some(targetsActivityDomSetup)) {
  await import('../apps/activity/tests/setup-dom')
}
