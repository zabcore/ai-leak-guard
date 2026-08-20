import { describe, expect, it } from 'vitest'
import {
  FSA_MESSAGE_SOURCE,
  isFsaHoldDecision,
  isFsaHoldRequest,
} from '../src/content/main-world/fsa-messages'

describe('isFsaHoldRequest', () => {
  const oneBlob = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })
  const validRequest = () => ({
    source: FSA_MESSAGE_SOURCE,
    kind: 'hold-request',
    id: 'alg-fsa-abc',
    files: [{ name: 'a.pdf', size: 100, type: 'application/pdf' }],
    blobs: [oneBlob()],
  })

  it('accepts a well-formed hold-request (metadata parallel to blobs)', () => {
    expect(isFsaHoldRequest(validRequest())).toBe(true)
  })

  it('accepts an empty files+blobs pair (the wrapper drops zero-file pickers before sending)', () => {
    expect(isFsaHoldRequest({ ...validRequest(), files: [], blobs: [] })).toBe(true)
  })

  it('rejects a foreign source tag (another page script posting to our window)', () => {
    expect(isFsaHoldRequest({ ...validRequest(), source: 'not-us' })).toBe(false)
  })

  it('rejects a wrong kind', () => {
    expect(isFsaHoldRequest({ ...validRequest(), kind: 'hold-decision' })).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(isFsaHoldRequest({ ...validRequest(), id: '' })).toBe(false)
  })

  it('rejects a non-string id', () => {
    expect(isFsaHoldRequest({ ...validRequest(), id: 42 })).toBe(false)
  })

  it('rejects when files is not an array', () => {
    expect(isFsaHoldRequest({ ...validRequest(), files: 'nope' })).toBe(false)
  })

  it('rejects a file entry missing name', () => {
    expect(
      isFsaHoldRequest({ ...validRequest(), files: [{ size: 1, type: 'application/pdf' }] }),
    ).toBe(false)
  })

  it('rejects a file entry with negative size', () => {
    expect(
      isFsaHoldRequest({
        ...validRequest(),
        files: [{ name: 'a.pdf', size: -1, type: 'application/pdf' }],
      }),
    ).toBe(false)
  })

  it('rejects when blobs is missing entirely', () => {
    const r = validRequest() as unknown as Record<string, unknown>
    delete r.blobs
    expect(isFsaHoldRequest(r)).toBe(false)
  })

  it('rejects when blobs is not an array', () => {
    expect(isFsaHoldRequest({ ...validRequest(), blobs: 'nope' })).toBe(false)
  })

  it('rejects when blobs length does not match files length', () => {
    expect(
      isFsaHoldRequest({
        ...validRequest(),
        files: [
          { name: 'a.pdf', size: 100, type: 'application/pdf' },
          { name: 'b.pdf', size: 100, type: 'application/pdf' },
        ],
        blobs: [oneBlob()],
      }),
    ).toBe(false)
  })

  it('rejects when a blob entry is not a File (e.g. a page script forging a plain object)', () => {
    expect(
      isFsaHoldRequest({
        ...validRequest(),
        blobs: [{ name: 'a.pdf', size: 100, type: 'application/pdf' }],
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
