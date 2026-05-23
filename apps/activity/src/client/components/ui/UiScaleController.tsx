import { createEffect, onCleanup, onMount } from 'solid-js'
import {
  decreaseUiScale,
  increaseUiScale,
  isMiniView,
  resetUiScale,
  uiScale,
} from '~/client/stores/ui-store'

const WHEEL_DELTA_PER_STEP = 100

export function UiScaleController() {
  let wheelDelta = 0

  createEffect(() => {
    if (typeof document === 'undefined') return

    const body = document.body
    const scale = isMiniView() ? 1 : uiScale() / 100

    body.style.setProperty('--civup-ui-scale', String(scale))
    body.style.setProperty('--civup-ui-scale-inverse', String(1 / scale))
    body.classList.toggle('civup-ui-scaled', scale !== 1)

    if (scale === 1) body.style.removeProperty('zoom')
    else body.style.setProperty('zoom', String(scale))
  })

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return

      const action = resolveScaleKeyAction(event)
      if (!action) return

      event.preventDefault()
      if (isMiniView()) return

      if (action === 'increase') increaseUiScale()
      else if (action === 'decrease') decreaseUiScale()
      else resetUiScale()
    }

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return

      event.preventDefault()
      if (isMiniView()) {
        wheelDelta = 0
        return
      }

      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      wheelDelta += delta

      if (wheelDelta >= WHEEL_DELTA_PER_STEP) {
        decreaseUiScale()
        wheelDelta = 0
      }
      else if (wheelDelta <= -WHEEL_DELTA_PER_STEP) {
        increaseUiScale()
        wheelDelta = 0
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    document.addEventListener('wheel', handleWheel, { passive: false })

    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('wheel', handleWheel)
    })
  })

  onCleanup(() => {
    if (typeof document === 'undefined') return
    document.body.style.removeProperty('--civup-ui-scale')
    document.body.style.removeProperty('--civup-ui-scale-inverse')
    document.body.style.removeProperty('zoom')
    document.body.classList.remove('civup-ui-scaled')
  })

  return null
}

function resolveScaleKeyAction(event: KeyboardEvent): 'increase' | 'decrease' | 'reset' | null {
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 'reset'
  if (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract') return 'decrease'
  if (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd') return 'increase'
  return null
}
