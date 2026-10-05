// Keep CLI execution on the supported Node release, never a Bun shebang loader.
import process from 'node:process'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major !== 24 || minor! < 11) throw new Error('Worker tooling requires Node 24.11 or newer in the Node 24 release line.')
