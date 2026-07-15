import type { AdminCommandContext } from './types.ts'

export function handleExport(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').res('Open CivUp and use Player Data at the bottom of the lobby overview to export the workbook.')
}
