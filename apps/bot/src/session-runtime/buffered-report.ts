import type { Database } from '@civup/db'
import type { ReportInput } from '../services/match/types.ts'
import { bufferedReportDirectory, ratingMutationLeases } from '@civup/db'
import { and, eq, inArray } from 'drizzle-orm'

export const BUFFERED_REPORT_KEY = 'buffered-report'

export interface BufferedSessionReport {
  id: string
  input: ReportInput
  seasonId: string | null
  matchCreatedAt: number
  acceptedAt: number
  completedAt: number | null
  projected: boolean
  publicationLeaseIds: string[]
}

/** SessionDO serializes callers; one storage write durably accepts the complete result. */
export async function saveBufferedSessionReport(storage: DurableObjectStorage, db: Database, input: Omit<BufferedSessionReport, 'id' | 'completedAt' | 'projected' | 'publicationLeaseIds'>, publicationLeaseId: string): Promise<BufferedSessionReport> {
  const existing = await storage.get<BufferedSessionReport>(BUFFERED_REPORT_KEY)
  const report: BufferedSessionReport = existing
    ? { ...existing, projected: false, publicationLeaseIds: [...new Set([...existing.publicationLeaseIds, publicationLeaseId])] }
    : { ...input, id: crypto.randomUUID(), completedAt: null, projected: false, publicationLeaseIds: [publicationLeaseId] }
  await storage.put(BUFFERED_REPORT_KEY, report)
  await projectBufferedSessionReport(storage, db, report)
  return report
}

export async function projectBufferedSessionReport(storage: DurableObjectStorage, db: Database, report: BufferedSessionReport): Promise<void> {
  if (report.completedAt == null) {
    await db.insert(bufferedReportDirectory).values({ matchId: report.input.matchId, reportId: report.id, acceptedAt: report.acceptedAt })
      .onConflictDoUpdate({ target: bufferedReportDirectory.matchId, set: { reportId: report.id, acceptedAt: report.acceptedAt } })
  }
  else {
    await db.delete(bufferedReportDirectory).where(and(eq(bufferedReportDirectory.matchId, report.input.matchId), eq(bufferedReportDirectory.reportId, report.id)))
  }
  for (let offset = 0; offset < report.publicationLeaseIds.length; offset += 80) {
    await db.delete(ratingMutationLeases).where(and(inArray(ratingMutationLeases.id, report.publicationLeaseIds.slice(offset, offset + 80)),
      eq(ratingMutationLeases.kind, 'buffer'), eq(ratingMutationLeases.matchId, report.input.matchId)))
  }
  await storage.put(BUFFERED_REPORT_KEY, { ...report, projected: true, publicationLeaseIds: [] })
}
