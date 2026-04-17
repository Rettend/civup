import type { useDraftSetupState } from './useDraftSetupState'
import { MiniFrame, MiniSeatGrid } from '~/client/components/draft/MiniLayout'

type DraftSetupMiniState = ReturnType<typeof useDraftSetupState>['mini']

export function DraftSetupMiniView(props: { mini: DraftSetupMiniState }) {
  const mini = () => props.mini
  return (
    <MiniFrame
      modeLabel={mini().formatLabel()}
      title="Draft Setup"
      titleAccent={mini().titleAccent()}
      rightLabel={mini().rightLabel()}
    >
      <MiniSeatGrid columns={mini().columns()} />
    </MiniFrame>
  )
}
