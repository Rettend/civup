import type { Database } from '@civup/db'
import { matches } from '@civup/db'
import { eq } from 'drizzle-orm'
import { createChannelMessage, createDmChannel } from '../discord/index.ts'
import { getCompletedAtFromDraftData, getHostIdFromDraftData } from './draft-data.ts'

const REPORT_REMINDER_TTL_SECONDS = 3 * 24 * 60 * 60

const REPORT_REMINDER_STAGES = [
  {
    key: '3h',
    delayMs: 3 * 60 * 60 * 1000,
    content: "Reminder: you have an unreported game. Don't forget to report it.",
  },
  {
    key: '6h',
    delayMs: 6 * 60 * 60 * 1000,
    content: "Reminder: you still have an unreported game. Don't forget to report it.",
  },
] as const

export interface HostReportReminderResult {
  attemptedCount: number
  sentCount: number
}

export async function sendOverdueHostReportReminders(
  db: Database,
  kv: KVNamespace,
  token: string,
  options: {
    now?: number
  } = {},
): Promise<HostReportReminderResult> {
  const now = options.now ?? Date.now()
  const activeMatches = await db
    .select({
      id: matches.id,
      draftData: matches.draftData,
    })
    .from(matches)
    .where(eq(matches.status, 'active'))

  let attemptedCount = 0
  let sentCount = 0

  for (const match of activeMatches) {
    const completedAt = getCompletedAtFromDraftData(match.draftData)
    const hostId = getHostIdFromDraftData(match.draftData)
    if (completedAt == null || !hostId) continue

    const pendingStage = await resolvePendingReminderStage(kv, match.id, now - completedAt)
    if (!pendingStage) continue

    attemptedCount += 1
    await markReminderStagesThrough(kv, match.id, pendingStage.key)

    try {
      const dm = await createDmChannel(token, hostId)
      await createChannelMessage(token, dm.id, {
        content: pendingStage.content,
        allowed_mentions: { parse: [] },
      })
      sentCount += 1
    }
    catch (error) {
      console.error(`[cron] Failed to send host report reminder for match ${match.id}:`, error)
    }
  }

  return { attemptedCount, sentCount }
}

async function resolvePendingReminderStage(
  kv: KVNamespace,
  matchId: string,
  elapsedMs: number,
): Promise<(typeof REPORT_REMINDER_STAGES)[number] | null> {
  let pendingStage: (typeof REPORT_REMINDER_STAGES)[number] | null = null

  for (const stage of REPORT_REMINDER_STAGES) {
    if (elapsedMs < stage.delayMs) continue
    if (await kv.get(reminderKey(matchId, stage.key))) continue
    pendingStage = stage
  }

  return pendingStage
}

async function markReminderStagesThrough(
  kv: KVNamespace,
  matchId: string,
  stageKey: (typeof REPORT_REMINDER_STAGES)[number]['key'],
): Promise<void> {
  for (const stage of REPORT_REMINDER_STAGES) {
    await kv.put(reminderKey(matchId, stage.key), '1', { expirationTtl: REPORT_REMINDER_TTL_SECONDS })
    if (stage.key === stageKey) return
  }
}

function reminderKey(matchId: string, stage: (typeof REPORT_REMINDER_STAGES)[number]['key']): string {
  return `match-report-reminder:${stage}:${matchId}`
}
