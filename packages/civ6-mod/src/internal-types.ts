import type { CivBlitzModCivilizationMetadata, CivBlitzModComponentMetadata, CivBlitzModLeaderMetadata } from './catalog-types.ts'
import type { CivBlitzModSeatInput } from './types.ts'

export interface ResolvedCivBlitzModSeat {
  input: CivBlitzModSeatInput
  token: string
  civilizationType: string
  leaderType: string
  leaderNameTag: string
  civilizationAbility: CivBlitzModComponentMetadata
  leaderAbility: CivBlitzModComponentMetadata
  infrastructure: CivBlitzModComponentMetadata
  unit: CivBlitzModComponentMetadata
  sourceCivilization: CivBlitzModCivilizationMetadata
  sourceLeader: CivBlitzModLeaderMetadata
}
