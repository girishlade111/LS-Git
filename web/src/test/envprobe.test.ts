import { it, expect } from 'vitest'
it('env probe', () => {
  console.log('localStorage type:', typeof localStorage)
  expect(true).toBe(true)
})
