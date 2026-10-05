import { resolve } from 'node:path'
import process from 'node:process'
import { checkPlayerCopyFiles } from './player-copy/check.ts'

try {
  const { files, diagnostics } = checkPlayerCopyFiles(resolve(import.meta.dirname, '..'))
  for (const diagnostic of diagnostics)
    console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`)
  if (diagnostics.length) process.exitCode = 1
  else console.warn(`Player-copy check passed (${files} source files).`)
} catch (error) {
  console.error('Player-copy check could not finish.', error)
  process.exitCode = 1
}
