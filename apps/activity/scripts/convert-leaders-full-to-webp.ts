/* eslint-disable no-console */
import { readdir, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const PORTRAITS_DIR = resolve(import.meta.dir, '../public/assets/leaders-full')

async function main(): Promise<void> {
  const quality = parseQualityArg(process.argv.slice(2))
  const deleteSource = process.argv.includes('--delete')

  const files = await readdir(PORTRAITS_DIR)
  const pngFiles = files.filter(file => file.toLowerCase().endsWith('.png'))

  if (pngFiles.length === 0) {
    console.log('No PNG portraits found to convert.')
    return
  }

  let pngBytes = 0
  let webpBytes = 0

  for (const pngFile of pngFiles) {
    const inputPath = resolve(PORTRAITS_DIR, pngFile)
    const outputPath = resolve(PORTRAITS_DIR, pngFile.replace(/\.png$/i, '.webp'))

    const result = Bun.spawnSync([
      'cwebp',
      '-quiet',
      '-mt',
      '-q',
      quality.toString(),
      inputPath,
      '-o',
      outputPath,
    ])

    if (result.exitCode !== 0) {
      const error = result.stderr.toString('utf8').trim()
      throw new Error(`cwebp failed for ${pngFile}: ${error || `exit code ${result.exitCode}`}`)
    }

    pngBytes += (await stat(inputPath)).size
    webpBytes += (await stat(outputPath)).size

    if (deleteSource) await unlink(inputPath)
  }

  console.log(`Converted ${pngFiles.length} PNG portraits to WebP (q=${quality}).`)
  console.log(`PNG size: ${(pngBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`WebP size: ${(webpBytes / 1024 / 1024).toFixed(2)} MB`)
  if (deleteSource) console.log('Deleted source PNG files.')
}

function parseQualityArg(args: string[]): number {
  const qualityArg = args.find(arg => arg.startsWith('--quality='))
  if (!qualityArg) return 88

  const value = Number.parseInt(qualityArg.slice('--quality='.length), 10)
  if (Number.isNaN(value) || value < 1 || value > 100) {
    throw new Error('Invalid --quality value. Use an integer between 1 and 100.')
  }

  return value
}

void main()
