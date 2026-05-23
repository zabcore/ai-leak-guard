import { describe, it, expect } from 'vitest'

// Runs in the default Node environment, where `window` and `document` are
// undefined — same as an MV3 service worker. Importing the service worker entry
// (and anything it pulls in) must not throw a ReferenceError.
describe('service worker entry', () => {
  it('runs in a DOM-less environment', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
  })

  it('imports without referencing window/document at module load', async () => {
    await expect(import('../src/background/service-worker')).resolves.toBeDefined()
  })
})
