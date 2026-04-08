import type { Database } from '@civup/db'
import { matches } from '@civup/db'
import { asc, eq } from 'drizzle-orm'
import { createChannelMessage, createDmChannel } from '../discord/index.ts'
import { getLobbyByMatch } from '../lobby/index.ts'
import { stateStoreMget } from '../state/store.ts'
import { getCompletedAtFromDraftData, getHostIdFromDraftData, getStoredGameModeContext } from './draft-data.ts'

const REPORT_REMINDER_TTL_SECONDS = 3 * 24 * 60 * 60
const MAX_HOST_REPORT_REMINDERS_PER_RUN = 4

const REPORT_REMINDER_STAGES = [
  {
    key: '3h',
    delayMs: 3 * 60 * 60 * 1000,
    introPrefix: 'Reminder: you have an unreported',
  },
  {
    key: '6h',
    delayMs: 6 * 60 * 60 * 1000,
    introPrefix: 'Reminder: you still have an unreported',
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
      gameMode: matches.gameMode,
      draftData: matches.draftData,
    })
    .from(matches)
    .where(eq(matches.status, 'active'))
    .orderBy(asc(matches.createdAt), asc(matches.id))

  let attemptedCount = 0
  let sentCount = 0

  for (const match of activeMatches) {
    if (attemptedCount >= MAX_HOST_REPORT_REMINDERS_PER_RUN) break

    const completedAt = getCompletedAtFromDraftData(match.draftData)
    const hostId = getHostIdFromDraftData(match.draftData)
    if (completedAt == null || !hostId) continue

    const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
    if (!gameContext) continue

    const pendingStage = await resolvePendingReminderStage(kv, match.id, now - completedAt)
    if (!pendingStage) continue

    attemptedCount += 1

    try {
      const reportLink = await getMatchReportLink(kv, match.id)
      await sendReminderDm(token, hostId, buildReminderContent(pendingStage.introPrefix, gameContext.label, reportLink))
      await markReminderStagesThrough(kv, match.id, pendingStage.key)
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
  const reminderStates = await stateStoreMget(kv, REPORT_REMINDER_STAGES.map(stage => ({
    key: reminderKey(matchId, stage.key),
  })))
  let pendingStage: (typeof REPORT_REMINDER_STAGES)[number] | null = null

  for (let index = 0; index < REPORT_REMINDER_STAGES.length; index++) {
    const stage = REPORT_REMINDER_STAGES[index]
    if (!stage) continue
    if (elapsedMs < stage.delayMs) continue
    if (reminderStates[index]) continue
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

async function sendReminderDm(token: string, hostId: string, content: string): Promise<void> {
  const dm = await createDmChannel(token, hostId)
  await createChannelMessage(token, dm.id, {
    content,
    allowed_mentions: { parse: [] },
  })
}

async function getMatchReportLink(kv: KVNamespace, matchId: string): Promise<string | null> {
  const lobby = await getLobbyByMatch(kv, matchId)
  if (!lobby?.guildId) return null
  return `https://discord.com/channels/${lobby.guildId}/${lobby.channelId}/${lobby.messageId}`
}

function buildReminderContent(introPrefix: string, modeLabel: string, reportLink: string | null): string {
  const intro = `${introPrefix} **${modeLabel}** game.`
  if (!reportLink) return `${intro} Don't forget to report it.`
  return `${intro} Don't forget to report it: ${reportLink}`
}
