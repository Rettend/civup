/** D1 limits expression depth more strictly than the local SQLite test runner. */
export function balancedSqlAnd(predicates: readonly string[]): string {
  if (!predicates.length) return '1'
  if (predicates.length === 1) return predicates[0]!
  const middle = Math.floor(predicates.length / 2)
  return `(${balancedSqlAnd(predicates.slice(0, middle))} AND ${balancedSqlAnd(predicates.slice(middle))})`
}
