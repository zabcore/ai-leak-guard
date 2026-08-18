// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  armPassThroughOnce,
  clearFileInput,
  consumePassThroughIfArmed,
  releaseFiles,
  __resetPassThroughForTests,
} from '../src/content/upload-release'
import type { ExtractedFiles } from '../src/content/file-extraction'

afterEach(() => {
  __resetPassThroughForTests()
  document.body.innerHTML = ''
})

describe('pass-through-once guard', () => {
  it('is not consumed when nothing is armed', () => {
    expect(consumePassThroughIfArmed('change')).toBe(false)
  })

  it('is consumed exactly once when armed for the matching kind', () => {
    armPassThroughOnce('change')
    expect(consumePassThroughIfArmed('change')).toBe(true)
    // Second consume for the same kind must NOT slip through — otherwise
    // a later legitimate paste would bypass the interception.
    expect(consumePassThroughIfArmed('change')).toBe(false)
  })

  it('is not consumed by a different event kind', () => {
    armPassThroughOnce('change')
    expect(consumePassThroughIfArmed('drop')).toBe(false)
    // The change arming is still live for the correct kind.
    expect(consumePassThroughIfArmed('change')).toBe(true)
  })
})

describe('clearFileInput', () => {
  it('resets input.value to empty', () => {
    const input = document.createElement('input')
    input.type = 'file'
    // We cannot set input.value to a non-empty string in DOM (a real
    // browser rejects it for file inputs), so just verify the call is
    // safe and leaves value empty.
    clearFileInput(input)
    expect(input.value).toBe('')
    expect(input.files?.length).toBe(0)
  })

  it('clears a populated file list', () => {
    const input = document.createElement('input')
    input.type = 'file'
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const seed = new DataTransfer()
    seed.items.add(file)
    input.files = seed.files
    expect(input.files?.length).toBe(1)

    clearFileInput(input)
    expect(input.value).toBe('')
    expect(input.files?.length).toBe(0)
  })
})

describe('releaseFiles', () => {
  it('replays a change event on the origin input and reports "released"', () => {
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })

    let observedChanges = 0
    input.addEventListener('change', () => {
      observedChanges += 1
    })

    const state: ExtractedFiles = {
      kind: 'change',
      files: [file],
      originInput: input,
    }
    const outcome = releaseFiles(state)
    expect(outcome).toBe('released')
    expect(input.files?.length).toBe(1)
    expect(input.files?.[0]).toBe(file)
    expect(observedChanges).toBe(1)
  })

  it('arms pass-through-once and reports "needs-user-reattach" for a drop', () => {
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const state: ExtractedFiles = {
      kind: 'drop',
      files: [file],
      originInput: null,
    }
    const outcome = releaseFiles(state)
    expect(outcome).toBe('needs-user-reattach')
    // The next drop bypasses interception.
    expect(consumePassThroughIfArmed('drop')).toBe(true)
  })

  it('arms pass-through-once and reports "needs-user-reattach" for a paste', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const state: ExtractedFiles = {
      kind: 'paste',
      files: [file],
      originInput: null,
    }
    const outcome = releaseFiles(state)
    expect(outcome).toBe('needs-user-reattach')
    expect(consumePassThroughIfArmed('paste')).toBe(true)
  })

  it('arms the change pass-through before assigning input.files so the replayed change is not re-intercepted', () => {
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })

    // Simulate the content script's listener that would re-intercept:
    // it checks the guard BEFORE handling the event. Here we simulate
    // "would the listener bypass this change?" by consuming the guard
    // synchronously when the change fires. If the arming were done
    // AFTER `input.files = dt.files`, some frameworks synchronously
    // fire a change on the assignment; that would consume the arming
    // BEFORE releaseFiles' own dispatch, and the dispatched change
    // would be re-intercepted.
    let bypassedOnFirstChange = false
    input.addEventListener(
      'change',
      () => {
        // First change through the listener: it MUST see the guard as
        // armed. The listener consumes it; releaseFiles' dispatch is
        // the same event and doesn't need a second consumption.
        bypassedOnFirstChange = consumePassThroughIfArmed('change')
      },
      { once: true },
    )

    releaseFiles({ kind: 'change', files: [file], originInput: input })
    expect(bypassedOnFirstChange).toBe(true)
  })
})
