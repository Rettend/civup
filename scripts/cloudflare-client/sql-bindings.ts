/** Keep Wrangler's transaction trimmer from changing words inside SQL data or comments. */
export function splitSqlScript(sql: string, splitter: (sql: string) => string[]): string[] {
  let marker = '__civup_sql_transaction__'
  while (sql.includes(marker)) marker += '_'
  const begin = `${marker}begin`
  const commit = `${marker}commit`
  const protectedSql = sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g,
    token => token.replaceAll('BEGIN TRANSACTION', begin).replaceAll('COMMIT;', commit),
  )
  return splitter(protectedSql).map(part => part.replaceAll(begin, 'BEGIN TRANSACTION').replaceAll(commit, 'COMMIT;'))
}

/** SQLite's positional slot count, ignoring literals/comments and sharing repeated named slots. */
export function countSqlBindings(sql: string): number {
  let quote: string | undefined
  let comment: 'line' | 'block' | undefined
  let slots = 0
  const names = new Set<string>()
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (comment === 'line') {
      if (char === '\n' || char === '\r') comment = undefined
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = undefined
        index++
      }
      continue
    }
    if (quote !== undefined) {
      if (char === quote) {
        if (next === quote && quote !== ']') index++
        else quote = undefined
      }
      continue
    }
    if (char === '-' && next === '-') {
      comment = 'line'
      index++
      continue
    }
    if (char === '/' && next === '*') {
      comment = 'block'
      index++
      continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char === '[' ? ']' : char
      continue
    }
    if (char === '?') {
      const numbered = /^\d+/.exec(sql.slice(index + 1))?.[0]
      if (numbered) {
        const slot = Number(numbered)
        if (!Number.isSafeInteger(slot) || slot < 1 || slot > 32766)
          throw new Error('Invalid numbered SQL binding slot.')
        slots = Math.max(slots, slot)
        index += numbered.length
      } else {
        slots++
      }
      continue
    }
    if (char === ':' || char === '@' || char === '$') {
      const name = /^[\w$\u0080-\uffff]+/.exec(sql.slice(index + 1))?.[0]
      if (!name) continue
      let token = `${char}${name}`
      index += name.length
      // SQLite also permits Tcl-style $name::suffix(any text) parameter names.
      if (char === '$') {
        while (sql.slice(index + 1, index + 3) === '::') {
          const suffix = /^[\w$\u0080-\uffff]+/.exec(sql.slice(index + 3))?.[0]
          if (!suffix) break
          token += `::${suffix}`
          index += 2 + suffix.length
        }
        if (sql[index + 1] === '(') {
          const end = sql.indexOf(')', index + 2)
          if (end < 0) throw new Error('Unterminated SQL binding name.')
          token += sql.slice(index + 1, end + 1)
          index = end
        }
      }
      if (!names.has(token)) {
        names.add(token)
        slots++
      }
    }
  }
  return slots
}
