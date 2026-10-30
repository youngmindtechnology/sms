import { describe, expect, it } from 'vitest'
import { academicYearName } from './yearName'

describe('academicYearName', () => {
  it('writes a year that crosses two calendar years as 2026/2027', () => {
    expect(academicYearName('2026-09-07', '2027-07-30')).toBe('2026/2027')
  })
  it('writes a year inside one calendar year as just that year', () => {
    expect(academicYearName('2026-01-12', '2026-12-18')).toBe('2026')
  })
  it('is empty until both dates are filled in', () => {
    expect(academicYearName('', '2027-07-30')).toBe('')
    expect(academicYearName('2026-09-07', '')).toBe('')
    expect(academicYearName('2026-9-7', '2027-07-30')).toBe('')
  })
})