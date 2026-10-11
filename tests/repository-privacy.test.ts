import type { PrivacyGitReader } from '../scripts/check-repository-privacy.ts'
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  checkRepositoryPrivacy,
  repositoryPathMessages,
  runRepositoryPrivacy,
  validateRepositoryFile,
} from '../scripts/check-repository-privacy.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const root = resolve(import.meta.dirname, 'fixtures/repository-privacy-mock')
const commitId = 'a'.repeat(40)
const githubToken = ['ghp', 'A'.repeat(36)].join('_')
const discordToken = [Buffer.from('123456789012345678').toString('base64url'), 'ABCdef', 'z'.repeat(38)].join('.')
const keyHeader = ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'].join('')

function nul(records: readonly string[]) {
  return Buffer.from(records.length ? `${records.join('\0')}\0` : '')
}

function workingFiles(candidates: readonly string[], deleted: readonly string[] = []) {
  const calls: string[][] = []
  const git: PrivacyGitReader = args => {
    calls.push([...args])
    if (args[0] !== 'ls-files') throw new Error('Unexpected command')
    expect(args).toContain('-z')
    if (args.includes('--deleted')) return nul(deleted)
    expect(args).toContain('--cached')
    expect(args).toContain('--others')
    expect(args).toContain('--exclude-standard')
    return nul(candidates)
  }
  return { git, calls }
}

function committedTree(
  entries: readonly { file: string; contents: Buffer; mode?: string }[],
  message = 'Public commit\n',
) {
  const calls: string[][] = []
  const objects = new Map(entries.map((entry, index) => [(index + 1).toString(16).padStart(40, '0'), entry]))
  const git: PrivacyGitReader = (args, input) => {
    calls.push([...args])
    switch (args[0]) {
      case 'rev-parse':
        expect(args.slice(1, 4)).toEqual(['--verify', '--end-of-options', 'HEAD^{commit}'])
        return Buffer.from(`${commitId}\n`)
      case 'ls-tree':
        expect(args).toEqual(['ls-tree', '-r', '-z', '--full-tree', commitId])
        return nul([...objects].map(([oid, entry]) => `${entry.mode ?? '100644'} blob ${oid}\t${entry.file}`))
      case 'cat-file': {
        if (args[1] === 'commit') {
          expect(args).toEqual(['cat-file', 'commit', commitId])
          return Buffer.from(`tree ${commitId}\nauthor Synthetic <fixture@example.invalid> 1 +0000\n\n${message}`)
        }
        expect(args).toEqual(['cat-file', '--batch'])
        expect(input).toBeDefined()
        const ids = input!.toString().slice(0, -1).split('\n')
        return Buffer.concat(
          ids.map(oid => {
            const entry = objects.get(oid)!
            return Buffer.concat([
              Buffer.from(`${oid} blob ${entry.contents.length}\n`),
              entry.contents,
              Buffer.from('\n'),
            ])
          }),
        )
      }
      default:
        throw new Error('Unexpected command')
    }
  }
  return { git, calls }
}

function withPrivateConfig(source: string, run: (directory: string) => void) {
  const parent = resolve(tmpdir(), 'opencode')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(resolve(parent, 'repository-privacy-'))
  try {
    mkdirSync(resolve(directory, 'config'))
    writeFileSync(resolve(directory, 'config/cloudflare-targets.local.json'), source)
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Repository privacy paths', () => {
  test.each([
    'docs/private-plan.txt',
    'packages/example/docs/notes.json',
    'ppl/player-data.csv',
    'PPL.md',
    'PLAN.md',
    'packages/civup-analyzer/civreplay.md',
    'notes/team plan.md',
    'apps/bot/wrangler.ppl.jsonc',
    'apps/activity/wrangler.legacy-ppl.toml',
    'apps/bot/wrangler.ppl.example.jsonc',
    '.env',
    '.ppl.env',
    '.env.production',
    'apps/bot/.dev.vars',
    'apps/bot/.prod.secrets',
    'config/cloudflare-targets.local.json',
    'config/credentials.json',
    'secrets.yaml',
    'cloudflared.dev.yml',
    'id_ed25519',
    'private.key',
    '.env.example',
    'apps/bot/.prod.secrets.example.backup',
  ])('rejects private or unreviewed file %s', file => {
    expect(repositoryPathMessages(file).length).toBeGreaterThan(0)
  })

  test.each([
    'AGENTS.md',
    'README.md',
    'GUIDE.md',
    'MANUAL.md',
    'apps/bot/tests/load/READ-MODELS.md',
    'apps/bot/tests/system/README.md',
    'packages/civ6-mod/README.md',
    'packages/civ6-mod/THIRD_PARTY_NOTICES.md',
    'packages/civup-analyzer/guide.md',
    'apps/activity/.dev.vars.example',
    'apps/activity/.prod.secrets.example',
    'apps/bot/.dev.vars.example',
    'apps/bot/.prod.secrets.example',
    'cloudflared.dev.example.yml',
    'config/cloudflare-targets.local.example.json',
    'scripts/upload-worker-secrets.ts',
    'apps/bot/src/env.ts',
    'apps/bot/tests/ppl-leader-rank-cache.test.ts',
  ])('allows reviewed documentation, templates, and ordinary source %s', file => {
    expect(repositoryPathMessages(file)).toEqual([])
  })

  test('the documentation allowlist is exact rather than a basename exemption', () => {
    for (const file of ['apps/new/README.md', 'readme.md', 'notes/AGENTS.md'])
      expect(repositoryPathMessages(file)).toContain('Unreviewed documentation belongs in ignored docs/.')
  })

  test('rejects concrete dumps and saves without treating all data or related source as private', () => {
    for (const file of [
      'match.Civ6Save',
      'turn.Civ6Save.zip',
      'state.sqlite',
      'state.sqlite-wal',
      'data.db.gz',
      'database.dump',
      'exports/production-backup.json',
      'dumps/players.csv',
      'backups/data.sql.gz',
    ])
      expect(repositoryPathMessages(file)).toContain('Database dumps and saved games must stay local.')
    for (const file of [
      'packages/db/migrations/0001_schema.sql',
      'vendor/Players.csv',
      'tests/stats.snapshot.json',
      'src/player-data-export.ts',
      'scripts/autosave-parse.ts',
      'src/database-backup.ts',
    ])
      expect(repositoryPathMessages(file)).toEqual([])
  })
})

describe('Repository privacy content', () => {
  test('reports credential kinds and lines without any matched values or surrounding content', () => {
    const fineGrainedToken = ['github', 'pat', 'B'.repeat(22), 'C'.repeat(59)].join('_')
    const source = Buffer.from(`ordinary\n${githubToken}\n${discordToken}\n${keyHeader}\n${fineGrainedToken}\n`)
    const diagnostics = validateRepositoryFile('src/settings.ts', source)
    expect(diagnostics.map(item => item.line).sort()).toEqual([2, 3, 4])
    const report = JSON.stringify(diagnostics)
    for (const secret of [githubToken, fineGrainedToken, discordToken, keyHeader]) expect(report).not.toContain(secret)
    expect(report).not.toContain('ordinary')
    expect(report).toContain('GitHub credential')
    expect(report).toContain('Discord credential')
    expect(report).toContain('Private key')
    expect(validateRepositoryFile('token.txt', Buffer.from(fineGrainedToken))[0]?.message).toContain('GitHub')
  })

  test('also redacts credentials in filenames and quotes newlines in command output', () => {
    const file = `docs/${githubToken}\nnotes.txt`
    const { git } = workingFiles([file])
    const errors: string[] = []
    const status = runRepositoryPrivacy([], root, {
      git,
      readFile: () => Buffer.from(discordToken),
      writeError: message => errors.push(message),
    })
    expect(status).toBe(1)
    expect(errors.join('\n')).not.toContain(githubToken)
    expect(errors.join('\n')).not.toContain(discordToken)
    expect(errors.join('\n')).toContain('[redacted credential]\\nnotes.txt')
    expect(errors.every(message => !message.includes('\n'))).toBe(true)
  })

  test('does not mistake example placeholders or the configurable target selector for credentials', () => {
    const contents = Buffer.from(
      [
        'DISCORD_TOKEN=your-discord-bot-token',
        'GITHUB_TOKEN=ghp_YOUR_TOKEN',
        'CIVUP_SECRET=',
        'https://YOUR_PPL_ACTIVITY_HOST',
        'CIVUP_TARGET=ppl',
        'const targets = ["standard", "ppl"]',
        'abcdefghijklmnopqrstuvwxyz.ABCdef.abcdefghijklmnopqrstuvwxyz0123456789',
      ].join('\n'),
    )
    expect(validateRepositoryFile('apps/bot/.dev.vars.example', contents)).toEqual([])
  })

  test('an example file cannot hide an actual credential', () => {
    expect(validateRepositoryFile('apps/bot/.prod.secrets.example', Buffer.from(discordToken))[0]?.message).toContain(
      'Discord credential',
    )
  })

  test('detects OpenPGP private keys as well as PEM and SSH keys', () => {
    const header = ['-----BEGIN ', 'PGP PRIVATE ', 'KEY BLOCK-----'].join('')
    expect(validateRepositoryFile('config.asc', Buffer.from(header))[0]?.message).toContain('Private key')
  })

  test('checks binary contents and concrete file signatures, not just text extensions', () => {
    const binary = Buffer.concat([Buffer.from([0, 255, 0]), Buffer.from(githubToken), Buffer.from([0, 254])])
    expect(validateRepositoryFile('image.png', binary)[0]?.message).toContain('GitHub credential')
    for (const contents of [
      Buffer.from('SQLite format 3\0more bytes'),
      Buffer.from('CIV6\0binary save bytes'),
      Buffer.from('-- PostgreSQL database dump\nCREATE TABLE players ();'),
    ])
      expect(validateRepositoryFile('data.bin', contents)[0]?.message).toContain('Database dumps and saved games')
  })

  test('matches only supplied private domains and their subdomains without exposing the hostname', () => {
    const domains = ['private.example.invalid']
    const source = Buffer.from('https://bot.PRIVATE.example.invalid/path')
    const diagnostics = validateRepositoryFile('src/config.ts', source, domains)
    expect(diagnostics[0]?.message).toContain('private deployment hostname')
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE.example.invalid')
    expect(validateRepositoryFile('src/config.ts', Buffer.from('See private.example.invalid.'), domains)).toHaveLength(
      1,
    )
    expect(validateRepositoryFile('src/config.ts', Buffer.from('https://notprivate.example.invalid'), domains)).toEqual(
      [],
    )
    expect(
      validateRepositoryFile('src/config.ts', Buffer.from('https://private.example.invalid.public.invalid'), domains),
    ).toEqual([])
    expect(validateRepositoryFile('src/config.ts', Buffer.from('CIVUP_TARGET=ppl'))).toEqual([])
    expect(() => validateRepositoryFile('src/config.ts', source, ['*.example.invalid'])).toThrow('exact hostnames')
  })

  test('matches injected private values literally and redacts them in filenames and diagnostics', () => {
    const identity = 'synthetic-private-identity.[]+'
    const diagnostics = validateRepositoryFile(
      `tests/${identity}.test.ts`,
      Buffer.from(`public line\nconst account = "${identity}"`),
      [],
      [identity],
    )
    expect(diagnostics).toEqual([
      {
        file: 'tests/[redacted private value].test.ts',
        line: 2,
        message: 'A private deployment identity must not be published.',
      },
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(identity)
    expect(
      validateRepositoryFile('tests/public.ts', Buffer.from('synthetic-private-identity'), [], [identity]),
    ).toEqual([])
  })
})

describe('Known local deployment identities', () => {
  test('automatically loads only selected private identities and splits guild lists', () => {
    const target = {
      accountId: 'synthetic-private-account',
      discord: {
        applicationId: 'synthetic-private-application',
        publicKey: 'synthetic-private-public-key',
        guildId: 'synthetic-private-guild',
        guildIds: 'synthetic-private-extra-guild, synthetic-private-other-guild',
      },
      activityOrigin: 'https://deployment.example.invalid/some/path',
      d1: { id: 'synthetic-private-database-id', name: 'generic-database' },
      kv: { id: 'synthetic-private-namespace-id', binding: 'generic-binding' },
      workers: { bot: 'generic-worker' },
      r2: { name: 'generic-bucket' },
      unrelated: { option: 'ordinary-option' },
    }
    const identities = [
      target.accountId,
      target.discord.applicationId,
      target.discord.publicKey,
      target.discord.guildId,
      ...target.discord.guildIds.split(/[,\s]+/),
      target.d1.id,
      target.kv.id,
    ]
    withPrivateConfig(
      JSON.stringify({ standard: target, ppl: { accountId: 'synthetic-second-account' } }),
      directory => {
        const candidates = identities.map((_, index) => `tests/identity-${index}.ts`)
        const { git } = workingFiles([...candidates, 'tests/public.ts', 'tests/host.ts', 'tests/second-target.ts'])
        const result = checkRepositoryPrivacy(directory, {
          git,
          readFile: file => {
            expect(file).not.toContain('cloudflare-targets.local.json')
            if (file.endsWith('public.ts'))
              return Buffer.from('generic-worker generic-bucket generic-database generic-binding ordinary-option')
            if (file.endsWith('host.ts')) return Buffer.from('https://DEPLOYMENT.example.invalid')
            if (file.endsWith('second-target.ts')) return Buffer.from('synthetic-second-account')
            const index = Number(/identity-(\d+)\.ts$/.exec(file)![1])
            return Buffer.from(`public\n${identities[index]}`)
          },
        })
        expect(result.files).toBe(candidates.length + 3)
        expect(result.diagnostics).toHaveLength(identities.length + 2)
        expect(result.diagnostics.some(item => item.file === 'tests/public.ts')).toBe(false)
        expect(result.diagnostics.filter(item => candidates.includes(item.file)).every(item => item.line === 2)).toBe(
          true,
        )
        for (const identity of [...identities, 'synthetic-second-account'])
          expect(JSON.stringify(result.diagnostics)).not.toContain(identity)
      },
    )
  })

  test('the command loads local identities automatically without reading environment files', () => {
    const { git } = workingFiles(['tests/leak.ts'])
    const reads: string[] = []
    const errors: string[] = []
    const value = 'synthetic-private-command-identity'
    expect(
      runRepositoryPrivacy([], root, {
        git,
        readPrivateConfig: file => {
          reads.push(file)
          return JSON.stringify({ ppl: { accountId: value } })
        },
        readFile: () => Buffer.from(`public\n${value}`),
        writeError: message => errors.push(message),
      }),
    ).toBe(1)
    expect(reads).toEqual([resolve(root, 'config/cloudflare-targets.local.json')])
    expect(errors).toEqual(['"tests/leak.ts":2: A private deployment identity must not be published.'])
    expect(errors.join('\n')).not.toContain(value)
  })

  test('missing local configuration still runs credential and structural checks in CI', () => {
    const { git } = committedTree(
      [{ file: 'apps/bot/.prod.secrets', contents: Buffer.from(githubToken) }],
      `Public commit\n${discordToken}`,
    )
    const result = checkRepositoryPrivacy(root, { ref: 'HEAD', git, readPrivateConfig: () => undefined })
    expect(result.diagnostics.map(item => item.message)).toEqual([
      'Actual environment, credential, and local configuration files must stay ignored.',
      'A GitHub credential must not be published.',
      'A Discord credential must not be published.',
    ])
    expect(result.diagnostics.at(-1)?.file).toBe('Commit metadata')
  })

  test('a force-added local configuration remains forbidden rather than exempting its contents', () => {
    withPrivateConfig(JSON.stringify({ ppl: { accountId: 'synthetic-private-force-added-id' } }), directory => {
      const { git } = workingFiles(['config/cloudflare-targets.local.json'])
      const result = checkRepositoryPrivacy(directory, { git })
      expect(result.diagnostics.some(item => item.message.includes('local configuration files'))).toBe(true)
      expect(result.diagnostics.some(item => item.message.includes('private deployment identity'))).toBe(true)
      expect(JSON.stringify(result.diagnostics)).not.toContain('synthetic-private-force-added-id')
    })
  })

  test('fails closed on malformed existing local JSON without printing any private contents', () => {
    const { git } = workingFiles([])
    const value = 'synthetic-private-invalid-json-value'
    withPrivateConfig(`{"ppl":{"accountId":"${value}"`, directory => {
      const errors: string[] = []
      expect(runRepositoryPrivacy([], directory, { git, writeError: message => errors.push(message) })).toBe(1)
      expect(errors).toEqual(['Local privacy settings are not valid JSON.'])
      expect(errors.join('\n')).not.toContain(value)
    })
    const errors: string[] = []
    expect(
      runRepositoryPrivacy([], root, {
        git,
        readPrivateConfig: () => {
          throw new Error(value)
        },
        writeError: message => errors.push(message),
      }),
    ).toBe(1)
    expect(errors).toEqual(['Could not read local privacy settings.'])
  })

  test('redacts known identities from unreadable filenames as well as config errors', () => {
    const identity = 'synthetic-private-error-identity'
    const { git } = workingFiles([`tests/${identity}.ts`])
    const errors: string[] = []
    expect(
      runRepositoryPrivacy([], root, {
        git,
        privateValues: [identity],
        readPrivateConfig: () => undefined,
        readFile: () => {
          throw new Error(identity)
        },
        writeError: message => errors.push(message),
      }),
    ).toBe(1)
    expect(errors).toEqual(['Could not read selected file "tests/[redacted private value].ts".'])
    expect(errors.join('\n')).not.toContain(identity)
  })

  test('checks identity fields without requiring complete provisioning configuration', () => {
    const { git } = workingFiles(['tests/public.ts'])
    expect(
      checkRepositoryPrivacy(root, {
        git,
        readPrivateConfig: () =>
          JSON.stringify({
            unrelated: 17,
            ppl: {
              discord: { applicationId: 'YOUR_DISCORD_APPLICATION_ID' },
              workers: false,
              bot: null,
              d1: { name: 42 },
            },
          }),
        readFile: () => Buffer.from('YOUR_DISCORD_APPLICATION_ID'),
      }),
    ).toEqual({ files: 1, diagnostics: [] })
    for (const config of [
      null,
      [],
      { ppl: { accountId: 42 } },
      { ppl: { discord: [] } },
      { ppl: { activityOrigin: 'not a URL' } },
    ]) {
      expect(() => checkRepositoryPrivacy(root, { git, readPrivateConfig: () => JSON.stringify(config) })).toThrow(
        'Local privacy settings',
      )
    }
  })
})

describe('Repository privacy Git selection', () => {
  test('checks changed working contents and unignored candidates, deduplicating tracked files', () => {
    const { git } = workingFiles(['src/changed.ts', 'new file.txt', 'src/changed.ts'])
    const reads: string[] = []
    const result = checkRepositoryPrivacy(root, {
      git,
      readFile: file => {
        reads.push(file)
        return Buffer.from(file.endsWith('changed.ts') ? githubToken : discordToken)
      },
    })
    expect(result.files).toBe(2)
    expect(reads).toHaveLength(2)
    expect(result.diagnostics.map(item => item.file).sort()).toEqual(['new file.txt', 'src/changed.ts'])
  })

  test('excludes deleted tracked paths even when their names are forbidden', () => {
    const { git } = workingFiles(['docs/old notes.md', 'src/keep.ts'], ['docs/old notes.md'])
    const reads: string[] = []
    const result = checkRepositoryPrivacy(root, {
      git,
      readFile: file => {
        reads.push(file)
        return Buffer.from('public content')
      },
    })
    expect(result).toEqual({ files: 1, diagnostics: [] })
    expect(reads).toEqual([resolve(root, 'src/keep.ts')])
  })

  test('NUL-delimited working paths preserve spaces, tabs, Unicode, and newlines', () => {
    const candidates = ['source with spaces.ts', 'a\tfile.txt', 'café.txt', 'two\nlines.txt']
    const { git } = workingFiles(candidates)
    const reads: string[] = []
    expect(
      checkRepositoryPrivacy(root, {
        git,
        readFile: file => {
          reads.push(file)
          return Buffer.from('public')
        },
      }),
    ).toEqual({ files: 4, diagnostics: [] })
    expect(reads.sort()).toEqual(candidates.map(file => resolve(root, file)).sort())
  })

  test('checks ignored committed files and blob contents, not the index, ignore rules, or working copies', () => {
    const { git, calls } = committedTree([
      { file: 'docs/ignored plan.md', contents: Buffer.from('private plan') },
      { file: 'ppl/ignored players.csv', contents: Buffer.from('private data') },
      { file: 'apps/bot/.prod.secrets', contents: Buffer.from(githubToken) },
      { file: 'src/changed file.ts', contents: Buffer.from(discordToken) },
    ])
    const result = checkRepositoryPrivacy(root, {
      ref: 'HEAD',
      git,
      readFile: () => {
        throw new Error('The working copy must not be read')
      },
    })
    expect(result.files).toBe(4)
    expect(new Set(result.diagnostics.map(item => item.file))).toEqual(
      new Set(['docs/ignored plan.md', 'ppl/ignored players.csv', 'apps/bot/.prod.secrets', 'src/changed file.ts']),
    )
    expect(calls.some(args => args[0] === 'ls-files')).toBe(false)
    expect(result.diagnostics.some(item => item.message.includes('Discord credential'))).toBe(true)
  })

  test('committed tree paths preserve tabs, newlines, and spaces; binary blobs preserve NUL bytes', () => {
    const { git } = committedTree([
      { file: 'a spaced\tname\nwith newline.bin', contents: Buffer.from(`binary\0${githubToken}\0`) },
    ])
    const result = checkRepositoryPrivacy(root, { ref: 'HEAD', git })
    expect(result.files).toBe(1)
    expect(result.diagnostics[0]?.file).toBe('a spaced\tname\nwith newline.bin')
    expect(result.diagnostics[0]?.message).toContain('GitHub credential')
  })

  test('checks commit messages for credentials and loaded private identities without exposing the body', () => {
    const identity = 'synthetic-private-commit-identity'
    const message = `Public subject\n\n${githubToken}\n${identity}\nhttps://commit.example.invalid\nSensitive explanation\n`
    const { git } = committedTree([{ file: 'src/public.ts', contents: Buffer.from('public') }], message)
    const errors: string[] = []
    expect(
      runRepositoryPrivacy(['--ref', 'HEAD'], root, {
        git,
        readPrivateConfig: () =>
          JSON.stringify({ ppl: { accountId: identity, activityOrigin: 'https://commit.example.invalid' } }),
        writeError: diagnostic => errors.push(diagnostic),
      }),
    ).toBe(1)
    expect(errors).toHaveLength(3)
    expect(errors.every(error => error.startsWith('"Commit metadata":'))).toBe(true)
    expect(errors).toContain('"Commit metadata":3: A GitHub credential must not be published.')
    expect(errors).toContain('"Commit metadata":4: A private deployment identity must not be published.')
    expect(errors).toContain('"Commit metadata":5: A private deployment hostname must not be published.')
    for (const privateText of [
      githubToken,
      identity,
      'commit.example.invalid',
      'Sensitive explanation',
      'Public subject',
    ])
      expect(errors.join('\n')).not.toContain(privateText)
  })

  test('fails closed if committed message metadata cannot be read completely', () => {
    const { git } = committedTree([])
    const missingMessage: PrivacyGitReader = (args, input) =>
      args[1] === 'commit' ? Buffer.from('tree incomplete') : git(args, input)
    expect(() => checkRepositoryPrivacy(root, { ref: 'HEAD', git: missingMessage })).toThrow(
      'incomplete commit metadata',
    )
  })

  test('fails closed on Git failures without forwarding potentially secret stderr or exceptions', () => {
    const errors: string[] = []
    expect(
      runRepositoryPrivacy(['--ref', 'HEAD'], root, {
        git: () => {
          throw new Error(githubToken)
        },
        writeError: message => errors.push(message),
      }),
    ).toBe(1)
    expect(errors).toEqual(['Could not read repository information from Git.'])
  })

  test('fails closed on unreadable candidates and does not print the underlying error', () => {
    const { git } = workingFiles(['src/changed.ts'])
    const errors: string[] = []
    expect(
      runRepositoryPrivacy([], root, {
        git,
        readFile: () => {
          throw new Error(discordToken)
        },
        writeError: message => errors.push(message),
      }),
    ).toBe(1)
    expect(errors).toEqual(['Could not read selected file "src/changed.ts".'])
  })

  test('rejects incomplete lists, unsafe paths, unresolved refs, submodules, and truncated blobs', () => {
    expect(() => checkRepositoryPrivacy(root, { git: () => Buffer.from('src/file.ts') })).toThrow(
      'incomplete file list',
    )
    expect(() => checkRepositoryPrivacy(root, { git: () => nul(['../secret.txt']) })).toThrow('safely')
    expect(() => checkRepositoryPrivacy(root, { ref: 'HEAD', git: () => Buffer.from('not-an-object\n') })).toThrow(
      'resolve',
    )
    const submodule: PrivacyGitReader = args =>
      args[0] === 'rev-parse' ? Buffer.from(`${commitId}\n`) : nul([`160000 commit ${commitId}\tsubmodule`])
    expect(() => checkRepositoryPrivacy(root, { ref: 'HEAD', git: submodule })).toThrow('Submodules')
    const { git } = committedTree([{ file: 'src/file.ts', contents: Buffer.from('public') }])
    const truncated: PrivacyGitReader = (args, input) => {
      const bytes = git(args, input)
      return args[0] === 'cat-file' ? bytes.subarray(0, bytes.length - 2) : bytes
    }
    expect(() => checkRepositoryPrivacy(root, { ref: 'HEAD', git: truncated })).toThrow(
      'invalid committed file contents',
    )
  })

  test('rejects invalid command arguments without echoing their values', () => {
    for (const args of [['--ref'], ['--ref', 'HEAD', '--ref', 'HEAD'], [`--${githubToken}`]]) {
      const errors: string[] = []
      expect(runRepositoryPrivacy(args, root, { writeError: message => errors.push(message) })).toBe(1)
      expect(errors.join('\n')).not.toContain(githubToken)
    }
  })

  test('uses only read-only Git plumbing against the current repository', () => {
    const script = resolve(repositoryRoot, 'scripts/check-repository-privacy.ts')
    const result = spawnSync(process.execPath, ['--no-env-file', script, '--ref', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })
    // Existing private paths can legitimately fail policy; a plumbing/read failure cannot.
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBeNull()
    expect([0, 1]).toContain(result.status!)
    expect(result.stderr).not.toMatch(/could not|cannot be checked|incomplete|invalid committed/i)
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /privacy check passed|must not be published|must stay|belongs? in/i,
    )
  })
})
