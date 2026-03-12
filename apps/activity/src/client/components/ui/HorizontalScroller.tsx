import type { JSX } from 'solid-js'
import { createSignal, splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

interface HorizontalScrollerProps extends JSX.HTMLAttributes<HTMLDivElement> {
  contentClass?: string
  viewportRef?: (element: HTMLDivElement) => void
}

export function HorizontalScroller(props: HorizontalScrollerProps) {
  const [local, rest] = splitProps(props, ['children', 'class', 'contentClass', 'viewportRef'])
  const [isDragging, setIsDragging] = createSignal(false)
  let viewport: HTMLDivElement | undefined
  let pointerId: number | null = null
  let dragStartX = 0
  let dragStartScrollLeft = 0

  const stopDragging = () => {
    pointerId = null
    setIsDragging(false)
  }

  const handlePointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return

    const element = viewport ?? event.currentTarget
    if (element.scrollWidth <= element.clientWidth) return

    pointerId = event.pointerId
    dragStartX = event.clientX
    dragStartScrollLeft = element.scrollLeft
    setIsDragging(false)
    element.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (pointerId !== event.pointerId) return

    const element = viewport ?? event.currentTarget
    const deltaX = event.clientX - dragStartX
    if (!isDragging() && Math.abs(deltaX) <= 3) return

    event.preventDefault()
    setIsDragging(true)
    element.scrollLeft = dragStartScrollLeft - deltaX
  }

  const handlePointerEnd = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (pointerId !== event.pointerId) return

    const element = viewport ?? event.currentTarget
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    stopDragging()
  }

  return (
    <div
      ref={(element) => {
        viewport = element
        local.viewportRef?.(element)
      }}
      class={cn('civup-h-scroll overflow-x-auto overflow-y-hidden overscroll-x-contain', isDragging() && 'is-dragging', local.class)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      {...rest}
    >
      <div class={cn('min-w-max', local.contentClass)}>
        {local.children}
      </div>
    </div>
  )
}
