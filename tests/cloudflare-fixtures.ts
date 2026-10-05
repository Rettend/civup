import { fileURLToPath } from 'node:url'
import { loadCloudflareLocalTargets } from '../config/cloudflare-targets.ts'

export const fixtureLocalTargetsFile = fileURLToPath(new URL('./cloudflare-targets.fixture.json', import.meta.url))
export const fixtureLocalTargets = loadCloudflareLocalTargets(fixtureLocalTargetsFile)
export const fixtureAlternateTarget = fixtureLocalTargets.alternate!
export const fixtureTargetOptions = { localTargets: fixtureLocalTargets }
