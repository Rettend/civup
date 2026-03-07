import { describe, expect, test } from 'bun:test'
import { formatModeLabel } from '../src/mode'

describe('formatModeLabel', () => {
  test('uses fallback for nullish or blank values', () => {
    expect(formatModeLabel(null, 'N/A')).toBe('N/A')
    expect(formatModeLabel(undefined, 'N/A')).toBe('N/A')
    expect(formatModeLabel('   ', 'N/A')).toBe('N/A')
  })

  test('normalizes default prefix and FFA casing', () => {
    expect(formatModeLabel('default-ffa')).toBe('FFA')
    expect(formatModeLabel('FFA')).toBe('FFA')
  })

  test('normalizes canonical mode casing', () => {
    expect(formatModeLabel('1V1')).toBe('1v1')
    expect(formatModeLabel('default-2V2')).toBe('2v2')
    expect(formatModeLabel('3V3')).toBe('3v3')
  })

  test('replaces dashes with spaces for other modes', () => {
    expect(formatModeLabel('default-2v2')).toBe('2v2')
    expect(formatModeLabel('duel-ranked')).toBe('duel ranked')
  })
})
