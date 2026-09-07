import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { calculateRatings, calculatePublicRatingTransition, calibratePublicRatings, createRating, publicRatingRank, publicRatingTarget, PUBLIC_RATING_FORMULA_VERSION, PUBLIC_RATING_START } from '@civup/rating'
import type { SeasonOpeningInput } from '../src/services/season/opening.ts'
import { prepareSeasonOpening } from '../src/services/season/opening.ts'

function options(args: string[]) {
  const values = new Map<string, string>()
  let synthetic = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--synthetic') { synthetic = true; continue }
    if (!['--input', '--output'].includes(arg) || !args[index + 1] || args[index + 1]!.startsWith('--') || values.has(arg)) throw new Error('Use --synthetic OR --input snapshot.json, and --output report.json. This tool has no remote or execute mode.')
    values.set(arg, args[++index]!)
  }
  if (synthetic === values.has('--input') || !values.has('--output')) throw new Error('Choose exactly one of --synthetic or --input, and provide --output.')
  return { synthetic, input: values.get('--input'), output: values.get('--output')! }
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (p: number) => sorted[Math.round((sorted.length - 1) * p)] ?? null
  return { count: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null, p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9) }
}

export function simulateCandidatePublicRatings(samples = 40) {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000) throw new Error('Invalid sample count.')
  let randomState = 90210
  const random = () => {
    randomState ^= randomState << 13
    randomState ^= randomState >>> 17
    randomState ^= randomState << 5
    return (randomState >>> 0) / 0x100000000
  }
  const calibration = calibratePublicRatings({ version: 'synthetic-v1', scope: 'global', sourceDigest: 'synthetic-not-production', qualifiedHiddenScores: Array.from({ length: 101 }, (_, index) => 5 + index * 0.4) })
  const rows = []
  let transitions = 0
  for (const format of ['duel', 'duo', 'squad', 'ffa'] as const) {
    for (const source of ['live', 'imported', 'mixed'] as const) {
      for (const ability of [12, 22, 30, 37, 45]) {
        const movement = new Map<string, number[]>()
        const atGames = new Map<number, number[]>()
        const finalRanks: Record<string, number> = {}
        for (let sample = 0; sample < samples; sample++) {
          let state = { ...createRating('player'), gamesPlayed: 0 }
          let rp = PUBLIC_RATING_START
          let effectiveGames = 0
          const reached = new Set<number>()
          for (let game = 0; effectiveGames < 30; game++) {
            const weight = source === 'imported' || (source === 'mixed' && game % 2 === 0) ? 0.5 : 1
            const opponent = (id: string) => ({ playerId: id, mu: 25, sigma: 3, gamesPlayed: 100 })
            let updates
            let won: boolean
            if (format === 'ffa') {
              const performances = [{ id: 'player', score: ability + (random() - 0.5) * 30 }, ...Array.from({ length: 7 }, (_, index) => ({ id: `opponent-${index}`, score: 25 + (random() - 0.5) * 30 }))].sort((a, b) => b.score - a.score)
              won = performances[0]!.id === 'player'
              updates = calculateRatings({ type: 'ffa', entries: performances.map((row, index) => ({ player: row.id === 'player' ? state : opponent(row.id), placement: index + 1 })) }, { sourceWeight: weight })
            }
            else {
              const size = format === 'duel' ? 1 : format === 'duo' ? 2 : 3
              won = random() < 1 / (1 + Math.exp(-(ability - 25) / (8 * Math.sqrt(size))))
              const own = { players: [state, ...Array.from({ length: size - 1 }, (_, index) => opponent(`ally-${index}`))] }
              const other = { players: Array.from({ length: size }, (_, index) => opponent(`opponent-${index}`)) }
              updates = calculateRatings({ type: 'team', teams: won ? [own, other] : [other, own] }, { sourceWeight: weight })
            }
            const update = updates.find(row => row.playerId === 'player')!
            const afterMu = state.mu + (update.after.mu - state.mu) * weight
            const afterSigma = state.sigma + (update.after.sigma - state.sigma) * weight
            const publicUpdate = calculatePublicRatingTransition({
              formulaVersion: PUBLIC_RATING_FORMULA_VERSION,
              priorRating: rp,
              hiddenMuBefore: state.mu,
              hiddenMuAfterRaw: update.after.mu,
              hiddenSigmaBefore: state.sigma,
              targetRating: publicRatingTarget(afterMu - 0.75 * afterSigma, calibration),
              sourceWeight: weight,
            })
            if (!Number.isFinite(publicUpdate.after) || publicUpdate.after < 0 || publicUpdate.delta * (afterMu - state.mu) < 0) throw new Error('Simulation violated a rating invariant.')
            const stage = game === 0 ? 'game-1' : effectiveGames < 4 ? 'games-2-4' : effectiveGames < 8 ? 'games-5-8' : effectiveGames < 16 ? 'games-9-16' : 'established'
            const key = `${stage}:${won ? 'win' : 'loss'}`
            const bucket = movement.get(key) ?? []
            bucket.push(publicUpdate.delta)
            movement.set(key, bucket)
            rp = publicUpdate.after
            state = { ...state, mu: afterMu, sigma: afterSigma, gamesPlayed: state.gamesPlayed + 1 }
            effectiveGames += weight
            transitions++
            for (const threshold of [8, 16, 20, 30]) {
              if (effectiveGames < threshold || reached.has(threshold)) continue
              const bucket = atGames.get(threshold) ?? []
              bucket.push(rp)
              atGames.set(threshold, bucket)
              reached.add(threshold)
            }
          }
          const rank = publicRatingRank(rp).tier
          finalRanks[rank] = (finalRanks[rank] ?? 0) + 1
        }
        rows.push({ format, source, ability, samples, movement: Object.fromEntries([...movement].map(([key, values]) => [key, summarize(values)])), rpAtEffectiveGames: Object.fromEntries([...atGames].map(([key, values]) => [key, summarize(values)])), finalNaturalRanks: finalRanks })
      }
    }
  }
  return { formulaVersion: PUBLIC_RATING_FORMULA_VERSION, productionCalibration: false, synthetic: true, transitions, assumptions: 'Fixed synthetic opponents; FFA win means first place. Natural ranks exclude Discord evidence gates. This is not the required PPL trajectory or participation-cadence validation.', rows }
}

if (import.meta.main) {
  try {
    const args = options(Bun.argv.slice(2))
    const output = resolve(args.output)
    if (await Bun.file(output).exists()) throw new Error('The output file already exists; choose a new review artifact path.')
    if (args.input && resolve(args.input) === output) throw new Error('Input and output paths must differ.')
    const report = args.synthetic
      ? simulateCandidatePublicRatings()
      : prepareSeasonOpening(await Bun.file(args.input!).json() as SeasonOpeningInput)
    await mkdir(dirname(output), { recursive: true })
    await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Saved offline review to ${output}. No production data was read or written.`)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
