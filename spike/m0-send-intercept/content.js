// ALG M0 spike — isolated-world instrumentation + resume harness.
// THROWAWAY. NEVER SHIPS. NEVER MERGES INTO THE PRODUCT BUILD.
//
// WHAT THIS DOES
//   Passive pass (always on, log-only, never preventDefault):
//     • window-capture + document-capture `keydown` → logs ordering,
//       isTrusted, isComposing, keyCode (229 = IME), key, shift/ctrl/
//       meta/alt, and a content-free composer snapshot (length + hash).
//     • window-BUBBLE `keydown` → logs `defaultPrevented`. If the site
//       (ProseMirror / React onKeyDown / Angular) called preventDefault
//       on Enter, this flips to true — proving the site's handler ran
//       AFTER our capture listener (Q2).
//     • window-capture + window-bubble `click` and `pointerdown` → same,
//       filtered to clicks whose composedPath crosses a send-button-
//       shaped element OR any button (so suggested-prompt chips and
//       regenerate buttons are visible for the Q7 bypass hunt).
//     • MutationObserver → logs `THREAD` the moment the MARKER string
//       appears in a DOM node OUTSIDE the composer = "actually
//       submitted". This is the ground-truth signal for Q1.
//     • Receives `NET` records from net-sniffer.js (MAIN world) and
//       correlates: a send-like request with no Enter/send-click in the
//       preceding 3 s is flagged `BYPASS` (Q7).
//
//   Resume test (armed from the floating panel, one send at a time):
//     Arm → next real Enter (not Shift, not IME) or send-button click is
//     preventDefault + stopImmediatePropagation + stopPropagation'd
//     (`BLOCKED`). After 1500 ms — long enough to SEE the text still
//     sitting in the composer — we attempt the chosen resume:
//       (a) sendButton.click()
//       (b) new KeyboardEvent('keydown', {key:'Enter', bubbles:true, …})
//           dispatched on the composer
//       (c) none — control, proves the block itself works
//     then watch 6 s for `THREAD` (marker in conversation) and/or a
//     send-like `NET`. Logs `RESULT: SUBMITTED via <a|b>` or
//     `RESULT: NO-OP`. isTrusted of the synthetic event is logged.
//
// PRIVACY
//   Never logs composer content. The passive pass logs length + a
//   djb2 hash only. The only literal text ever logged is the
//   synthetic MARKER below. Do not paste real content while testing.
//
// LOG FORMAT
//   `[ALG-M0] <TYPE> <json>` — every line has `t` (performance.now ms).
//   The panel's "Copy log" button copies the whole ring buffer as
//   newline-delimited JSON for pasting into the feasibility note.
;(() => {
  'use strict'
  const PREFIX = '[ALG-M0]'
  const CHANNEL = '__alg_m0_spike__'
  const MARKER = 'ALGTEST Jane Doe MRN 12345678'
  const SITE = (() => {
    const h = location.hostname
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt'
    if (h === 'claude.ai') return 'claude'
    if (h === 'gemini.google.com') return 'gemini'
    if (h.endsWith('perplexity.ai')) return 'perplexity'
    return 'unknown'
  })()

  // ───────────────────────── log buffer ─────────────────────────
  const LOG = []
  const MAX_LOG = 2000
  function log(type, data) {
    const rec = { t: Math.round(performance.now()), type, site: SITE, ...data }
    LOG.push(rec)
    if (LOG.length > MAX_LOG) LOG.shift()
    console.log(PREFIX, type, JSON.stringify(rec))
    return rec
  }

  // ───────────────────────── helpers ─────────────────────────
  function djb2(s) {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(16)
  }
  function describe(el) {
    if (!el || !(el instanceof Element)) return String(el && el.nodeName)
    const parts = [el.tagName.toLowerCase()]
    if (el.id) parts.push('#' + el.id)
    for (const a of [
      'data-testid',
      'aria-label',
      'role',
      'type',
      'contenteditable',
      'placeholder',
    ]) {
      const v = el.getAttribute(a)
      if (v) parts.push(`[${a}="${v.slice(0, 40)}"]`)
    }
    if (el.className && typeof el.className === 'string')
      parts.push('.' + el.className.trim().split(/\s+/).slice(0, 3).join('.'))
    return parts.join('')
  }
  function pathSummary(ev, n = 6) {
    try {
      return ev.composedPath().slice(0, n).map(describe)
    } catch {
      return []
    }
  }

  // ───────────────────── composer discovery (Q3) ─────────────────────
  const COMPOSER_SELECTORS = {
    chatgpt: ['#prompt-textarea', '[contenteditable="true"][role="textbox"]', 'textarea'],
    claude: ['[contenteditable="true"][role="textbox"]', '.ProseMirror[contenteditable="true"]'],
    gemini: ['rich-textarea [contenteditable="true"]', '[contenteditable="true"][role="textbox"]'],
    perplexity: ['textarea[placeholder*="Ask"]', 'textarea', '[contenteditable="true"]'],
    unknown: ['[contenteditable="true"]', 'textarea'],
  }
  function findComposer() {
    for (const sel of COMPOSER_SELECTORS[SITE]) {
      const el = document.querySelector(sel)
      if (el) return el
    }
    const ae = document.activeElement
    if (ae && (ae.isContentEditable || ae.tagName === 'TEXTAREA')) return ae
    return null
  }
  function composerText(el) {
    if (!el) return ''
    return el.tagName === 'TEXTAREA' ? el.value : el.textContent || ''
  }
  function composerSnapshot(el) {
    const txt = composerText(el)
    return { len: txt.length, hash: djb2(txt), hasMarker: txt.includes(MARKER) }
  }
  function isComposerLike(el) {
    if (!el || !(el instanceof Element)) return false
    if (el.tagName === 'TEXTAREA') return true
    if (el.isContentEditable) return true
    const c = findComposer()
    return !!(c && (c === el || c.contains(el)))
  }

  // ───────────────────── send-button discovery ─────────────────────
  const SEND_SELECTORS = {
    chatgpt: [
      'button[data-testid="send-button"]',
      '#composer-submit-button',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send" i]',
    ],
    claude: ['button[aria-label="Send Message"]', 'button[aria-label*="Send" i]'],
    gemini: ['button[aria-label*="Send" i]', 'button.send-button', '.send-button button'],
    perplexity: ['button[aria-label="Submit"]', 'button[aria-label*="Submit" i]'],
    unknown: ['button[aria-label*="Send" i]', 'button[type="submit"]'],
  }
  function findSendButton() {
    for (const sel of SEND_SELECTORS[SITE]) {
      const el = document.querySelector(sel)
      if (el) return { el, sel }
    }
    // Generic fallback: a button near the composer whose label smells like send.
    const c = findComposer()
    const cands = [...document.querySelectorAll('button')].filter((b) => {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')
      return /send|submit/i.test(label)
    })
    if (c && cands.length) {
      const cr = c.getBoundingClientRect()
      cands.sort((a, b) => {
        const d = (x) => {
          const r = x.getBoundingClientRect()
          return Math.hypot(r.left - cr.right, r.top - cr.bottom)
        }
        return d(a) - d(b)
      })
      return { el: cands[0], sel: 'generic-nearest:' + describe(cands[0]) }
    }
    return { el: null, sel: null }
  }
  function isSendButtonPath(ev) {
    const { el } = findSendButton()
    if (!el) return false
    return ev.composedPath().includes(el)
  }
  function pathHasButton(ev) {
    return ev.composedPath().some((n) => n instanceof Element && n.tagName === 'BUTTON')
  }

  // ───────────────────── React root detection (Q2) ─────────────────────
  function findReactRoot(from) {
    let el = from
    while (el) {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactContainer$') || k === '_reactRootContainer') return el
      }
      el = el.parentElement
    }
    return null
  }

  // ───────────────────── resume-test state ─────────────────────
  const state = {
    armed: null, // null | 'a' | 'b' | 'c'
    resuming: false, // true while WE dispatch synthetic events (so we don't block ourselves)
    blockedAt: null,
    resumeAt: null,
    resultTimer: null,
    lastUserSendT: -Infinity, // last trusted Enter / send-click, for BYPASS correlation
  }
  const isPlainEnter = (ev) =>
    ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229
  const isSendChord = (ev) => ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)

  // ───────────────────── passive: keydown ─────────────────────
  function keyRecord(ev, phaseLabel) {
    const composer = findComposer()
    return {
      phase: phaseLabel,
      key: ev.key,
      code: ev.code,
      keyCode: ev.keyCode,
      isTrusted: ev.isTrusted,
      isComposing: ev.isComposing,
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey,
      meta: ev.metaKey,
      alt: ev.altKey,
      repeat: ev.repeat,
      defaultPrevented: ev.defaultPrevented,
      target: describe(ev.target),
      targetIsComposer: isComposerLike(ev.target),
      composer: composerSnapshot(composer),
    }
  }

  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Enter') return
      const rec = keyRecord(ev, 'window-capture')
      if (state.resuming) rec.synthetic = 'ours'
      log('KEYDOWN', rec)
      if (ev.isTrusted && (isPlainEnter(ev) || isSendChord(ev)) && rec.targetIsComposer) {
        state.lastUserSendT = performance.now()
      }
      // Q3: re-read the composer after the site had a chance to rerender.
      requestAnimationFrame(() =>
        setTimeout(
          () => log('COMPOSER-AFTER-RAF', { composer: composerSnapshot(findComposer()) }),
          0,
        ),
      )
      maybeBlock(ev, 'keydown')
    },
    true,
  )
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Enter') return
      log('KEYDOWN', { phase: 'document-capture', defaultPrevented: ev.defaultPrevented })
    },
    true,
  )
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Enter') return
      // Bubble phase on window = LAST listener to run. defaultPrevented
      // here tells us whether the site's own handler fired in between.
      log('KEYDOWN-BUBBLE', {
        phase: 'window-bubble',
        defaultPrevented: ev.defaultPrevented,
        isTrusted: ev.isTrusted,
        // NOTE: React expandos are NOT visible from the isolated world, so
        // this is always null here; the real answer is the REACT-ROOT line
        // posted by net-sniffer.js (MAIN world). Kept to document the gap.
        reactRootFromIsolatedWorld: describe(findReactRoot(ev.target)),
      })
    },
    false,
  )
  // keyup/keypress for the IME + double-Enter picture (Q4/Q6)
  for (const t of ['keypress', 'keyup']) {
    window.addEventListener(
      t,
      (ev) => {
        if (ev.key !== 'Enter' && ev.keyCode !== 229) return
        log(t.toUpperCase(), {
          phase: 'window-capture',
          keyCode: ev.keyCode,
          isComposing: ev.isComposing,
          isTrusted: ev.isTrusted,
        })
      },
      true,
    )
  }
  // compositionend is where IME confirmation actually lands (Q4)
  window.addEventListener(
    'compositionend',
    (ev) => log('COMPOSITIONEND', { dataLen: (ev.data || '').length, target: describe(ev.target) }),
    true,
  )

  // ───────────────────── passive: click / pointerdown ─────────────────────
  function clickRecord(ev, phaseLabel) {
    return {
      phase: phaseLabel,
      isTrusted: ev.isTrusted,
      defaultPrevented: ev.defaultPrevented,
      detail: ev.detail,
      onSendButton: isSendButtonPath(ev),
      target: describe(ev.target),
      path: pathSummary(ev),
      composer: composerSnapshot(findComposer()),
    }
  }
  window.addEventListener(
    'pointerdown',
    (ev) => {
      if (!pathHasButton(ev)) return
      log('POINTERDOWN', {
        isTrusted: ev.isTrusted,
        onSendButton: isSendButtonPath(ev),
        target: describe(ev.target),
      })
    },
    true,
  )
  window.addEventListener(
    'click',
    (ev) => {
      if (!pathHasButton(ev)) return
      const rec = clickRecord(ev, 'window-capture')
      if (state.resuming) rec.synthetic = 'ours'
      log('CLICK', rec)
      if (ev.isTrusted && rec.onSendButton) state.lastUserSendT = performance.now()
      if (rec.onSendButton) maybeBlock(ev, 'click')
    },
    true,
  )
  window.addEventListener(
    'click',
    (ev) => {
      if (!pathHasButton(ev)) return
      log('CLICK-BUBBLE', {
        phase: 'window-bubble',
        defaultPrevented: ev.defaultPrevented,
        onSendButton: isSendButtonPath(ev),
        reactRootFromIsolatedWorld: describe(findReactRoot(ev.target)), // see KEYDOWN-BUBBLE note
      })
    },
    false,
  )

  // ───────────────────── block + resume ─────────────────────
  function maybeBlock(ev, via) {
    if (!state.armed || state.resuming) return
    if (!ev.isTrusted) return // only ever block the REAL user send
    if (via === 'keydown' && !(isPlainEnter(ev) || isSendChord(ev))) return
    if (via === 'keydown' && !isComposerLike(ev.target)) return
    const mode = state.armed
    state.armed = null
    ev.preventDefault()
    ev.stopImmediatePropagation()
    ev.stopPropagation()
    state.blockedAt = performance.now()
    const composer = findComposer()
    log('BLOCKED', {
      via,
      mode,
      isTrusted: ev.isTrusted,
      composer: composerSnapshot(composer),
      sendButton: describe(findSendButton().el),
    })
    setPanelStatus(
      `BLOCKED (${via}). Text should still be in the composer. Resuming via (${mode}) in 1.5 s…`,
    )
    if (mode === 'c') {
      setPanelStatus(
        'BLOCKED — control mode, NO resume. If the message did not send, the block works.',
      )
      watchResult('c', composer)
      return
    }
    setTimeout(() => resume(mode, composer), 1500)
  }

  function resume(mode, composerAtBlock) {
    const composer = findComposer() || composerAtBlock
    const { el: btn, sel } = findSendButton()
    state.resuming = true
    state.resumeAt = performance.now()
    try {
      if (mode === 'a') {
        if (!btn) {
          log('RESUME', { mode, ok: false, reason: 'no send button found' })
          setPanelStatus('RESUME (a) failed: no send button found. See SENDBTN log.')
          state.resuming = false
          return
        }
        log('RESUME', {
          mode,
          mechanism: 'sendButton.click()',
          buttonSel: sel,
          buttonDisabled: btn.disabled,
          buttonAriaDisabled: btn.getAttribute('aria-disabled'),
          composerBefore: composerSnapshot(composer),
        })
        btn.click() // synthetic MouseEvent, isTrusted:false — our own capture listener logs it with synthetic:'ours'
      } else if (mode === 'b') {
        const init = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          composed: true,
        }
        const kd = new KeyboardEvent('keydown', init)
        // Chrome honours keyCode/which from init; belt-and-braces for engines that don't.
        try {
          if (kd.keyCode !== 13) Object.defineProperty(kd, 'keyCode', { get: () => 13 })
          if (kd.which !== 13) Object.defineProperty(kd, 'which', { get: () => 13 })
        } catch {
          /* ignore */
        }
        log('RESUME', {
          mode,
          mechanism: "composer.dispatchEvent(new KeyboardEvent('keydown', Enter))",
          dispatchTarget: describe(composer),
          isTrustedOfSynthetic: kd.isTrusted,
          keyCodeOfSynthetic: kd.keyCode,
          composerBefore: composerSnapshot(composer),
        })
        if (composer) composer.focus()
        const notCancelled = composer.dispatchEvent(kd)
        // Also fire keypress + keyup so a handler keyed on the full sequence sees it.
        composer.dispatchEvent(new KeyboardEvent('keypress', init))
        composer.dispatchEvent(new KeyboardEvent('keyup', init))
        log('RESUME-DISPATCHED', {
          mode,
          dispatchReturned: notCancelled,
          defaultPreventedBySite: kd.defaultPrevented,
        })
      }
    } catch (e) {
      log('RESUME', { mode, ok: false, error: String(e) })
    } finally {
      // Let the site's handlers (same tick) run before we drop the flag.
      setTimeout(() => {
        state.resuming = false
      }, 0)
    }
    watchResult(mode, composer)
  }

  // Ground truth: did the MARKER show up OUTSIDE the composer, and/or did a send-like NET fire?
  const result = { threadSeen: false, netSeen: false }
  function watchResult(mode, composer) {
    result.threadSeen = false
    result.netSeen = false
    const started = performance.now()
    clearTimeout(state.resultTimer)
    const tick = () => {
      const c = findComposer() || composer
      const stillInComposer = composerSnapshot(c).hasMarker
      if (result.threadSeen || result.netSeen) {
        log('RESULT', {
          mode,
          verdict: 'SUBMITTED',
          via: result.threadSeen ? 'marker-in-thread' : 'send-like-network-request',
          threadSeen: result.threadSeen,
          netSeen: result.netSeen,
          markerStillInComposer: stillInComposer,
          msSinceResume: Math.round(performance.now() - (state.resumeAt || started)),
        })
        setPanelStatus(
          `RESULT (${mode}): SUBMITTED ✅ — ${result.threadSeen ? 'marker appeared in thread' : 'send-like request fired'}`,
        )
        return
      }
      if (performance.now() - started > 6000) {
        log('RESULT', {
          mode,
          verdict: mode === 'c' ? 'BLOCKED-AS-EXPECTED' : 'NO-OP',
          markerStillInComposer: stillInComposer,
          note:
            mode === 'c'
              ? 'control: nothing should have sent'
              : 'synthetic resume did not submit within 6 s — isTrusted gate, disabled button, or state check',
        })
        setPanelStatus(
          mode === 'c'
            ? 'RESULT (c): nothing sent ✅ block works'
            : `RESULT (${mode}): NO-OP ❌ — resume did not submit (marker still in composer: ${stillInComposer})`,
        )
        return
      }
      state.resultTimer = setTimeout(tick, 250)
    }
    tick()
  }

  // ───────────────────── THREAD watcher (marker appears outside composer) ─────────────────────
  function installThreadWatcher() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          const txt = n.textContent || ''
          if (!txt.includes(MARKER)) continue
          const c = findComposer()
          const inside = c && (n === c || c.contains(n) || (n.contains && n.contains(c)))
          if (inside) continue
          result.threadSeen = true
          log('THREAD', {
            markerAppearedOutsideComposer: true,
            node: describe(n.nodeType === 1 ? n : n.parentElement),
            msSinceBlock: state.blockedAt ? Math.round(performance.now() - state.blockedAt) : null,
          })
        }
      }
    })
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  }

  // ───────────────────── NET records from MAIN world (Q7 bypass correlation) ─────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data[CHANNEL]) return
    const rec = ev.data[CHANNEL]
    if (rec.kind === 'react-root') {
      // Q2 diagnostic from the MAIN world (React expandos are invisible here).
      log('REACT-ROOT', rec)
      return
    }
    const sinceUserSend = performance.now() - state.lastUserSendT
    const sinceResume = state.resumeAt ? performance.now() - state.resumeAt : Infinity
    const entry = {
      ...rec,
      msSinceUserSend: isFinite(sinceUserSend) ? Math.round(sinceUserSend) : null,
      msSinceResume: isFinite(sinceResume) ? Math.round(sinceResume) : null,
    }
    if (rec.sendLike) {
      if (sinceResume < 6000) {
        result.netSeen = true
        entry.attributedTo = 'resume'
      } else if (sinceUserSend < 3000) {
        entry.attributedTo = 'user-send'
      } else {
        entry.attributedTo = 'BYPASS?'
        entry.note =
          'send-like request with no Enter/send-click in prior 3 s — chip, regenerate, voice, continue?'
        log('BYPASS', entry)
        setPanelStatus(
          '⚠ send-like request with NO Enter/send-click before it — note what you just clicked (Q7)',
        )
        return
      }
    }
    log('NET', entry)
  })

  // ───────────────────── floating panel ─────────────────────
  let statusEl = null
  function setPanelStatus(msg) {
    if (statusEl) statusEl.textContent = msg
  }
  function installPanel() {
    if (document.getElementById('alg-m0-panel-host')) return
    const host = document.createElement('div')
    host.id = 'alg-m0-panel-host'
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;all:initial;'
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        .p{font:12px/1.4 system-ui,sans-serif;background:#111;color:#eee;border:1px solid #444;border-radius:8px;
           padding:8px;width:300px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
        .p h1{font-size:12px;margin:0 0 6px;color:#ffb347}
        .p button{display:block;width:100%;margin:3px 0;padding:5px 6px;font:11px system-ui;background:#222;color:#eee;
           border:1px solid #555;border-radius:4px;cursor:pointer;text-align:left}
        .p button:hover{background:#333}
        .p .st{margin-top:6px;padding:6px;background:#000;border-radius:4px;min-height:2.4em;white-space:pre-wrap;color:#9fe}
        .p .mini{position:absolute;right:6px;top:4px;width:auto;display:inline;padding:0 5px}
        .p.min > *:not(h1):not(.mini){display:none}
      </style>
      <div class="p">
        <h1>ALG-M0 spike · ${SITE}</h1>
        <button class="mini" data-act="min">–</button>
        <button data-act="marker">1. Insert MARKER into composer</button>
        <button data-act="find">2. Find composer + send button (log)</button>
        <button data-act="arm-a">3a. Arm: block next send → resume via button.click()</button>
        <button data-act="arm-b">3b. Arm: block next send → resume via KeyboardEvent(Enter)</button>
        <button data-act="arm-c">3c. Arm: block next send → NO resume (control)</button>
        <button data-act="disarm">Disarm</button>
        <button data-act="summary">Summary → console</button>
        <button data-act="copy">Copy full log (NDJSON) to clipboard</button>
        <div class="st">idle · passive logging on</div>
      </div>`
    statusEl = root.querySelector('.st')
    root.querySelector('.p').addEventListener('click', (e) => {
      const b = e.target.closest('button')
      if (!b) return
      e.stopPropagation() // keep panel clicks out of the page's handlers AND our own click logger
      const act = b.dataset.act
      if (act === 'min') root.querySelector('.p').classList.toggle('min')
      if (act === 'marker') insertMarker()
      if (act === 'find') {
        const c = findComposer()
        const { el, sel } = findSendButton()
        log('DISCOVERY', {
          composer: describe(c),
          composerTag: c && c.tagName,
          composerInShadow: !!(c && c.getRootNode() instanceof ShadowRoot),
          sendButton: describe(el),
          sendButtonSel: sel,
          sendButtonDisabled: el ? el.disabled : null,
          reactRoot: describe(findReactRoot(c)),
        })
        setPanelStatus(`composer=${describe(c)}\nsend=${describe(el)} (${sel})`)
      }
      if (act === 'arm-a' || act === 'arm-b' || act === 'arm-c') {
        state.armed = act.slice(-1)
        log('ARMED', { mode: state.armed })
        setPanelStatus(`ARMED (${state.armed}). Now press Enter in the composer or click Send.`)
      }
      if (act === 'disarm') {
        state.armed = null
        setPanelStatus('disarmed · passive logging on')
      }
      if (act === 'summary') summary()
      if (act === 'copy') {
        const txt = LOG.map((r) => JSON.stringify(r)).join('\n')
        navigator.clipboard.writeText(txt).then(
          () => setPanelStatus(`copied ${LOG.length} log lines`),
          (err) => setPanelStatus('copy failed: ' + err),
        )
      }
    })
    document.documentElement.appendChild(host)
  }

  function insertMarker() {
    const c = findComposer()
    if (!c) return setPanelStatus('no composer found')
    c.focus()
    let ok = false
    try {
      ok = document.execCommand('insertText', false, MARKER)
    } catch {
      /* ignore */
    }
    if (!ok) {
      // Fallback for editors that ignore execCommand: InputEvent + direct set.
      if (c.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(c, c.value + MARKER)
        c.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: MARKER }),
        )
        ok = true
      } else {
        c.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: MARKER,
          }),
        )
        ok = composerText(c).includes(MARKER)
      }
    }
    log('MARKER-INSERT', { ok, composer: composerSnapshot(c) })
    setPanelStatus(
      ok
        ? 'marker inserted — now arm 3a/3b/3c and send'
        : 'marker insert FAILED — paste it manually: ' + MARKER,
    )
  }

  function summary() {
    const by = (t) => LOG.filter((r) => r.type === t)
    const s = {
      site: SITE,
      keydownEnterCaptured: by('KEYDOWN').filter((r) => r.phase === 'window-capture').length,
      keydownEnterSiteDefaultPrevented: by('KEYDOWN-BUBBLE').filter((r) => r.defaultPrevented)
        .length,
      imeKeydowns: by('KEYDOWN').filter((r) => r.isComposing || r.keyCode === 229).length,
      shiftEnters: by('KEYDOWN').filter((r) => r.phase === 'window-capture' && r.shift).length,
      ctrlOrMetaEnters: by('KEYDOWN').filter(
        (r) => r.phase === 'window-capture' && (r.ctrl || r.meta),
      ).length,
      sendButtonClicks: by('CLICK').filter((r) => r.onSendButton && r.phase === 'window-capture')
        .length,
      blocked: by('BLOCKED').map((r) => ({ via: r.via, mode: r.mode })),
      results: by('RESULT').map((r) => ({ mode: r.mode, verdict: r.verdict, via: r.via })),
      bypassCandidates: by('BYPASS').map((r) => ({
        kind: r.kind,
        method: r.method,
        path: r.path,
        t: r.t,
      })),
      // From the MAIN-world sniffer — React expandos are invisible here.
      reactRoot: (by('REACT-ROOT')[0] || {}).reactRoot || null,
    }
    log('SUMMARY', s)
    console.table(s.results)
    setPanelStatus('summary logged to console')
    return s
  }

  // ───────────────────── boot ─────────────────────
  function boot() {
    installThreadWatcher()
    installPanel()
    const c = findComposer()
    const { el, sel } = findSendButton()
    log('INSTALL', {
      readyState: document.readyState,
      composerFound: !!c,
      composer: describe(c),
      sendButtonFound: !!el,
      sendButton: describe(el),
      sendButtonSel: sel,
    })
  }
  log('INSTALL-EARLY', {
    readyState: document.readyState,
    note: 'window-capture listeners registered at document_start',
  })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
  // Composer/panel can be re-mounted by SPA navigation — re-assert the panel periodically.
  setInterval(() => {
    if (!document.getElementById('alg-m0-panel-host')) installPanel()
  }, 2000)
})()
