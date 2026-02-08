import { unoMerge } from 'unocss-merge'

export function cn(...classValues: Parameters<typeof unoMerge>) {
  return unoMerge(...classValues)
}

export function minify(strings: TemplateStringsArray, ...values: any[]): string {
  let result = strings[0] || ''
  for (let i = 0; i < values.length; i++) result += values[i] + strings[i + 1]

  return result
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .trim()
}
