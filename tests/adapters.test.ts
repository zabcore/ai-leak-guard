// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
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

  it('dispatches a bubbling input event', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const spy = vi.spyOn(ta, 'dispatchEvent')
    fallback.insertText(ta, 'x')
    const dispatched = spy.mock.calls.map((call) => call[0].type)
    expect(dispatched).toContain('input')
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

  it('dispatches a bubbling change event', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const spy = vi.spyOn(ta, 'dispatchEvent')
    fallback.replaceContents(ta, 'restored')
    const dispatched = spy.mock.calls.map((call) => call[0].type)
    expect(dispatched).toContain('change')
  })

  it('returns false for a non-editable element', () => {
    expect(fallback.replaceContents(document.createElement('div'), 'x')).toBe(false)
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
