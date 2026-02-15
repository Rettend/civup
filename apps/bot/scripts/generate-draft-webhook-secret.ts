/* eslint-disable no-console */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const envFilePath = resolve(import.meta.dir, '../.dev.vars')
const envKey = 'CIVUP_SECRET'
const shouldWrite = Bun.argv.includes('--write')
const secret = createSecret()

if (!shouldWrite) {
  console.log(`${envKey}=${secret}`)
}
else {
  const currentEnv = await readEnvFile(envFilePath)
  const newline = currentEnv.includes('\r\n') ? '\r\n' : '\n'
  const nextEnv = upsertEnvVar(currentEnv, `${envKey}=${secret}`, envKey)

  await writeFile(envFilePath, `${nextEnv}${newline}`)
  console.log(`Updated ${envFilePath}`)
  console.log(`${envKey}=${secret}`)
}

function createSecret(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  return new Bun.CryptoHasher('sha256').update(randomBytes).digest('hex')
}

async function readEnvFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  }
  catch (error) {
    if (isEnoent(error)) return ''
    throw error
  }
}

function upsertEnvVar(fileContent: string, envLine: string, key: string): string {
  const lines = fileContent
    .split(/\r?\n/)
    .filter((line, index, all) => line.length > 0 || index < all.length - 1)

  const envPrefix = `${key}=`
  const existingIndex = lines.findIndex(line => line.startsWith(envPrefix))
  if (existingIndex >= 0) {
    lines[existingIndex] = envLine
  }
  else {
    lines.push(envLine)
  }

  return lines.join('\n')
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
