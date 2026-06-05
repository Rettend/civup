/* eslint-disable no-console */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { deflateSync } from 'node:zlib'

const ITEM_ICON_DIR = resolve(import.meta.dir, '../public/assets/bbg/items')
const ITEM_ICON_REPO_PATH = 'apps/activity/public/assets/bbg/items'
const CANVAS_SIZE = 256
const DEFAULT_ALPHA_THRESHOLD = 8
const DEFAULT_QUALITY = 92
const DEFAULT_TARGET_VISIBLE_SIZE = 216
const TOOL_TIMEOUT_MS = 30_000
const DEFAULT_ITEM_FILES = [
  'Dogsled Hunter.webp',
  'Dzong.webp',
  'Ehuatl Wearer.webp',
  'Jahazi.webp',
  'Lavra.webp',
  'Pochteca Enclave.webp',
]
const TARGET_VISIBLE_SIZE_BY_FILE: Record<string, number> = {
  'Dogsled Hunter.webp': 192,
  'Ehuatl Wearer.webp': 192,
  'Jahazi.webp': 192,
  'Dzong.webp': 228,
  'Lavra.webp': 228,
  'Pochteca Enclave.webp': 228,
}

type SourceMode = 'current' | 'git-head'

interface Options {
  alphaThreshold: number
  dryRun: boolean
  files: string[]
  quality: number
  source: SourceMode
  targetVisibleSizeOverride: number | null
  verbose: boolean
}

interface PamImage {
  height: number
  pixels: Uint8Array
  width: number
}

interface Bounds {
  height: number
  maxX: number
  maxY: number
  minX: number
  minY: number
  width: number
}

interface NormalizedItemResult {
  afterBounds: Bounds
  afterBytes: number | null
  beforeBounds: Bounds
  beforeBytes: number
  file: string
  scale: number
  skipped: boolean
  sourceHeight: number
  sourceWidth: number
  targetVisibleSize: number
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  validateTools()

  const tempDir = await mkdtemp(join(tmpdir(), 'civup-bbg-item-icons-'))
  const results: NormalizedItemResult[] = []

  try {
    for (const [index, file] of options.files.entries()) {
      if (!options.dryRun && !options.verbose) console.log(`[${index + 1}/${options.files.length}] ${file}`)

      const inputPath = resolve(ITEM_ICON_DIR, file)
      const sourceBytes = options.source === 'git-head' ? readGitHeadItemIcon(file) : null
      const sourcePath = sourceBytes == null ? inputPath : await writeSourceWebp(file, sourceBytes, tempDir)
      const beforeBytes = sourceBytes?.byteLength ?? (await stat(inputPath)).size
      const source = await decodeWebpToPam(sourcePath, tempDir)
      const beforeBounds = findAlphaBounds(source, options.alphaThreshold)
      const targetVisibleSize = getTargetVisibleSize(file, options)
      const scale = targetVisibleSize / Math.max(beforeBounds.width, beforeBounds.height)
      const skipped = isAlreadyNormalized(source, beforeBounds, targetVisibleSize, options)
      const normalized = skipped ? null : normalizeIcon(source, beforeBounds, scale, options)
      const afterBytes = normalized == null || options.dryRun
        ? null
        : await encodeNormalizedWebp(inputPath, normalized.pixels, tempDir, options)

      results.push({
        afterBounds: normalized?.bounds ?? beforeBounds,
        afterBytes,
        beforeBounds,
        beforeBytes,
        file,
        scale: skipped ? 1 : scale,
        skipped,
        sourceHeight: source.height,
        sourceWidth: source.width,
        targetVisibleSize,
      })

      if (options.verbose) console.log(formatResult(results[results.length - 1]!))
    }
  }
  finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  printSummary(results, options)
}

function parseOptions(args: string[]): Options {
  const explicitFiles = args
    .filter(arg => arg.startsWith('--file='))
    .map(arg => itemFileName(arg.slice('--file='.length)))

  return {
    alphaThreshold: parseNumberArg(args, '--alpha-threshold=', DEFAULT_ALPHA_THRESHOLD, 0, 255),
    dryRun: args.includes('--dry-run'),
    files: explicitFiles.length > 0 ? explicitFiles : DEFAULT_ITEM_FILES,
    quality: parseNumberArg(args, '--quality=', DEFAULT_QUALITY, 1, 100),
    source: parseSourceArg(args),
    targetVisibleSizeOverride: parseOptionalNumberArg(args, '--target-visible-size=', 1, CANVAS_SIZE),
    verbose: args.includes('--verbose'),
  }
}

function itemFileName(value: string): string {
  return value.toLowerCase().endsWith('.webp') ? value : `${value}.webp`
}

function parseNumberArg(args: string[], prefix: string, fallback: number, min: number, max: number): number {
  const arg = args.find(value => value.startsWith(prefix))
  if (!arg) return fallback

  const value = Number.parseInt(arg.slice(prefix.length), 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${prefix.slice(0, -1)} value. Use an integer between ${min} and ${max}.`)
  }

  return value
}

function parseOptionalNumberArg(args: string[], prefix: string, min: number, max: number): number | null {
  const arg = args.find(value => value.startsWith(prefix))
  if (!arg) return null

  const value = Number.parseInt(arg.slice(prefix.length), 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${prefix.slice(0, -1)} value. Use an integer between ${min} and ${max}.`)
  }

  return value
}

function getTargetVisibleSize(file: string, options: Options): number {
  return options.targetVisibleSizeOverride ?? TARGET_VISIBLE_SIZE_BY_FILE[file] ?? DEFAULT_TARGET_VISIBLE_SIZE
}

function parseSourceArg(args: string[]): SourceMode {
  const arg = args.find(value => value.startsWith('--source='))
  if (!arg) return 'current'

  const value = arg.slice('--source='.length)
  if (value === 'current' || value === 'git-head') return value
  throw new Error('Invalid --source value. Use current or git-head.')
}

function validateTools(): void {
  runTool('dwebp', ['-version'], 'checking dwebp')
  runTool('cwebp', ['-version'], 'checking cwebp')
}

async function decodeWebpToPam(inputPath: string, tempDir: string): Promise<PamImage> {
  const pamPath = resolve(tempDir, `${basename(inputPath)}.pam`)
  runTool('dwebp', ['-quiet', '-pam', inputPath, '-o', pamPath], inputPath)
  return parsePam(await readFile(pamPath))
}

async function writeSourceWebp(file: string, bytes: Buffer, tempDir: string): Promise<string> {
  const path = resolve(tempDir, `${basename(file)}.source.webp`)
  await writeFile(path, bytes)
  return path
}

function readGitHeadItemIcon(file: string): Buffer {
  const result = Bun.spawnSync(['git', 'show', `HEAD:${ITEM_ICON_REPO_PATH}/${file}`], { timeout: TOOL_TIMEOUT_MS })
  if (result.exitCode === 0) return Buffer.from(result.stdout)

  const error = result.stderr.toString('utf8').trim()
  throw new Error(`git show failed for ${file}: ${formatSpawnFailure(result.signalCode, error)}`)
}

async function encodeNormalizedWebp(inputPath: string, pixels: Uint8Array, tempDir: string, options: Options): Promise<number> {
  const pngPath = resolve(tempDir, `${basename(inputPath)}.normalized.png`)
  const webpPath = resolve(tempDir, `${basename(inputPath)}.normalized.webp`)

  await writeFile(pngPath, createPng(CANVAS_SIZE, CANVAS_SIZE, pixels))
  runTool(
    'cwebp',
    ['-quiet', '-mt', '-m', '6', '-q', options.quality.toString(), '-alpha_q', '100', pngPath, '-o', webpPath],
    inputPath,
  )

  const encoded = await readFile(webpPath)
  await writeFile(inputPath, encoded)
  return encoded.byteLength
}

function runTool(command: string, args: string[], context: string): void {
  const result = Bun.spawnSync([command, ...args], { timeout: TOOL_TIMEOUT_MS })
  if (result.exitCode === 0) return

  const error = result.stderr.toString('utf8').trim()
  throw new Error(`${command} failed for ${context}: ${formatSpawnFailure(result.signalCode, error || `exit code ${result.exitCode}`)}`)
}

function formatSpawnFailure(signalCode: NodeJS.Signals | null, error: string): string {
  if (signalCode) return `${signalCode}${error ? `: ${error}` : ''}`
  return error
}

function parsePam(buffer: Buffer): PamImage {
  const endHeader = Buffer.from('ENDHDR\n')
  const headerEnd = buffer.indexOf(endHeader)
  if (headerEnd < 0) throw new Error('Invalid PAM image: missing ENDHDR')

  const header = buffer.subarray(0, headerEnd + endHeader.byteLength).toString('ascii')
  const metadata = new Map<string, string>()
  for (const line of header.split('\n')) {
    const match = /^(\S+)\s+(.+)$/.exec(line)
    if (match) metadata.set(match[1]!, match[2]!)
  }

  const width = Number.parseInt(metadata.get('WIDTH') ?? '', 10)
  const height = Number.parseInt(metadata.get('HEIGHT') ?? '', 10)
  const depth = Number.parseInt(metadata.get('DEPTH') ?? '', 10)
  const maxValue = Number.parseInt(metadata.get('MAXVAL') ?? '', 10)
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(depth)) {
    throw new Error('Invalid PAM image: missing width, height, or depth')
  }
  if (maxValue !== 255) throw new Error(`Unsupported PAM max value: ${maxValue}`)
  if (depth !== 3 && depth !== 4) throw new Error(`Unsupported PAM depth: ${depth}`)

  const data = buffer.subarray(headerEnd + endHeader.byteLength)
  const expectedBytes = width * height * depth
  if (data.byteLength < expectedBytes) {
    throw new Error(`Invalid PAM image: expected ${expectedBytes} bytes, got ${data.byteLength}`)
  }

  if (depth === 4) return { width, height, pixels: new Uint8Array(data.subarray(0, expectedBytes)) }

  const pixels = new Uint8Array(width * height * 4)
  for (let source = 0, target = 0; source < expectedBytes; source += 3, target += 4) {
    pixels[target] = data[source]!
    pixels[target + 1] = data[source + 1]!
    pixels[target + 2] = data[source + 2]!
    pixels[target + 3] = 255
  }
  return { width, height, pixels }
}

function findAlphaBounds(image: PamImage, alphaThreshold: number): Bounds {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const alpha = image.pixels[(y * image.width + x) * 4 + 3]!
      if (alpha <= alphaThreshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) {
    return { minX: 0, minY: 0, maxX: image.width - 1, maxY: image.height - 1, width: image.width, height: image.height }
  }

  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function normalizeIcon(image: PamImage, bounds: Bounds, scale: number, options: Options): { bounds: Bounds, pixels: Uint8Array } {
  const sourceCenterX = (bounds.minX + bounds.maxX + 1) / 2
  const sourceCenterY = (bounds.minY + bounds.maxY + 1) / 2
  const targetCenter = CANVAS_SIZE / 2
  const pixels = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 4)

  for (let y = 0; y < CANVAS_SIZE; y++) {
    for (let x = 0; x < CANVAS_SIZE; x++) {
      const sourceX = sourceCenterX + (x + 0.5 - targetCenter) / scale - 0.5
      const sourceY = sourceCenterY + (y + 0.5 - targetCenter) / scale - 0.5
      writeBilinearPixel(image, sourceX, sourceY, pixels, (y * CANVAS_SIZE + x) * 4)
    }
  }

  return { bounds: findAlphaBounds({ width: CANVAS_SIZE, height: CANVAS_SIZE, pixels }, options.alphaThreshold), pixels }
}

function isAlreadyNormalized(image: PamImage, bounds: Bounds, targetVisibleSize: number, options: Options): boolean {
  if (options.source !== 'current') return false
  if (image.width !== CANVAS_SIZE || image.height !== CANVAS_SIZE) return false
  if (Math.abs(Math.max(bounds.width, bounds.height) - targetVisibleSize) > 2) return false

  const centerX = (bounds.minX + bounds.maxX + 1) / 2
  const centerY = (bounds.minY + bounds.maxY + 1) / 2
  return Math.abs(centerX - CANVAS_SIZE / 2) <= 1 && Math.abs(centerY - CANVAS_SIZE / 2) <= 1
}

function writeBilinearPixel(image: PamImage, sourceX: number, sourceY: number, target: Uint8Array, targetOffset: number): void {
  const x0 = Math.floor(sourceX)
  const y0 = Math.floor(sourceY)
  const xWeight = sourceX - x0
  const yWeight = sourceY - y0
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0

  const addSample = (x: number, y: number, weight: number) => {
    if (weight <= 0) return
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) return

    const offset = (y * image.width + x) * 4
    const sampleAlpha = image.pixels[offset + 3]! / 255
    alpha += sampleAlpha * weight
    red += image.pixels[offset]! * sampleAlpha * weight
    green += image.pixels[offset + 1]! * sampleAlpha * weight
    blue += image.pixels[offset + 2]! * sampleAlpha * weight
  }

  addSample(x0, y0, (1 - xWeight) * (1 - yWeight))
  addSample(x0 + 1, y0, xWeight * (1 - yWeight))
  addSample(x0, y0 + 1, (1 - xWeight) * yWeight)
  addSample(x0 + 1, y0 + 1, xWeight * yWeight)

  if (alpha <= 0) return

  target[targetOffset] = clampByte(red / alpha)
  target[targetOffset + 1] = clampByte(green / alpha)
  target[targetOffset + 2] = clampByte(blue / alpha)
  target[targetOffset + 3] = clampByte(alpha * 255)
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function createPng(width: number, height: number, pixels: Uint8Array): Buffer {
  const rowLength = width * 4
  const raw = Buffer.alloc((rowLength + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (rowLength + 1)
    raw[rowOffset] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * rowLength, rowLength).copy(raw, rowOffset + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    createPngChunk('IHDR', Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    createPngChunk('IDAT', deflateSync(raw)),
    createPngChunk('IEND', Buffer.alloc(0)),
  ])
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  return Buffer.concat([
    uint32(data.byteLength),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data]))),
  ])
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0)
  return buffer
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer: Buffer): number {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function printSummary(results: NormalizedItemResult[], options: Options): void {
  const beforeBytes = results.reduce((total, result) => total + result.beforeBytes, 0)
  const afterBytes = results.reduce((total, result) => total + (result.afterBytes ?? result.beforeBytes), 0)
  const changedResults = results.filter(result => !result.skipped)

  console.log(`${options.dryRun ? 'Would normalize' : 'Normalized'} ${changedResults.length} BBG item icons. Skipped ${results.length - changedResults.length} already-normalized icons.`)
  console.log(`Source: ${options.source}; target visible size: ${options.targetVisibleSizeOverride == null ? 'per file' : `${options.targetVisibleSizeOverride}px`} on ${CANVAS_SIZE}x${CANVAS_SIZE}; alpha threshold: ${options.alphaThreshold}; quality: ${options.quality}.`)
  if (!options.dryRun) console.log(`Size: ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}.`)
  for (const result of changedResults) console.log(`  ${formatResult(result)}`)
}

function formatResult(result: NormalizedItemResult): string {
  const afterSize = result.afterBytes == null ? '' : `, ${formatBytes(result.beforeBytes)} -> ${formatBytes(result.afterBytes)}`
  if (result.skipped) {
    return `${result.file}: ${result.sourceWidth}x${result.sourceHeight}, target ${result.targetVisibleSize}px, visible ${result.beforeBounds.width}x${result.beforeBounds.height}, already normalized${afterSize}`
  }
  return `${result.file}: ${result.sourceWidth}x${result.sourceHeight}, target ${result.targetVisibleSize}px, visible ${result.beforeBounds.width}x${result.beforeBounds.height} -> ${result.afterBounds.width}x${result.afterBounds.height}, scale ${(result.scale * 100).toFixed(1)}%${afterSize}`
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

void main()
