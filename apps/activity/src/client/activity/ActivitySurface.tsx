import type { JSX } from 'solid-js'
import { onCleanup, onMount } from 'solid-js'
import { UiScaleController } from '../components/ui/UiScaleController'

export default function ActivitySurface(props: { children?: JSX.Element }) {
  onMount(() => {
    document.title = 'Draft'
    document.body.classList.add('activity-surface')
    document.body.classList.remove('public-surface')
  })

  onCleanup(() => {
    document.body.classList.remove('activity-surface')
  })

  return (
    <>
      <UiScaleController />
      {props.children}
    </>
  )
}
