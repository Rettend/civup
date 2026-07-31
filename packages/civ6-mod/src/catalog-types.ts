export type CivBlitzModComponentCategory = 'civilizationAbility' | 'leaderAbility' | 'infrastructure' | 'unit'

export interface CivBlitzModComponentMetadata {
  category: CivBlitzModComponentCategory
  displayName: string
  civilizationType: string
  traitType: string
  playerItemTypes: readonly string[]
  grantTraitTypes: readonly string[]
  grantPlayerItemTypes: readonly string[]
  leaderType?: string
  unsupportedReason?: string
}

export interface CivBlitzModCivilizationMetadata {
  civilizationType: string
  name: string
  description: string
  adjective: string
  ethnicity: string
  capitalName: string
  civilizationName: string
  civilizationIcon: string
  civilizationAbilityName: string
  civilizationAbilityDescription: string
  civilizationAbilityIcon: string
  backgroundLeaderType: string
  audio: string
  cultures: readonly string[]
  unitCultures: readonly string[]
}

export interface CivBlitzModBlpEntry {
  parameterName: string
  name: string
  xlpClass: string
  xlpPath: string
  blpPackage: string
  libraryName: string
}

export interface CivBlitzModLeaderMetadata {
  leaderType: string
  leaderIcon: string
  leaderAbilityName: string
  leaderAbilityDescription: string
  leaderAbilityIcon: string
  portrait: string
  portraitBackground: string
  leaderEntry: CivBlitzModBlpEntry
  lightrigEntry: CivBlitzModBlpEntry
  colorKeyEntry: CivBlitzModBlpEntry
  audio: string
  fallbackLeader: string
}

export interface CivBlitzModLandmarkMetadata {
  collection: string
  name: string
  subjectName: string
  era: string
  asset: CivBlitzModBlpEntry
  entryName: string
  flatten: boolean
  traitType: string
}

export interface CivBlitzModBbgAdjacencyMetadata {
  yieldChangeId: string
  civilizationTrait?: string
  leaderTrait?: string
}
