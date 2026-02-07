import { unoMerge } from 'unocss-merge'

// it's this:
// export function unoMerge(...classValues: ClassValue[]) {
//   const map = new Map<string, string>()
//   const className = clsx(...classValues)
//   const classList = getClassList(className).filter(Boolean)
//   classList.forEach((cls) => processCls(cls, map))
//   return uniq(Array.from(map.values())).join(' ')
// }
//
// so i think we just warp it? to create cn:

export function cn(...classValues: Parameters<typeof unoMerge>) {
  return unoMerge(...classValues)
}
