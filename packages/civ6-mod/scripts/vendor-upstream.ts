/* eslint-disable no-console */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'

const EXPECTED_COMMIT = '413d329664183ab13b5f889df0bea62dc2131131'
const sourceRoot = resolve(process.argv[2] ?? process.env.CIV_BLITZ_UPSTREAM ?? '')
const vendorRoot = resolve(import.meta.dir, '../vendor/civ-blitz')

if (!process.argv[2] && !process.env.CIV_BLITZ_UPSTREAM) {
  throw new Error('Pass the Civ Blitz checkout path or set CIV_BLITZ_UPSTREAM.')
}

const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: sourceRoot, stdout: 'pipe', stderr: 'pipe' })
const [gitExitCode, sourceCommit] = await Promise.all([git.exited, new Response(git.stdout).text()])
if (gitExitCode !== 0 || sourceCommit.trim() !== EXPECTED_COMMIT) {
  throw new Error(`Expected Civ Blitz commit ${EXPECTED_COMMIT}; found ${sourceCommit.trim() || 'an unreadable checkout'}.`)
}

const resources = [
  'csv/BbgBsAdjacencies.csv',
  'csv/CardPatches.csv',
  'csv/CivTraits.csv',
  'csv/CivilizationLeaders.csv',
  'csv/Civilizations.csv',
  'csv/CivilizationsCulture.csv',
  'csv/FallbackLeadersArtDefs.csv',
  'csv/LandmarksArtDefs.csv',
  'csv/LeaderArtDefs.csv',
  'csv/LeaderTraits.csv',
  'csv/Players.csv',
  'csv/subtypes.csv',
  'lua/LeaderScene_layeredBg.lua',
  'sql/BggIntegration.sql',
  'sql/fix_trait_civilization_district_cothon.sql',
  'sql/fix_trait_civilization_khmer_barays.sql',
  'sql/fix_trait_civilization_maori_mana.sql',
  'sql/fix_trait_civilization_mayab.sql',
  'sql/fix_trait_leader_founder_carthage.sql',
  'sql/fix_trait_leader_harald_alt.sql',
  'sql/fix_trait_leader_lincoln.sql',
  'sql/fix_trait_leader_pax_britannica.sql',
  'sql/fix_trait_leader_religious_convert.sql',
] as const

await mkdir(vendorRoot, { recursive: true })
await copyFile(resolve(sourceRoot, 'LICENSE.txt'), resolve(vendorRoot, 'LICENSE.txt'))

for (const resource of resources) {
  const destination = resolve(vendorRoot, resource)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(resolve(sourceRoot, 'src/main/resources', resource), destination)
}

await Bun.write(resolve(vendorRoot, 'UPSTREAM.txt'), [
  'Civ Blitz',
  'https://github.com/rossturner/civ-blitz',
  `Commit: ${EXPECTED_COMMIT}`,
  '',
  'These are the minimum source resources used to reproduce @civup/civ6-mod data.',
  '',
].join('\n'))

const license = await readFile(resolve(vendorRoot, 'LICENSE.txt'), 'utf8')
if (!license.includes('Copyright (c) 2021 Rocket Jump Technology')) {
  throw new Error(`Unexpected upstream license copied from ${basename(sourceRoot)}.`)
}

console.log(`Vendored ${resources.length + 1} files from Civ Blitz ${EXPECTED_COMMIT}.`)
