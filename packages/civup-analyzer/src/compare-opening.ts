import type { CivupOpeningReport, CivupOpeningTurnMetric } from './opening-report.ts'

export interface CivupOpeningComparison {
  tool: 'civup-analyzer'
  schemaVersion: 1
  generatedAt: string
  baseline: CivupOpeningComparisonSide
  subject: CivupOpeningComparisonSide
  turnRange: { from: number, to: number }
  summary: CivupOpeningComparisonSummary
  biggestGaps: CivupOpeningGap[]
  recommendations: string[]
  keyTurns: CivupOpeningTurnComparison[]
  cityTimings: CivupOpeningCityTimingComparison[]
  progressionTimings: {
    tech: CivupOpeningHashTimingComparison[]
    civic: CivupOpeningHashTimingComparison[]
  }
}

export interface CivupOpeningComparisonSide {
  source: string
  player: string
}

export interface CivupOpeningComparisonSummary {
  end: CivupOpeningMetricDelta | null
  cityTimingAverageDelta: number | null
  techsAhead: number
  techsBehind: number
  techsOnlyBaseline: number
  techsOnlySubject: number
  civicsAhead: number
  civicsBehind: number
  civicsOnlyBaseline: number
  civicsOnlySubject: number
}

export interface CivupOpeningGap {
  severity: 'high' | 'medium' | 'low'
  score: number
  category: string
  turn: number | null
  title: string
  detail: string
}

export interface CivupOpeningMetricDelta {
  turn: number | null
  cityCount: number
  population: number
  districtCount: number
  unitCount: number
  governorCount: number
  improvementCount: number
  gold: number | null
  faith: number | null
  maintenance: number | null
  cityReligionCount: number
  yields: Record<string, number>
  knownTradeRouteYields: Record<string, number>
  knownTradeRouteScience: number | null
  knownTradeRouteCulture: number | null
  techBoostedCount: number
  techCompletedCount: number
  civicBoostedCount: number
  civicCompletedCount: number
  cityFoundedCount: number
  productionChangedCount: number
  cityBuiltItemCompletedCount: number
  governmentChangedCount: number
  goodyHutCategoryCountChangedCount: number
  pantheonChangedCount: number
  cityReligionChangedCount: number
  districtPlacedCount: number
  districtBuiltCount: number
  unitCreatedCount: number
  unitLostCount: number
  unitUpgradedCount: number
  governorAssignedCount: number
  governorPromotedCount: number
  tileImprovementChangedCount: number
}

export interface CivupOpeningTurnComparison {
  turn: number
  baseline: CivupOpeningTurnMetric | null
  subject: CivupOpeningTurnMetric | null
  delta: CivupOpeningMetricDelta | null
}

export interface CivupOpeningCityTimingComparison {
  cityNumber: number
  baseline: CivupOpeningCityTiming | null
  subject: CivupOpeningCityTiming | null
  deltaTurns: number | null
}

export interface CivupOpeningCityTiming {
  turn: number | null
  name: string
}

export interface CivupOpeningHashTimingComparison {
  hash: number
  name: string
  baselineTurn: number | null
  subjectTurn: number | null
  deltaTurns: number | null
}

export function compareOpeningReports(baseline: CivupOpeningReport, subject: CivupOpeningReport): CivupOpeningComparison {
  const turnRange = {
    from: Math.max(baseline.turnRange.from, subject.turnRange.from),
    to: Math.min(baseline.turnRange.to, subject.turnRange.to),
  }
  const keyTurns = pickComparisonTurns(baseline, subject).map(turn => {
    const baselineTurn = findTurnAtOrBefore(baseline.turns, turn)
    const subjectTurn = findTurnAtOrBefore(subject.turns, turn)
    return {
      turn,
      baseline: baselineTurn,
      subject: subjectTurn,
      delta: baselineTurn && subjectTurn ? diffTurnMetrics(baselineTurn, subjectTurn) : null,
    }
  })
  const baselineEnd = findTurnAtOrBefore(baseline.turns, turnRange.to)
  const subjectEnd = findTurnAtOrBefore(subject.turns, turnRange.to)
  const cityTimings = compareCityTimings(baseline, subject)
  const tech = compareProgressionTimings(baseline, subject, 'techCompleted')
  const civic = compareProgressionTimings(baseline, subject, 'civicCompleted')
  const biggestGaps = buildOpeningGaps(keyTurns, cityTimings, tech, civic, baselineEnd && subjectEnd ? diffTurnMetrics(baselineEnd, subjectEnd) : null)
  return {
    tool: 'civup-analyzer',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseline: { source: baseline.source, player: formatPlayer(baseline) },
    subject: { source: subject.source, player: formatPlayer(subject) },
    turnRange,
    summary: {
      end: baselineEnd && subjectEnd ? diffTurnMetrics(baselineEnd, subjectEnd) : null,
      cityTimingAverageDelta: averageDelta(cityTimings.map(item => item.deltaTurns)),
      techsAhead: tech.filter(item => item.deltaTurns != null && item.deltaTurns < 0).length,
      techsBehind: tech.filter(item => item.deltaTurns != null && item.deltaTurns > 0).length,
      techsOnlyBaseline: tech.filter(item => item.baselineTurn != null && item.subjectTurn == null).length,
      techsOnlySubject: tech.filter(item => item.baselineTurn == null && item.subjectTurn != null).length,
      civicsAhead: civic.filter(item => item.deltaTurns != null && item.deltaTurns < 0).length,
      civicsBehind: civic.filter(item => item.deltaTurns != null && item.deltaTurns > 0).length,
      civicsOnlyBaseline: civic.filter(item => item.baselineTurn != null && item.subjectTurn == null).length,
      civicsOnlySubject: civic.filter(item => item.baselineTurn == null && item.subjectTurn != null).length,
    },
    biggestGaps,
    recommendations: buildRecommendations(biggestGaps),
    keyTurns,
    cityTimings,
    progressionTimings: { tech, civic },
  }
}

export function formatOpeningComparisonSummary(comparison: CivupOpeningComparison): string {
  const lines: string[] = []
  lines.push('CivUp Opening Comparison')
  lines.push(`baseline: ${comparison.baseline.player} | ${comparison.baseline.source}`)
  lines.push(`subject: ${comparison.subject.player} | ${comparison.subject.source}`)
  lines.push('deltas: subject minus baseline; negative timing means subject is earlier')

  if (comparison.summary.end) {
    const end = comparison.summary.end
    lines.push('')
    lines.push(`End delta: cities ${formatSigned(end.cityCount)}, pop ${formatSigned(end.population)}, districts ${formatSigned(end.districtCount)}, units ${formatSigned(end.unitCount)}, improvements ${formatSigned(end.improvementCount)}, techs ${formatSigned(end.techCompletedCount)} completed/${formatSigned(end.techBoostedCount)} boosted, civics ${formatSigned(end.civicCompletedCount)} completed/${formatSigned(end.civicBoostedCount)} boosted, gold ${formatNullableSigned(end.gold)}, faith ${formatNullableSigned(end.faith)}, known route S/C ${formatNullableSigned(end.knownTradeRouteScience)}/${formatNullableSigned(end.knownTradeRouteCulture)}`)
  }

  lines.push('')
  lines.push('Biggest Gaps')
  if (comparison.biggestGaps.length === 0) lines.push('  no major gaps detected')
  for (const gap of comparison.biggestGaps) lines.push(`  ${gap.severity}: ${gap.title}${gap.turn == null ? '' : ` by T${gap.turn}`} - ${gap.detail}`)

  if (comparison.recommendations.length > 0) {
    lines.push('')
    lines.push('Recommendations')
    for (const recommendation of comparison.recommendations) lines.push(`  ${recommendation}`)
  }

  lines.push('')
  lines.push('Key Turns')
  for (const item of comparison.keyTurns) {
    if (!item.delta) {
      lines.push(`  T${item.turn}: missing ${item.baseline ? 'subject' : 'baseline'} data`)
      continue
    }
    const delta = item.delta
    lines.push(`  T${item.turn}: cities ${formatSigned(delta.cityCount)}, pop ${formatSigned(delta.population)}, districts ${formatSigned(delta.districtCount)}, units ${formatSigned(delta.unitCount)}, improvements ${formatSigned(delta.improvementCount)}, techs ${formatSigned(delta.techCompletedCount)} completed/${formatSigned(delta.techBoostedCount)} boosted, civics ${formatSigned(delta.civicCompletedCount)} completed/${formatSigned(delta.civicBoostedCount)} boosted, yields ${formatYieldDeltas(delta.yields)}, known route yields ${formatYieldDeltas(delta.knownTradeRouteYields)}`)
  }

  lines.push('')
  lines.push('City Timings')
  if (comparison.cityTimings.length === 0) lines.push('  none')
  for (const item of comparison.cityTimings) {
    const baseline = item.baseline ? `T${item.baseline.turn ?? '?'} ${item.baseline.name}` : '-'
    const subject = item.subject ? `T${item.subject.turn ?? '?'} ${item.subject.name}` : '-'
    lines.push(`  city ${item.cityNumber}: ${subject} vs ${baseline} (${formatNullableSigned(item.deltaTurns)} turns)`)
  }

  lines.push('')
  lines.push(`Progression: techs earlier ${comparison.summary.techsAhead}, later ${comparison.summary.techsBehind}, subject-only ${comparison.summary.techsOnlySubject}, baseline-only ${comparison.summary.techsOnlyBaseline}; civics earlier ${comparison.summary.civicsAhead}, later ${comparison.summary.civicsBehind}, subject-only ${comparison.summary.civicsOnlySubject}, baseline-only ${comparison.summary.civicsOnlyBaseline}`)
  appendProgressionLines(lines, 'Tech Timing', comparison.progressionTimings.tech)
  appendProgressionLines(lines, 'Civic Timing', comparison.progressionTimings.civic)
  return `${lines.join('\n')}\n`
}

function pickComparisonTurns(baseline: CivupOpeningReport, subject: CivupOpeningReport): number[] {
  const minTurn = Math.max(baseline.turnRange.from, subject.turnRange.from)
  const maxTurn = Math.min(baseline.turnRange.to, subject.turnRange.to)
  const turns = new Set<number>()
  for (const turn of [10, 20, 30, 40, 50]) if (turn >= minTurn && turn <= maxTurn) turns.add(turn)
  if (maxTurn > 50) turns.add(maxTurn)
  return [...turns].sort((left, right) => left - right)
}

function findTurnAtOrBefore(turns: readonly CivupOpeningTurnMetric[], target: number): CivupOpeningTurnMetric | null {
  return turns.find(turn => turn.turn === target) ?? turns.findLast(turn => turn.turn != null && turn.turn <= target) ?? null
}

function diffTurnMetrics(baseline: CivupOpeningTurnMetric, subject: CivupOpeningTurnMetric): CivupOpeningMetricDelta {
  return {
    turn: subject.turn,
    cityCount: subject.cityCount - baseline.cityCount,
    population: subject.population - baseline.population,
    districtCount: subject.districtCount - baseline.districtCount,
    unitCount: subject.unitCount - baseline.unitCount,
    governorCount: subject.governorCount - baseline.governorCount,
    improvementCount: subject.improvementCount - baseline.improvementCount,
    gold: diffNullable(baseline.gold, subject.gold),
    faith: diffNullable(baseline.faith, subject.faith),
    maintenance: diffNullable(baseline.maintenance, subject.maintenance),
    cityReligionCount: (subject.cityReligionCount ?? 0) - (baseline.cityReligionCount ?? 0),
    yields: diffYields(baseline.yields, subject.yields),
    knownTradeRouteYields: diffYields(baseline.knownTradeRouteYields, subject.knownTradeRouteYields),
    knownTradeRouteScience: diffNullable(baseline.knownTradeRouteScience, subject.knownTradeRouteScience),
    knownTradeRouteCulture: diffNullable(baseline.knownTradeRouteCulture, subject.knownTradeRouteCulture),
    techBoostedCount: (subject.techBoostedCount ?? 0) - (baseline.techBoostedCount ?? 0),
    techCompletedCount: (subject.techCompletedCount ?? 0) - (baseline.techCompletedCount ?? 0),
    civicBoostedCount: (subject.civicBoostedCount ?? 0) - (baseline.civicBoostedCount ?? 0),
    civicCompletedCount: (subject.civicCompletedCount ?? 0) - (baseline.civicCompletedCount ?? 0),
    cityFoundedCount: subject.cityFoundedCount - baseline.cityFoundedCount,
    productionChangedCount: subject.productionChangedCount - baseline.productionChangedCount,
    cityBuiltItemCompletedCount: (subject.cityBuiltItemCompletedCount ?? 0) - (baseline.cityBuiltItemCompletedCount ?? 0),
    governmentChangedCount: (subject.governmentChangedCount ?? 0) - (baseline.governmentChangedCount ?? 0),
    goodyHutCategoryCountChangedCount: (subject.goodyHutCategoryCountChangedCount ?? 0) - (baseline.goodyHutCategoryCountChangedCount ?? 0),
    pantheonChangedCount: (subject.pantheonChangedCount ?? 0) - (baseline.pantheonChangedCount ?? 0),
    cityReligionChangedCount: (subject.cityReligionChangedCount ?? 0) - (baseline.cityReligionChangedCount ?? 0),
    districtPlacedCount: subject.districtPlacedCount - baseline.districtPlacedCount,
    districtBuiltCount: subject.districtBuiltCount - baseline.districtBuiltCount,
    unitCreatedCount: subject.unitCreatedCount - baseline.unitCreatedCount,
    unitLostCount: subject.unitLostCount - baseline.unitLostCount,
    unitUpgradedCount: subject.unitUpgradedCount - baseline.unitUpgradedCount,
    governorAssignedCount: subject.governorAssignedCount - baseline.governorAssignedCount,
    governorPromotedCount: subject.governorPromotedCount - baseline.governorPromotedCount,
    tileImprovementChangedCount: subject.tileImprovementChangedCount - baseline.tileImprovementChangedCount,
  }
}

function buildOpeningGaps(
  keyTurns: readonly CivupOpeningTurnComparison[],
  cityTimings: readonly CivupOpeningCityTimingComparison[],
  tech: readonly CivupOpeningHashTimingComparison[],
  civic: readonly CivupOpeningHashTimingComparison[],
  endDelta: CivupOpeningMetricDelta | null,
): CivupOpeningGap[] {
  const gaps: CivupOpeningGap[] = []
  for (const item of keyTurns) {
    if (!item.delta) continue
    addMetricGap(gaps, 'expansion', item.turn, 'city count', item.delta.cityCount, 1, 18)
    addMetricGap(gaps, 'growth', item.turn, 'population', item.delta.population, 4, 2)
    addMetricGap(gaps, 'districts', item.turn, 'district count', item.delta.districtCount, 3, 3)
    addYieldGap(gaps, item.turn, item.delta.yields, 'YIELD_PRODUCTION', 'production', 12, 0.8)
    addYieldGap(gaps, item.turn, item.delta.yields, 'YIELD_CULTURE', 'culture', 6, 1.2)
    addYieldGap(gaps, item.turn, item.delta.yields, 'YIELD_SCIENCE', 'science', 6, 1.2)
    addYieldGap(gaps, item.turn, item.delta.yields, 'YIELD_FOOD', 'food', 12, 0.7)
  }
  if (endDelta) {
    addMetricGap(gaps, 'end-state', endDelta.turn, 'final cities', endDelta.cityCount, 1, 20)
    addMetricGap(gaps, 'end-state', endDelta.turn, 'final population', endDelta.population, 5, 2)
    addMetricGap(gaps, 'end-state', endDelta.turn, 'final districts', endDelta.districtCount, 4, 3)
    addMetricGap(gaps, 'end-state', endDelta.turn, 'final improvements', endDelta.improvementCount, 20, 0.4)
  }
  for (const item of cityTimings) {
    if (item.baseline && !item.subject) {
      gaps.push({ severity: 'high', score: 24, category: 'expansion', turn: item.baseline.turn, title: `missing city ${item.cityNumber}`, detail: `baseline founded ${item.baseline.name} on T${item.baseline.turn ?? '?'}` })
      continue
    }
    if (item.deltaTurns != null && item.deltaTurns > 0) {
      gaps.push({ severity: item.deltaTurns >= 8 ? 'high' : 'medium', score: 10 + item.deltaTurns, category: 'expansion', turn: item.subject?.turn ?? item.baseline?.turn ?? null, title: `city ${item.cityNumber} is late`, detail: `${formatSigned(item.deltaTurns)} turns later than baseline` })
    }
  }
  addProgressionGaps(gaps, 'tech', tech)
  addProgressionGaps(gaps, 'civic', civic)
  return gaps.sort(compareGaps).slice(0, 8)
}

function addMetricGap(gaps: CivupOpeningGap[], category: string, turn: number | null, label: string, delta: number, threshold: number, weight: number) {
  if (delta >= -threshold) return
  const amount = Math.abs(delta)
  gaps.push({
    severity: amount >= threshold * 2 ? 'high' : 'medium',
    score: amount * weight,
    category,
    turn,
    title: `${label} behind`,
    detail: `${formatSigned(delta)} versus baseline`,
  })
}

function addYieldGap(gaps: CivupOpeningGap[], turn: number | null, yields: Record<string, number>, key: string, label: string, threshold: number, weight: number) {
  const delta = yields[key] ?? 0
  if (delta >= -threshold) return
  const amount = Math.abs(delta)
  gaps.push({
    severity: amount >= threshold * 2 ? 'high' : 'medium',
    score: amount * weight,
    category: label,
    turn,
    title: `${label} yield behind`,
    detail: `${formatSigned(delta)} per turn versus baseline`,
  })
}

function addProgressionGaps(gaps: CivupOpeningGap[], category: 'tech' | 'civic', timings: readonly CivupOpeningHashTimingComparison[]) {
  for (const item of timings) {
    if (item.baselineTurn != null && item.subjectTurn == null) {
      gaps.push({ severity: item.baselineTurn <= 35 ? 'high' : 'medium', score: 18, category, turn: item.baselineTurn, title: `${category} missing: ${item.name}`, detail: `baseline completed this by T${item.baselineTurn}` })
      continue
    }
    if (item.deltaTurns != null && item.deltaTurns >= 4) {
      gaps.push({ severity: item.deltaTurns >= 8 ? 'high' : 'medium', score: 8 + item.deltaTurns, category, turn: item.subjectTurn, title: `${category} late: ${item.name}`, detail: `${formatSigned(item.deltaTurns)} turns later than baseline` })
    }
  }
}

function buildRecommendations(gaps: readonly CivupOpeningGap[]): string[] {
  if (gaps.length === 0) return ['No major gaps detected in the compared opening window.']
  const categories = new Set(gaps.map(gap => gap.category))
  const recommendations: string[] = []
  if (categories.has('expansion') || categories.has('end-state')) recommendations.push('Prioritize earlier settlers and city timing; expansion gaps compound into population, district, and yield gaps by turn 50.')
  if (categories.has('production')) recommendations.push('Recover production earlier with builders, chops, mines, and earlier production districts where the map supports them.')
  if (categories.has('culture') || categories.has('civic')) recommendations.push('Close culture tempo first when civics are late; early monuments, culture tiles, and inspirations usually unlock the strongest policy timing gains.')
  if (categories.has('science') || categories.has('tech')) recommendations.push('Target the missing or delayed tech boosts before hard-researching; delayed boosted techs are usually fixable with timing rather than raw science alone.')
  if (categories.has('districts')) recommendations.push('Place key districts earlier when costs are lower, then finish the ones that unlock economy or timing boosts.')
  if (categories.has('growth') || categories.has('food')) recommendations.push('Fix growth bottlenecks with housing, food tiles, and builder charges before the turn-40 acceleration window.')
  return recommendations.slice(0, 5)
}

function compareGaps(left: CivupOpeningGap, right: CivupOpeningGap): number {
  return severityScore(right.severity) - severityScore(left.severity) || right.score - left.score || compareNullableTurns(left.turn, right.turn)
}

function severityScore(severity: CivupOpeningGap['severity']): number {
  if (severity === 'high') return 3
  if (severity === 'medium') return 2
  return 1
}

function compareCityTimings(baseline: CivupOpeningReport, subject: CivupOpeningReport): CivupOpeningCityTimingComparison[] {
  const baselineCities = baseline.milestones.citiesFounded.map(event => ({ turn: event.turn, name: event.name }))
  const subjectCities = subject.milestones.citiesFounded.map(event => ({ turn: event.turn, name: event.name }))
  const count = Math.max(baselineCities.length, subjectCities.length)
  return Array.from({ length: count }, (_, index) => {
    const baselineCity = baselineCities[index] ?? null
    const subjectCity = subjectCities[index] ?? null
    return {
      cityNumber: index + 1,
      baseline: baselineCity,
      subject: subjectCity,
      deltaTurns: baselineCity?.turn != null && subjectCity?.turn != null ? subjectCity.turn - baselineCity.turn : null,
    }
  })
}

function compareProgressionTimings(
  baseline: CivupOpeningReport,
  subject: CivupOpeningReport,
  type: 'techCompleted' | 'civicCompleted',
): CivupOpeningHashTimingComparison[] {
  const baselineTurns = new Map<number, number | null>()
  const subjectTurns = new Map<number, number | null>()
  const baselineEvents = type === 'techCompleted' ? baseline.milestones.techCompleted : baseline.milestones.civicCompleted
  const subjectEvents = type === 'techCompleted' ? subject.milestones.techCompleted : subject.milestones.civicCompleted
  for (const event of baselineEvents) if (!baselineTurns.has(event.hash)) baselineTurns.set(event.hash, event.turn)
  for (const event of subjectEvents) if (!subjectTurns.has(event.hash)) subjectTurns.set(event.hash, event.turn)
  const hashes = new Set([...baselineTurns.keys(), ...subjectTurns.keys()])
  return [...hashes]
    .map(hash => {
      const baselineTurn = baselineTurns.get(hash) ?? null
      const subjectTurn = subjectTurns.get(hash) ?? null
      return {
        hash,
        name: subject.hashNames[String(hash)] ?? baseline.hashNames[String(hash)] ?? formatHash(hash),
        baselineTurn,
        subjectTurn,
        deltaTurns: baselineTurn != null && subjectTurn != null ? subjectTurn - baselineTurn : null,
      }
    })
    .sort((left, right) => compareNullableTurns(left.baselineTurn, right.baselineTurn) || left.name.localeCompare(right.name))
}

function appendProgressionLines(lines: string[], title: string, timings: readonly CivupOpeningHashTimingComparison[]) {
  const changed = timings.filter(item => item.deltaTurns !== 0 || item.baselineTurn == null || item.subjectTurn == null).slice(0, 12)
  if (changed.length === 0) return
  lines.push('')
  lines.push(title)
  for (const item of changed) lines.push(`  ${item.name}: subject T${item.subjectTurn ?? '?'} vs baseline T${item.baselineTurn ?? '?'} (${formatTimingDelta(item)})`)
}

function formatTimingDelta(item: CivupOpeningHashTimingComparison): string {
  if (item.baselineTurn == null && item.subjectTurn != null) return 'subject only'
  if (item.baselineTurn != null && item.subjectTurn == null) return 'baseline only'
  return `${formatNullableSigned(item.deltaTurns)} turns`
}

function formatPlayer(report: CivupOpeningReport): string {
  return [report.player.playerName, report.player.leader, report.player.civilization].filter(Boolean).join(' | ') || `player ${report.player.id}`
}

function diffNullable(baseline: number | null, subject: number | null): number | null {
  return baseline == null || subject == null ? null : subject - baseline
}

function diffYields(baseline: Record<string, number>, subject: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(subject)])
  return Object.fromEntries([...keys].sort().map(key => [key, (subject[key] ?? 0) - (baseline[key] ?? 0)]))
}

function averageDelta(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value != null)
  if (present.length === 0) return null
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

function compareNullableTurns(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return left - right
}

function formatHash(hash: number): string {
  return `0x${hash.toString(16).padStart(8, '0')}`
}

function formatSigned(value: number): string {
  if (value > 0) return `+${formatNumber(value)}`
  return formatNumber(value)
}

function formatNullableSigned(value: number | null): string {
  return value == null ? '?' : formatSigned(value)
}

function formatYieldDeltas(yields: Record<string, number>): string {
  const preferred = ['YIELD_FOOD', 'YIELD_PRODUCTION', 'YIELD_SCIENCE', 'YIELD_CULTURE', 'YIELD_GOLD', 'YIELD_FAITH']
  const parts = preferred.filter(key => yields[key] != null).map(key => `${key.replace('YIELD_', '').toLowerCase()} ${formatSigned(yields[key]!)}`)
  return parts.join(', ') || 'none'
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
