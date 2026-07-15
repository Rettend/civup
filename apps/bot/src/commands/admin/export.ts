import type { AdminCommandContext } from './types.ts'
import { isActivityDataAdmin } from '../../services/activity/data-admin.ts'
import { getInteractionUserId } from './shared.ts'

export function handleExport(c: AdminCommandContext) {
  const userId = getInteractionUserId(c)
  const message = userId && isActivityDataAdmin(c.env, userId)
    ? 'Open CivUp and use Player Data at the bottom of the lobby overview to export the workbook.'
    : 'Player Data export moved to CivUp and is limited to configured Activity data admins.'
  return c.flags('EPHEMERAL').res(message)
}
