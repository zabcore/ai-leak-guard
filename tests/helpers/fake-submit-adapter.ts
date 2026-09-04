// Test-only SubmitAdapter. Never shipped. Lets a test script the
// composer text, make the read throw, and queue `resume()` results
// (`'submitted' | 'unknown' | 'failed'`) or make `resume()` throw,
// while counting every call so "exactly one submission" is a hard
// assertion rather than a vibe.

import type { ResumeResult, SubmitAdapter, SubmitCore } from '../../src/content/submit/submit-core'

export class FakeSubmitAdapter implements SubmitAdapter {
  readonly id: string
  text: string
  readThrows: Error | null = null
  resumeThrows: Error | null = null
  /** Consumed left-to-right; the last value repeats once the queue is empty. */
  resumeQueue: ResumeResult[]
  resumeCalls = 0
  readCalls = 0
  attachedTo: SubmitCore | null = null

  constructor(opts: { id?: string; text?: string; resume?: ResumeResult[] } = {}) {
    this.id = opts.id ?? 'fake'
    this.text = opts.text ?? ''
    this.resumeQueue = opts.resume ?? ['submitted']
  }

  attach(core: SubmitCore): void {
    this.attachedTo = core
  }

  readComposerText(): string {
    this.readCalls += 1
    if (this.readThrows) throw this.readThrows
    return this.text
  }

  resume(): ResumeResult {
    this.resumeCalls += 1
    if (this.resumeThrows) throw this.resumeThrows
    if (this.resumeQueue.length > 1) return this.resumeQueue.shift() as ResumeResult
    return this.resumeQueue[0] ?? 'submitted'
  }
}
