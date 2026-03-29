const PLACEMENT_ICON_CLASSES = [
  '',
  'i-ph:number-one-bold',
  'i-ph:number-two-bold',
  'i-ph:number-three-bold',
  'i-ph:number-four-bold',
  'i-ph:number-five-bold',
  'i-ph:number-six-bold',
  'i-ph:number-seven-bold',
  'i-ph:number-eight-bold',
  'i-ph:number-nine-bold',
  'i-custom:number-ten-bold',
] as const

/** Icon class for a 1-based placement badge. */
export function placementIconClass(rank: number): string {
  return PLACEMENT_ICON_CLASSES[rank] ?? ''
}
