export interface UsageLimits {
  workersRequests: number
  d1RowsRead: number
  d1RowsWritten: number
  doSqliteRowsRead: number
  doSqliteRowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

export interface PerDraftUsage {
  workersRequests: number
  d1RowsReadBase: number
  d1RowsReadPerLeaderboardPlayer: number
  d1RowsWritten: number
  doSqliteRowsRead: number
  doSqliteRowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

export interface DailyUsage {
  workersRequests: number
  d1RowsRead: number
  d1RowsWritten: number
  doSqliteRowsRead: number
  doSqliteRowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

export interface CapacityModel {
  perDraft: PerDraftUsage
}

export interface MetricBreakpoint {
  metric: keyof UsageLimits
  playsPerDay: number
  draftsPerDay1v1: number
  limit: number
  usageAtBreakpoint: number
}

export type OverageRatesPerMillion = Partial<Record<keyof UsageLimits, number>>

export function estimateDailyUsage(
  model: CapacityModel,
  playsPerDay: number,
  playersPerDraft: number,
): DailyUsage {
  const draftsPerDay = playsPerDay / playersPerDraft
  const d1RowsReadPerDraft = model.perDraft.d1RowsReadBase + model.perDraft.d1RowsReadPerLeaderboardPlayer * playsPerDay

  return {
    workersRequests: Math.ceil(draftsPerDay * model.perDraft.workersRequests),
    d1RowsRead: Math.ceil(draftsPerDay * d1RowsReadPerDraft),
    d1RowsWritten: Math.ceil(draftsPerDay * model.perDraft.d1RowsWritten),
    doSqliteRowsRead: Math.ceil(draftsPerDay * model.perDraft.doSqliteRowsRead),
    doSqliteRowsWritten: Math.ceil(draftsPerDay * model.perDraft.doSqliteRowsWritten),
    kvReads: Math.ceil(draftsPerDay * model.perDraft.kvReads),
    kvWrites: Math.ceil(draftsPerDay * model.perDraft.kvWrites),
    kvDeletes: Math.ceil(draftsPerDay * model.perDraft.kvDeletes),
    kvLists: Math.ceil(draftsPerDay * model.perDraft.kvLists),
    doRequests: Math.ceil(draftsPerDay * model.perDraft.doRequests),
    doDurationGbSeconds: Math.ceil(draftsPerDay * model.perDraft.doDurationGbSeconds),
  }
}

export function multiplyUsage(usage: DailyUsage, days: number): DailyUsage {
  return {
    workersRequests: usage.workersRequests * days,
    d1RowsRead: usage.d1RowsRead * days,
    d1RowsWritten: usage.d1RowsWritten * days,
    doSqliteRowsRead: usage.doSqliteRowsRead * days,
    doSqliteRowsWritten: usage.doSqliteRowsWritten * days,
    kvReads: usage.kvReads * days,
    kvWrites: usage.kvWrites * days,
    kvDeletes: usage.kvDeletes * days,
    kvLists: usage.kvLists * days,
    doRequests: usage.doRequests * days,
    doDurationGbSeconds: usage.doDurationGbSeconds * days,
  }
}

export function findMaxPlaysPerDay(input: {
  model: CapacityModel
  limits: UsageLimits
  periodDays: number
  playersPerDraft: number
}): number {
  let low = 0
  let high = 200_000

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const daily = estimateDailyUsage(input.model, mid, input.playersPerDraft)
    const usage = input.periodDays === 1 ? daily : multiplyUsage(daily, input.periodDays)

    if (fitsLimits(usage, input.limits)) {
      low = mid
    }
    else {
      high = mid - 1
    }
  }

  return low
}

export function findMetricBreakpoints(input: {
  model: CapacityModel
  limits: UsageLimits
  periodDays: number
  playersPerDraft: number
}): MetricBreakpoint[] {
  const metrics = Object.keys(input.limits) as (keyof UsageLimits)[]

  return metrics
    .map((metric) => {
      const playsPerDay = findMaxPlaysPerDayByMetric({
        model: input.model,
        metric,
        limit: input.limits[metric],
        periodDays: input.periodDays,
        playersPerDraft: input.playersPerDraft,
      })
      const daily = estimateDailyUsage(input.model, playsPerDay, input.playersPerDraft)
      const usage = input.periodDays === 1 ? daily : multiplyUsage(daily, input.periodDays)

      return {
        metric,
        playsPerDay,
        draftsPerDay1v1: playsPerDay / input.playersPerDraft,
        limit: input.limits[metric],
        usageAtBreakpoint: usage[metric],
      }
    })
    .sort((a, b) => {
      if (a.playsPerDay === b.playsPerDay) return a.metric.localeCompare(b.metric)
      return a.playsPerDay - b.playsPerDay
    })
}

export function estimateOverageUsd(input: {
  model: CapacityModel
  playsPerDay: number
  limits: UsageLimits
  periodDays: number
  playersPerDraft: number
  overageRatesPerMillion: OverageRatesPerMillion
}): number {
  const daily = estimateDailyUsage(input.model, input.playsPerDay, input.playersPerDraft)
  const usage = input.periodDays === 1 ? daily : multiplyUsage(daily, input.periodDays)
  return estimateOverageUsdForUsage(usage, input.limits, input.overageRatesPerMillion)
}

export function findMaxPlaysPerDayForOverageBudget(input: {
  model: CapacityModel
  limits: UsageLimits
  periodDays: number
  playersPerDraft: number
  overageRatesPerMillion: OverageRatesPerMillion
  overageBudgetUsd: number
}): number {
  const maxCost = Math.max(0, input.overageBudgetUsd)

  const costForPlays = (playsPerDay: number): number => {
    const daily = estimateDailyUsage(input.model, playsPerDay, input.playersPerDraft)
    const usage = input.periodDays === 1 ? daily : multiplyUsage(daily, input.periodDays)
    return estimateOverageUsdForUsage(usage, input.limits, input.overageRatesPerMillion)
  }

  let low = 0
  let high = 1
  const maxHigh = 1_000_000

  while (high < maxHigh && costForPlays(high) <= maxCost) {
    low = high
    high = Math.min(maxHigh, high * 2)
  }

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (costForPlays(mid) <= maxCost) low = mid
    else high = mid - 1
  }

  return low
}

function findMaxPlaysPerDayByMetric(input: {
  model: CapacityModel
  metric: keyof UsageLimits
  limit: number
  periodDays: number
  playersPerDraft: number
}): number {
  let low = 0
  let high = 200_000

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const daily = estimateDailyUsage(input.model, mid, input.playersPerDraft)
    const usage = input.periodDays === 1 ? daily : multiplyUsage(daily, input.periodDays)

    if (usage[input.metric] <= input.limit) {
      low = mid
    }
    else {
      high = mid - 1
    }
  }

  return low
}

function fitsLimits(usage: DailyUsage, limits: UsageLimits): boolean {
  return (
    usage.workersRequests <= limits.workersRequests
    && usage.d1RowsRead <= limits.d1RowsRead
    && usage.d1RowsWritten <= limits.d1RowsWritten
    && usage.doSqliteRowsRead <= limits.doSqliteRowsRead
    && usage.doSqliteRowsWritten <= limits.doSqliteRowsWritten
    && usage.kvReads <= limits.kvReads
    && usage.kvWrites <= limits.kvWrites
    && usage.kvDeletes <= limits.kvDeletes
    && usage.kvLists <= limits.kvLists
    && usage.doRequests <= limits.doRequests
    && usage.doDurationGbSeconds <= limits.doDurationGbSeconds
  )
}

function estimateOverageUsdForUsage(
  usage: DailyUsage,
  limits: UsageLimits,
  overageRatesPerMillion: OverageRatesPerMillion,
): number {
  let total = 0

  const metrics = Object.keys(limits) as (keyof UsageLimits)[]
  for (const metric of metrics) {
    const overage = usage[metric] - limits[metric]
    if (overage <= 0) continue

    const ratePerMillion = overageRatesPerMillion[metric]
    if (typeof ratePerMillion !== 'number' || !Number.isFinite(ratePerMillion) || ratePerMillion < 0) {
      return Number.POSITIVE_INFINITY
    }

    total += (overage / 1_000_000) * ratePerMillion
  }

  return total
}
