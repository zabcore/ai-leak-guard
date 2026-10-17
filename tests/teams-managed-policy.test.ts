// Teams Lite (deployment m1) — managed policy reader + the constrained schema
// (Contract B §5): only `{ deploymentToken, autoEnroll? }`, never a backend URL.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseManagedPolicy, readManagedPolicy } from '../src/shared/teams-managed-policy'

const managed = (
  globalThis as unknown as { chrome: { storage: { managed: { __set: (v: unknown) => void } } } }
).chrome.storage.managed

describe('managed_schema.json', () => {
  const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8')) as {
    storage?: { managed_schema?: string }
  }

  it('the manifest declares the managed schema, shipped from public/', () => {
    expect(manifest.storage?.managed_schema).toBe('managed_schema.json')
  })

  it('declares ONLY deploymentToken:string + autoEnroll:boolean (no free-form baseUrl)', () => {
    const schema = JSON.parse(readFileSync(resolve('public/managed_schema.json'), 'utf8')) as {
      type: string
      properties: Record<string, { type: string }>
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties).sort()).toEqual(['autoEnroll', 'deploymentToken'])
    expect(schema.properties.deploymentToken?.type).toBe('string')
    expect(schema.properties.autoEnroll?.type).toBe('boolean')
    expect(JSON.stringify(schema).toLowerCase()).not.toMatch(/url|endpoint|host/)
  })
})

describe('parseManagedPolicy', () => {
  it('keeps the two known fields and drops everything else (a smuggled baseUrl is ignored)', () => {
    expect(
      parseManagedPolicy({
        deploymentToken: 'tok',
        autoEnroll: false,
        baseUrl: 'https://evil.example',
      }),
    ).toEqual({ deploymentToken: 'tok', autoEnroll: false })
  })

  it('wrongly-typed / empty values degrade to no policy', () => {
    expect(parseManagedPolicy(null)).toBeNull()
    expect(parseManagedPolicy({})).toBeNull()
    expect(parseManagedPolicy({ deploymentToken: 42, autoEnroll: 'yes' })).toBeNull()
    expect(parseManagedPolicy({ deploymentToken: '   ' })).toBeNull()
    expect(parseManagedPolicy({ deploymentToken: 'x'.repeat(5000) })).toBeNull()
  })
})

describe('readManagedPolicy', () => {
  it('returns null when no policy is set', async () => {
    expect(await readManagedPolicy()).toBeNull()
  })

  it('reads the policy from chrome.storage.managed', async () => {
    managed.__set({ deploymentToken: 'tok-A' })
    expect(await readManagedPolicy()).toEqual({ deploymentToken: 'tok-A' })
  })
})
