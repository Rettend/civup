import type { ConfigScreenProps } from '~/client/components/draft/ConfigScreen'
import { ConfigScreen } from '~/client/components/draft/ConfigScreen'

export type DraftSetupPageProps = ConfigScreenProps

/** Draft setup page wrapper used while the old ConfigScreen is still the implementation. */
export function DraftSetupPage(props: DraftSetupPageProps) {
  return <ConfigScreen {...props} />
}
