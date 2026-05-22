// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getAdapterForHost, ADAPTERS, fallback } from '../src/content/adapters'
import chatgpt from '../src/content/adapters/chatgpt'
import claude from '../src/content/adapters/claude'
import gemini from '../src/content/adapters/gemini'
import perplexity from '../src/content/adapters/perplexity'
import copilot from '../src/content/adapters/copilot'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('getAdapterForHost', () => {
  it('returns the ChatGPT adapter for chatgpt.com', () => {
    expect(getAdapterForHost('chatgpt.com').id).toBe('chatgpt')
  })

  it('returns the ChatGPT adapter for chat.openai.com', () => {
    expect(getAdapterForHost('chat.openai.com').id).toBe('chatgpt')
  })

  it('returns the Claude adapter for claude.ai', () => {
    expect(getAdapterForHost('claude.ai').id).toBe('claude')
  })

  it('returns the Gemini adapter for gemini.google.com', () => {
    expect(getAdapterForHost('gemini.google.com').id).toBe('gemini')
  })

  it('returns the Perplexity adapter for www.perplexity.ai', () => {
    expect(getAdapterForHost('www.perplexity.ai').id).toBe('perplexity')
  })

  it('returns the Perplexity adapter for perplexity.ai', () => {
    expect(getAdapterForHost('perplexity.ai').id).toBe('perplexity')
  })

  it('returns the Copilot adapter for copilot.microsoft.com', () => {
    expect(getAdapterForHost('copilot.microsoft.com').id).toBe('copilot')
  })

  it('matches case-insensitively', () => {
    expect(getAdapterForHost('CHATGPT.COM').id).toBe('chatgpt')
  })

  it('returns the fallback adapter for an unknown host', () => {
    expect(getAdapterForHost('example.com').id).toBe('fallback')
  })

  it('returns the fallback adapter for an empty host', () => {
    expect(getAdapterForHost('').id).toBe('fallback')
  })
})

describe('ADAPTERS registry', () => {
  it('registers all five site adapters', () => {
    expect(ADAPTERS).toHaveLength(5)
    expect(ADAPTERS.map((a) => a.id)).toEqual([
      'chatgpt',
      'claude',
      'gemini',
      'perplexity',
      'copilot',
    ])
  })

  it('gives every adapter at least one domain', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.domains.length).toBeGreaterThan(0)
    }
  })

  it('uses an empty domain list for the fallback adapter', () => {
    expect(fallback.domains).toEqual([])
  })
})

describe('fallback.isPromptInput', () => {
  it('is true for a textarea', () => {
    expect(fallback.isPromptInput(document.createElement('textarea'))).toBe(true)
  })

  it('is true for a text input', () => {
    const input = document.createElement('input')
    input.type = 'text'
    expect(fallback.isPromptInput(input)).toBe(true)
  })

  it('is true for a contenteditable div', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    expect(fallback.isPromptInput(div)).toBe(true)
  })

  it('is false for a plain div', () => {
    expect(fallback.isPromptInput(document.createElement('div'))).toBe(false)
  })

  it('is false for a span', () => {
    expect(fallback.isPromptInput(document.createElement('span'))).toBe(false)
  })
})

describe('fallback.insertText', () => {
  it('returns true and inserts into an empty textarea', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    expect(fallback.insertText(ta, 'masked')).toBe(true)
    expect(ta.value).toBe('masked')
  })

  it('dispatches bubbling input and change events', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const spy = vi.spyOn(ta, 'dispatchEvent')
    fallback.insertText(ta, 'x')
    const inputEvt = spy.mock.calls.find(([evt]) => evt.type === 'input')?.[0]
    const changeEvt = spy.mock.calls.find(([evt]) => evt.type === 'change')?.[0]
    expect(inputEvt?.bubbles).toBe(true)
    expect(changeEvt?.bubbles).toBe(true)
  })

  it('inserts at the current cursor position', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.value = 'AB'
    ta.selectionStart = 1
    ta.selectionEnd = 1
    fallback.insertText(ta, 'X')
    expect(ta.value).toBe('AXB')
  })

  it('returns false for a non-editable element', () => {
    expect(fallback.insertText(document.createElement('div'), 'x')).toBe(false)
  })
})

describe('fallback.replaceContents', () => {
  it('replaces the full textarea value and returns true', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.value = 'original secret text'
    expect(fallback.replaceContents(ta, 'restored')).toBe(true)
    expect(ta.value).toBe('restored')
  })

  it('dispatches bubbling input and change events', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const spy = vi.spyOn(ta, 'dispatchEvent')
    fallback.replaceContents(ta, 'restored')
    const inputEvt = spy.mock.calls.find(([evt]) => evt.type === 'input')?.[0]
    const changeEvt = spy.mock.calls.find(([evt]) => evt.type === 'change')?.[0]
    expect(inputEvt?.bubbles).toBe(true)
    expect(changeEvt?.bubbles).toBe(true)
  })

  it('returns false for a non-editable element', () => {
    expect(fallback.replaceContents(document.createElement('div'), 'x')).toBe(false)
  })
})

describe('fallback.isPromptInput input-type restriction', () => {
  const allowed = ['text', 'search', 'url', 'email', 'tel']
  it.each(allowed)('accepts input[type=%s]', (type) => {
    const input = document.createElement('input')
    input.setAttribute('type', type)
    expect(fallback.isPromptInput(input)).toBe(true)
  })

  it('accepts an input with no type attribute (defaults to text)', () => {
    expect(fallback.isPromptInput(document.createElement('input'))).toBe(true)
  })

  it('accepts an input with an empty type attribute', () => {
    const input = document.createElement('input')
    input.setAttribute('type', '')
    expect(fallback.isPromptInput(input)).toBe(true)
  })

  const excluded = [
    'checkbox',
    'radio',
    'submit',
    'button',
    'file',
    'image',
    'color',
    'hidden',
    'password',
    'range',
    'date',
    'time',
    'datetime-local',
    'month',
    'week',
    'number',
  ]
  it.each(excluded)('rejects input[type=%s]', (type) => {
    const input = document.createElement('input')
    input.setAttribute('type', type)
    expect(fallback.isPromptInput(input)).toBe(false)
  })
})

describe('fallback contenteditable handling', () => {
  let editable: HTMLElement

  beforeEach(() => {
    editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    // jsdom 29 does not define execCommand at all, so assign a mock that
    // simulates the parts the adapter relies on: insertText writes the value,
    // selectAll is a no-op.
    document.execCommand = vi.fn((command: string, _showUi?: boolean, value?: string): boolean => {
      if (command === 'insertText') {
        editable.textContent = value ?? ''
        return true
      }
      if (command === 'selectAll') {
        return true
      }
      return false
    })
  })

  afterEach(() => {
    delete (document as { execCommand?: Document['execCommand'] }).execCommand
  })

  it('insertText focuses the element, runs execCommand insertText, and updates content', () => {
    const focusSpy = vi.spyOn(editable, 'focus')
    const ok = fallback.insertText(editable, 'masked value')
    expect(ok).toBe(true)
    expect(focusSpy).toHaveBeenCalled()
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'masked value')
    expect(editable.textContent).toBe('masked value')
  })

  it('replaceContents focuses, selects all, runs insertText, and replaces content', () => {
    editable.textContent = 'original sensitive text'
    const focusSpy = vi.spyOn(editable, 'focus')
    const ok = fallback.replaceContents(editable, 'restored')
    expect(ok).toBe(true)
    expect(focusSpy).toHaveBeenCalled()
    expect(document.execCommand).toHaveBeenCalledWith('selectAll')
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'restored')
    expect(editable.textContent).toBe('restored')
  })
})

describe('site adapter isPromptInput', () => {
  it('chatgpt matches #prompt-textarea', () => {
    const el = document.createElement('div')
    el.id = 'prompt-textarea'
    el.setAttribute('contenteditable', 'true')
    expect(chatgpt.isPromptInput(el)).toBe(true)
  })

  it('chatgpt matches a contenteditable textbox', () => {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    el.setAttribute('role', 'textbox')
    expect(chatgpt.isPromptInput(el)).toBe(true)
  })

  it('claude matches a contenteditable textbox', () => {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    el.setAttribute('role', 'textbox')
    expect(claude.isPromptInput(el)).toBe(true)
  })

  it('gemini matches a contenteditable inside rich-textarea', () => {
    const wrapper = document.createElement('rich-textarea')
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    wrapper.appendChild(el)
    document.body.appendChild(wrapper)
    expect(gemini.isPromptInput(el)).toBe(true)
  })

  it('perplexity matches a textarea with an "Ask" placeholder', () => {
    const ta = document.createElement('textarea')
    ta.setAttribute('placeholder', 'Ask anything...')
    expect(perplexity.isPromptInput(ta)).toBe(true)
  })

  it('copilot matches a textarea', () => {
    expect(copilot.isPromptInput(document.createElement('textarea'))).toBe(true)
  })

  it('site adapters reject a plain div', () => {
    const div = document.createElement('div')
    expect(chatgpt.isPromptInput(div)).toBe(false)
    expect(claude.isPromptInput(div)).toBe(false)
    expect(gemini.isPromptInput(div)).toBe(false)
    expect(copilot.isPromptInput(div)).toBe(false)
  })
})
