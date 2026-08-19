import { describe, expect, it } from 'vitest'
import {
  FSA_MESSAGE_SOURCE,
  isFsaHoldDecision,
  isFsaHoldRequest,
} from '../src/content/main-world/fsa-messages'

describe('isFsaHoldRequest', () => {
  const validRequest = {
    source: FSA_MESSAGE_SOURCE,
    kind: 'hold-request',
    id: 'alg-fsa-abc',
    files: [{ name: 'a.pdf', size: 100, type: 'application/pdf' }],
  }

  it('accepts a well-formed hold-request', () => {
    expect(isFsaHoldRequest(validRequest)).toBe(true)
  })

  it('accepts an empty files array (the wrapper drops zero-file pickers before sending)', () => {
    expect(isFsaHoldRequest({ ...validRequest, files: [] })).toBe(true)
  })

  it('rejects a foreign source tag (another page script posting to our window)', () => {
    expect(isFsaHoldRequest({ ...validRequest, source: 'not-us' })).toBe(false)
  })

  it('rejects a wrong kind', () => {
    expect(isFsaHoldRequest({ ...validRequest, kind: 'hold-decision' })).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(isFsaHoldRequest({ ...validRequest, id: '' })).toBe(false)
  })

  it('rejects a non-string id', () => {
    expect(isFsaHoldRequest({ ...validRequest, id: 42 })).toBe(false)
  })

  it('rejects when files is not an array', () => {
    expect(isFsaHoldRequest({ ...validRequest, files: 'nope' })).toBe(false)
  })

  it('rejects a file entry missing name', () => {
    expect(
      isFsaHoldRequest({ ...validRequest, files: [{ size: 1, type: 'application/pdf' }] }),
    ).toBe(false)
  })

  it('rejects a file entry with negative size', () => {
    expect(
      isFsaHoldRequest({
        ...validRequest,
        files: [{ name: 'a.pdf', size: -1, type: 'application/pdf' }],
      }),
    ).toBe(false)
  })

  it('rejects null / non-object payloads', () => {
    expect(isFsaHoldRequest(null)).toBe(false)
    expect(isFsaHoldRequest('string')).toBe(false)
    expect(isFsaHoldRequest(undefined)).toBe(false)
    expect(isFsaHoldRequest([])).toBe(false)
  })
})

describe('isFsaHoldDecision', () => {
  const validDecision = {
    source: FSA_MESSAGE_SOURCE,
    kind: 'hold-decision',
    id: 'alg-fsa-abc',
    decision: 'upload-anyway',
  }

  it('accepts a well-formed upload-anyway decision', () => {
    expect(isFsaHoldDecision(validDecision)).toBe(true)
  })

  it('accepts a well-formed cancel decision', () => {
    expect(isFsaHoldDecision({ ...validDecision, decision: 'cancel' })).toBe(true)
  })

  it('rejects an unknown decision value', () => {
    expect(isFsaHoldDecision({ ...validDecision, decision: 'defer' })).toBe(false)
  })

  it('rejects a foreign source', () => {
    expect(isFsaHoldDecision({ ...validDecision, source: 'evil' })).toBe(false)
  })

  it('rejects wrong kind', () => {
    expect(isFsaHoldDecision({ ...validDecision, kind: 'hold-request' })).toBe(false)
  })

  it('rejects empty id', () => {
    expect(isFsaHoldDecision({ ...validDecision, id: '' })).toBe(false)
  })
})
