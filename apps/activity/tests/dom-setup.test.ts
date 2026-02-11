import { describe, expect, test } from 'bun:test'

describe('DOM test setup', () => {
  test('registers browser globals via happy-dom preload', () => {
    expect(typeof document).toBe('object')
    expect(typeof window).toBe('object')
    expect(typeof requestAnimationFrame).toBe('function')
  })

  test('supports basic DOM manipulation', () => {
    const button = document.createElement('button')
    button.textContent = 'Start draft'
    document.body.appendChild(button)

    const found = document.querySelector('button')
    expect(found?.textContent).toBe('Start draft')
  })
})
