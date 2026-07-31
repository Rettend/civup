/* eslint-disable no-console */
import { inflateRawSync } from 'node:zlib'
import { parseAutosaveZipIndex, parseCiv6SaveMetadata, parseZipEntries, pickLatestAutosaveZipEntry, readZipEntryData } from '../packages/civ6-save-metadata/src/index.ts'

interface CliOptions {
  path: string | null
  includeEntries: boolean
  includeMetadata: boolean
  compact: boolean
}

const options = parseArgs(Bun.argv.slice(2))
if (!options.path) {
  printUsage()
  process.exit(1)
}

const file = Bun.file(options.path)
if (!(await file.exists())) {
  console.error(`File not found: ${options.path}`)
  process.exit(1)
}

const bytes = new Uint8Array(await file.arrayBuffer())
const zipResult = isCiv6SavePath(options.path)
  ? null
  : parseAutosaveZipIndex(bytes, { includeEntries: options.includeEntries })
const metadata = options.includeMetadata ? parseMetadata(bytes, options.path) : null

console.log(JSON.stringify({
  source: options.path,
  ...(zipResult ?? {}),
  ...(metadata ? { metadata } : {}),
}, null, options.compact ? 0 : 2))

function parseMetadata(bytes: Uint8Array, sourcePath: string) {
  if (isCiv6SavePath(sourcePath)) return parseCiv6SaveMetadata(bytes)

  const zipEntries = parseZipEntries(bytes)
  const latestSave = pickLatestAutosaveZipEntry(zipEntries)
  if (!latestSave) throw new Error('No .Civ6Save entries found in zip')

  const saveBytes = readZipEntryData(bytes, latestSave, inflateRaw)
  return {
    latestSaveName: latestSave.name,
    ...parseCiv6SaveMetadata(saveBytes),
  }
}

function isCiv6SavePath(value: string): boolean {
  return /\.Civ6Save$/i.test(value)
}

function inflateRaw(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(inflateRawSync(bytes))
}

function parseArgs(args: string[]): CliOptions {
  let path: string | null = null
  let includeEntries = false
  let includeMetadata = false
  let compact = false

  for (const arg of args) {
    if (arg === '--entries') {
      includeEntries = true
      continue
    }
    if (arg === '--metadata') {
      includeMetadata = true
      continue
    }
    if (arg === '--compact') {
      compact = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`)
      process.exit(1)
    }
    path = arg
  }

  return { path, includeEntries, includeMetadata, compact }
}

function printUsage() {
  console.log('Usage: bun run autosave:parse -- <autosaves.zip|save.Civ6Save> [--entries] [--metadata] [--compact]')
}
