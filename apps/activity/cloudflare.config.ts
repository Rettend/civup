import process from 'node:process'
import { defineConfig } from 'cf/config'
import { resolveCloudflareTarget } from '../../config/cloudflare-targets.ts'
import { createActivityCloudflareConfig } from '../../config/cloudflare-workers.ts'

// Vite owns the client output directory; only asset runtime behavior belongs here.
export default defineConfig(() => createActivityCloudflareConfig(resolveCloudflareTarget(process.env.CIVUP_TARGET, {
  localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE,
})))
