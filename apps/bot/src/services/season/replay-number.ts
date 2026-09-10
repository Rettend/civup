/** Mathematical replay comparison only; database source guards remain exact. */
export function sameReplayNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  return left === right || typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right))
}
