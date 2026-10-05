import type { Node } from 'oxc-parser'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseSync, visitorKeys } from 'oxc-parser'
import { createPlayerCopyVisitors, playerCopyMessage } from './rule.js'

export interface CopyDiagnostic {
  file: string
  line: number
  column: number
  message: string
  phrase?: string
}

function position(source: string, offset: number) {
  const prefix = source.slice(0, offset)
  return {
    line: prefix.split(/\r\n|\r|\n/).length,
    column: offset - Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r')),
  }
}

export function checkPlayerCopy(source: string, filename = 'message.tsx'): CopyDiagnostic[] {
  const result = parseSync(filename, source, { preserveParens: false })
  if (result.errors.length) {
    return result.errors.map(error => ({
      file: filename,
      ...position(source, error.labels[0]?.start ?? 0),
      message: `Cannot check player copy: ${error.message}`,
    }))
  }

  const parents = new WeakMap<Node, Node>()
  const diagnostics: CopyDiagnostic[] = []
  const visitors = createPlayerCopyVisitors(
    ({ node, data }: { node: Node; data: { phrase: string } }) => {
      diagnostics.push({
        file: filename,
        ...position(source, node.start),
        phrase: data.phrase,
        message: playerCopyMessage.replace('{{phrase}}', data.phrase),
      })
    },
    (node: Node) => parents.get(node),
  )

  function visit(node: Node, parent?: Node) {
    if (parent) parents.set(node, parent)
    if (node.type === 'Literal') visitors.Literal(node)
    else if (node.type === 'TemplateLiteral') visitors.TemplateLiteral(node)
    else if (node.type === 'JSXText') visitors.JSXText(node)

    for (const key of visitorKeys[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key]
      const children = Array.isArray(value) ? value : [value]
      for (const child of children)
        if (child && typeof child === 'object' && 'type' in child) visit(child as Node, node)
    }
  }

  visit(result.program)
  return diagnostics
}

export function findPlayerCopyFiles(root: string): string[] {
  const files: string[] = []
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path)
    }
  }

  for (const app of readdirSync(join(root, 'apps'), { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    const src = join(root, 'apps', app.name, 'src')
    if (existsSync(src)) collect(src)
  }
  return files.sort()
}

export function checkPlayerCopyFiles(root: string): { files: number; diagnostics: CopyDiagnostic[] } {
  const files = findPlayerCopyFiles(root)
  if (!files.length) throw new Error('No app source files found for the player-copy check.')
  return {
    files: files.length,
    diagnostics: files.flatMap(file => checkPlayerCopy(readFileSync(file, 'utf-8'), relative(root, file))),
  }
}
