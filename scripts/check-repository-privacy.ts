import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const publicMarkdown = new Set([
  'AGENTS.md',
  'README.md',
  'GUIDE.md',
  'MANUAL.md',
  'apps/bot/tests/load/READ-MODELS.md',
  'apps/bot/tests/system/README.md',
  'packages/civ6-mod/README.md',
  'packages/civ6-mod/THIRD_PARTY_NOTICES.md',
  'packages/civup-analyzer/guide.md',
])

// These templates were reviewed. An arbitrary .example suffix is not an exemption.
const reviewedExamples = new Set([
  'apps/activity/.dev.vars.example',
  'apps/activity/.prod.secrets.example',
  'apps/bot/.dev.vars.example',
  'apps/bot/.prod.secrets.example',
  'cloudflared.dev.example.yml',
  'config/cloudflare-targets.local.example.json',
])

export interface PrivacyDiagnostic {
  file: string
  line?: number
  message: string
}

export type PrivacyGitReader = (args: readonly string[], input?: Buffer) => Buffer

export interface PrivacyCheckOptions {
  ref?: string
  git?: PrivacyGitReader
  readFile?: (file: string) => Buffer
  // Match only explicitly supplied hostnames, never the configurable target's name.
  privateDomains?: readonly string[]
  privateValues?: readonly string[]
  readPrivateConfig?: (file: string) => string | undefined
}

class PrivacyCheckError extends Error {}

function credentialPatterns() {
  return [
    {
      message: 'Private key material must not be published.',
      pattern: /-----BEGIN (?:(?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g,
    },
    {
      message: 'A GitHub credential must not be published.',
      pattern:
        /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})(?![A-Za-z0-9_])/g,
    },
    {
      message: 'A Discord credential must not be published.',
      pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,128}(?![A-Za-z0-9_-])/g,
      valid: (value: string) => /^\d{17,20}$/.test(Buffer.from(value.split('.')[0]!, 'base64url').toString('ascii')),
    },
    {
      message: 'A Discord credential must not be published.',
      pattern: /(?<![A-Za-z0-9_-])mfa\.[A-Za-z0-9_-]{84}(?![A-Za-z0-9_-])/g,
    },
  ]
}

function redactCredentials(value: string) {
  for (const { pattern, valid } of credentialPatterns())
    value = value.replace(pattern, match => (!valid || valid(match) ? '[redacted credential]' : match))
  return value
}

export function repositoryPathMessages(file: string): string[] {
  const lower = file.toLowerCase()
  const name = lower.split('/').at(-1)!
  const messages: string[] = []
  if (/(?:^|\/)(?:docs|ppl)(?:\/|$)/.test(lower))
    messages.push('Private documents and deployment files belong in ignored local directories.')
  if (name === 'ppl.md' || /^wrangler\..*ppl/.test(name))
    messages.push('Legacy deployment-specific files must not be published.')
  if (/\.(?:md|markdown|mdx)$/.test(lower) && !publicMarkdown.has(file))
    messages.push('Unreviewed documentation belongs in ignored docs/.')

  const actualName = name.replace(/\.example(?=\.|$)/g, '')
  const privateConfig =
    /\.env(?:\.|$)/.test(actualName) ||
    /^\.(?:[^.]+\.)*(?:vars|secrets)(?:\.|$)/.test(actualName) ||
    /(?:^(?:secrets?|credentials?)$|(?:^|\.)(?:secrets?|credentials?)\.(?:jsonc?|ya?ml|toml|ini|conf|env)$)/.test(
      actualName,
    ) ||
    /\.local\.(?:jsonc?|ya?ml|toml|ini|conf|config)$/.test(actualName) ||
    /^cloudflared\..*\.(?:ya?ml|json)$/.test(actualName) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(actualName) ||
    /\.(?:p12|pfx|ppk|key)$/.test(actualName)
  if (privateConfig && !reviewedExamples.has(file))
    messages.push('Actual environment, credential, and local configuration files must stay ignored.')

  // Do not reject SQL migrations, vendor CSVs, JSON snapshots, or save-parsing source code.
  if (
    /\.(?:civ[56]save|civbeyondswordsave|civ4save|civ5replay|civ6replay)(?:\.(?:zip|gz))?$/.test(name) ||
    /\.(?:sqlite3?|db)(?:-(?:wal|shm)|\.(?:gz|zip|bak))?$/.test(name) ||
    /\.dump(?:\.(?:sql|gz|zip))?$/.test(name) ||
    (/\.(?:sql|jsonl?|ndjson|csv|tsv|xlsx?)(?:\.(?:gz|zip))?$/.test(name) &&
      (/(?:^|\/)(?:dumps|backups)(?:\/|$)/.test(lower) || /(?:^|[._-])(?:dump|backup)(?:[._-]|$)/.test(name)))
  )
    messages.push('Database dumps and saved games must stay local.')
  return messages
}

function normalizePrivateDomains(domains: readonly string[]) {
  return domains.map(domain => {
    const normalized = domain.toLowerCase()
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(normalized))
      throw new PrivacyCheckError('Supply private domains as exact hostnames, without URLs or wildcards.')
    return normalized
  })
}

function readPrivateConfig(file: string): string | undefined {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new PrivacyCheckError('Could not read local privacy settings.')
  }
  // Do not follow links to unrelated files or silently treat a broken link as absent.
  if (!stat.isFile()) throw new PrivacyCheckError('Could not read local privacy settings.')
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new PrivacyCheckError('Could not read local privacy settings.')
  }
}

function privateIdentities(root: string, read: (file: string) => string | undefined) {
  let source: string | undefined
  try {
    source = read(resolve(root, 'config/cloudflare-targets.local.json'))
  } catch {
    throw new PrivacyCheckError('Could not read local privacy settings.')
  }
  const values = new Set<string>()
  const domains = new Set<string>()
  if (source === undefined) return { values: [], domains: [] }
  let config: unknown
  try {
    config = JSON.parse(source)
  } catch {
    throw new PrivacyCheckError('Local privacy settings are not valid JSON.')
  }
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new PrivacyCheckError('Local privacy settings contain invalid identity fields.')
    return value as Record<string, unknown>
  }
  const string = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string')
      throw new PrivacyCheckError('Local privacy settings contain invalid identity fields.')
    const trimmed = value.trim()
    return !trimmed || /^YOUR_[A-Z0-9_]+$/.test(trimmed) ? undefined : trimmed
  }
  const add = (value: unknown) => {
    const identity = string(value)
    if (identity) values.add(identity)
  }
  const targets = object(config)
  for (const name of ['standard', 'ppl']) {
    if (targets[name] === undefined) continue
    const target = object(targets[name])
    add(target.accountId)
    if (target.discord !== undefined) {
      const discord = object(target.discord)
      for (const field of ['applicationId', 'publicKey', 'guildId']) add(discord[field])
      const guildIds = string(discord.guildIds)
      if (guildIds) for (const id of guildIds.split(/[,\s]+/)) add(id)
    }
    for (const service of ['d1', 'kv']) if (target[service] !== undefined) add(object(target[service]).id)
    const origin = string(target.activityOrigin)
    if (origin) {
      let hostname: string
      try {
        const url = new URL(origin)
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw new Error()
        hostname = url.hostname
      } catch {
        throw new PrivacyCheckError('Local privacy settings contain an invalid activity origin.')
      }
      if (!/^YOUR_[A-Z0-9_]+$/i.test(hostname)) domains.add(hostname)
    }
  }
  // Worker, database, and bucket names and other deployment options are deliberately ignored.
  return { values: [...values], domains: [...domains] }
}

function redactPrivateData(value: string, privateValues: readonly string[], domains: readonly string[]) {
  value = redactCredentials(value)
  for (const identity of privateValues) if (identity) value = value.split(identity).join('[redacted private value]')
  for (const domain of domains)
    value = value.replace(new RegExp(domain.replace(/\./g, '\\.'), 'gi'), '[redacted private hostname]')
  return value
}

function validateContents(
  file: string,
  contents: Buffer,
  privateDomains: readonly string[],
  privateValues: readonly string[],
): PrivacyDiagnostic[] {
  const domains = normalizePrivateDomains(privateDomains)
  const diagnosticFile = redactPrivateData(file, privateValues, domains)
  const diagnostics: PrivacyDiagnostic[] = []
  const text = contents.toString('utf8')
  for (const { pattern, message, valid } of credentialPatterns()) {
    for (const match of text.matchAll(pattern)) {
      if (valid && !valid(match[0])) continue
      diagnostics.push({ file: diagnosticFile, line: text.slice(0, match.index).split('\n').length, message })
      break
    }
  }
  for (const identity of new Set(privateValues)) {
    if (!identity) continue
    const index = text.indexOf(identity)
    if (index < 0) continue
    diagnostics.push({
      file: diagnosticFile,
      line: text.slice(0, index).split('\n').length,
      message: 'A private deployment identity must not be published.',
    })
  }
  if (domains.length) {
    // Extract complete hostnames so example.invalid does not match notexample.invalid.
    const hostnames = text.matchAll(
      /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]*(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g,
    )
    for (const hostname of hostnames) {
      const host = hostname[0].toLowerCase()
      if (!domains.some(domain => host === domain || host.endsWith(`.${domain}`))) continue
      diagnostics.push({
        file: diagnosticFile,
        line: text.slice(0, hostname.index).split('\n').length,
        message: 'A private deployment hostname must not be published.',
      })
      break
    }
  }
  return diagnostics
}

export function validateRepositoryFile(
  file: string,
  contents: Buffer,
  privateDomains: readonly string[] = [],
  privateValues: readonly string[] = [],
): PrivacyDiagnostic[] {
  const diagnosticFile = redactPrivateData(file, privateValues, normalizePrivateDomains(privateDomains))
  const diagnostics: PrivacyDiagnostic[] = repositoryPathMessages(file).map(message => ({
    file: diagnosticFile,
    message,
  }))
  diagnostics.push(...validateContents(file, contents, privateDomains, privateValues))
  if (
    contents.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) ||
    (contents.length >= 16 && contents.subarray(0, 4).equals(Buffer.from('CIV6'))) ||
    /^-- (?:PostgreSQL database dump|MySQL dump)\b/m.test(contents.subarray(0, 1024).toString('utf8'))
  )
    diagnostics.push({ file: diagnosticFile, message: 'Database dumps and saved games must stay local.' })
  return diagnostics
}

function decode(bytes: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new PrivacyCheckError('Git returned a filename that cannot be checked as UTF-8.')
  }
}

function nulRecords(bytes: Buffer): string[] {
  if (!bytes.length) return []
  if (bytes.at(-1) !== 0) throw new PrivacyCheckError('Git returned an incomplete file list.')
  const records = decode(bytes.subarray(0, -1)).split('\0')
  if (records.some(record => !record)) throw new PrivacyCheckError('Git returned an invalid file list.')
  return records
}

function checkPath(file: string) {
  if (
    file.startsWith('/') ||
    /^[A-Za-z]:/.test(file) ||
    file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
    (process.platform === 'win32' && file.includes('\\'))
  )
    throw new PrivacyCheckError('Git returned a path that cannot be checked safely.')
  return file
}

function readWorkingFile(file: string) {
  const stat = lstatSync(file)
  // Git publishes a symlink's target string, not the file it points to.
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(file))
  if (!stat.isFile()) throw new PrivacyCheckError('A selected path is not a file. Submodules cannot be checked.')
  return readFileSync(file)
}

function gitReader(root: string): PrivacyGitReader {
  return (args, input) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      input,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    })
    if (result.error || result.status !== 0)
      throw new PrivacyCheckError('Could not read repository information from Git.')
    return result.stdout
  }
}

interface TreeFile {
  file: string
  oid: string
}

function committedFiles(git: PrivacyGitReader, ref: string) {
  const commit = decode(git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).replace(/\r?\n$/, '')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    throw new PrivacyCheckError('Git could not resolve the requested commit.')
  const files = nulRecords(git(['ls-tree', '-r', '-z', '--full-tree', commit])).map(record => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record)
    if (!match) throw new PrivacyCheckError('A committed entry cannot be checked. Submodules are not supported.')
    return { file: checkPath(match[3]!), oid: match[2]! }
  })
  return { commit, files }
}

function commitMessage(git: PrivacyGitReader, commit: string) {
  const contents = git(['cat-file', 'commit', commit])
  const separator = contents.indexOf('\n\n')
  if (separator < 0) throw new PrivacyCheckError('Git returned incomplete commit metadata.')
  return contents.subarray(separator + 2)
}

function committedContents(git: PrivacyGitReader, files: TreeFile[]) {
  const objects = [...new Set(files.map(file => file.oid))]
  const contents = new Map<string, Buffer>()
  // Bound batch sizes without skipping binaries or truncating their content.
  for (let start = 0; start < objects.length; start += 128) {
    const batch = objects.slice(start, start + 128)
    const bytes = git(['cat-file', '--batch'], Buffer.from(`${batch.join('\n')}\n`))
    let offset = 0
    for (const oid of batch) {
      const end = bytes.indexOf(10, offset)
      if (end < 0) throw new PrivacyCheckError('Git returned incomplete committed file contents.')
      const header = decode(bytes.subarray(offset, end))
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9]\d*)$/.exec(header)
      const size = match ? Number(match[2]) : Number.NaN
      offset = end + 1
      if (
        !match ||
        match[1] !== oid ||
        !Number.isSafeInteger(size) ||
        offset + size >= bytes.length ||
        bytes[offset + size] !== 10
      )
        throw new PrivacyCheckError('Git returned invalid committed file contents.')
      contents.set(oid, bytes.subarray(offset, offset + size))
      offset += size + 1
    }
    if (offset !== bytes.length) throw new PrivacyCheckError('Git returned unexpected committed file contents.')
  }
  return contents
}

export function checkRepositoryPrivacy(root: string, options: PrivacyCheckOptions = {}) {
  const reader = options.git ?? gitReader(root)
  const git: PrivacyGitReader = (args, input) => {
    try {
      const bytes = reader(args, input)
      if (!Buffer.isBuffer(bytes)) throw new Error()
      return bytes
    } catch {
      // Never forward Git stderr or arbitrary exceptions, which may contain secrets.
      throw new PrivacyCheckError('Could not read repository information from Git.')
    }
  }
  const identities = privateIdentities(root, options.readPrivateConfig ?? readPrivateConfig)
  const privateValues = [...new Set([...identities.values, ...(options.privateValues ?? [])])]
  const domains = normalizePrivateDomains([...identities.domains, ...(options.privateDomains ?? [])])
  const diagnostics: PrivacyDiagnostic[] = []
  let files: string[]
  if (options.ref !== undefined) {
    if (!options.ref) throw new PrivacyCheckError('Supply a Git ref after --ref.')
    const { commit, files: tree } = committedFiles(git, options.ref)
    const contents = committedContents(git, tree)
    files = tree.map(entry => entry.file)
    for (const entry of tree)
      diagnostics.push(...validateRepositoryFile(entry.file, contents.get(entry.oid)!, domains, privateValues))
    diagnostics.push(...validateContents('Commit metadata', commitMessage(git, commit), domains, privateValues))
  } else {
    const candidates = nulRecords(git(['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z']))
    const deleted = new Set(nulRecords(git(['ls-files', '--deleted', '--full-name', '-z'])).map(checkPath))
    files = [...new Set(candidates.map(checkPath))].filter(file => !deleted.has(file)).sort()
    const read = options.readFile ?? readWorkingFile
    for (const file of files) {
      let contents: Buffer
      try {
        contents = read(resolve(root, file))
        if (!Buffer.isBuffer(contents)) throw new Error()
      } catch {
        throw new PrivacyCheckError(
          `Could not read selected file ${JSON.stringify(redactPrivateData(file, privateValues, domains))}.`,
        )
      }
      diagnostics.push(...validateRepositoryFile(file, contents, domains, privateValues))
    }
  }
  return { files: files.length, diagnostics }
}

interface PrivacyCommandOptions extends PrivacyCheckOptions {
  writeError?: (message: string) => void
  writeSuccess?: (message: string) => void
}

export function runRepositoryPrivacy(args: readonly string[], root: string, options: PrivacyCommandOptions = {}) {
  const writeError = options.writeError ?? console.error
  const writeSuccess = options.writeSuccess ?? console.warn
  try {
    let ref: string | undefined
    const privateDomains = [...(options.privateDomains ?? [])]
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg !== '--ref' && arg !== '--private-domain') {
        throw new PrivacyCheckError(
          'Usage: bun --no-env-file scripts/check-repository-privacy.ts [--ref <git ref>] [--private-domain <hostname>]',
        )
      }
      const value = args[++index]
      if (!value || value.startsWith('--'))
        throw new PrivacyCheckError('Supply a value after --ref or --private-domain.')
      if (arg === '--ref') {
        if (ref !== undefined) throw new PrivacyCheckError('Supply --ref only once.')
        ref = value
      } else {
        privateDomains.push(value)
      }
    }
    const { files, diagnostics } = checkRepositoryPrivacy(root, { ...options, ref, privateDomains })
    for (const diagnostic of diagnostics) {
      writeError(
        `${JSON.stringify(diagnostic.file)}${diagnostic.line ? `:${diagnostic.line}` : ''}: ${diagnostic.message}`,
      )
    }
    if (diagnostics.length) return 1
    writeSuccess(`Repository privacy check passed (${files} files).`)
    return 0
  } catch (error) {
    writeError(error instanceof PrivacyCheckError ? error.message : 'Repository privacy check could not finish.')
    return 1
  }
}

if (import.meta.main) process.exitCode = runRepositoryPrivacy(process.argv.slice(2), resolve(import.meta.dirname, '..'))
