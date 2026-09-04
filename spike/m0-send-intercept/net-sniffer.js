// ALG M0 spike — MAIN-world network sniffer. THROWAWAY. NEVER SHIPS.
//
// Runs in the page's own JS realm so it can wrap `window.fetch`,
// `XMLHttpRequest.prototype.send`, and `WebSocket.prototype.send`.
// The isolated-world content script cannot see the page's fetch.
//
// Logs ONLY: method, URL pathname (query string stripped), and a
// byte-length for WebSocket frames. NEVER logs a request body, a
// response, a header, or a query string. This is the "did a send
// request actually fire" signal for the resume test.
//
// Every observation is (a) logged to the shared page console with
// the `[ALG-M0] NET` prefix and (b) posted to the isolated world via
// `window.postMessage` so the content script's ring buffer + summary
// can correlate it with keydown/click timing.
;(() => {
  const PREFIX = '[ALG-M0]'
  const CHANNEL = '__alg_m0_spike__'

  // Heuristic: which requests look like "send a message". Per-site
  // paths observed at the time of writing; the generic regex catches
  // drift. The isolated world re-classifies, so over-matching here
  // is harmless — it just adds lines to the log.
  const SEND_LIKE =
    /conversation|completion|generate|StreamGenerate|perplexity_ask|\/ask|\/chat|\/message|\/query|\/rest\/sse/i

  function pathOf(input) {
    try {
      const u = new URL(typeof input === 'string' ? input : input.url, location.href)
      return u.origin === location.origin ? u.pathname : u.origin + u.pathname
    } catch {
      return String(input).slice(0, 120)
    }
  }

  function emit(kind, payload) {
    const rec = { kind, t: Math.round(performance.now()), ...payload }
    // Raw MAIN-world line. The isolated world re-logs the same record
    // as `NET` with send/resume/BYPASS correlation fields — that one
    // is canonical; this one only proves the wrapper fired even if
    // the isolated world failed to load. Different prefix so a
    // single request is not counted twice when grepping `NET `.
    console.log(PREFIX, 'NET-MAIN', JSON.stringify(rec))
    try {
      window.postMessage({ [CHANNEL]: rec }, '*')
    } catch {
      /* ignore */
    }
  }

  // ---- React root / fiber visibility (Q2 diagnostic) ----
  // React 17+ delegates events at the ROOT CONTAINER, not `document`,
  // and marks it with an expando `__reactContainer$<hash>`. Those
  // expandos live in the page realm and are INVISIBLE from a content
  // script's isolated world, so this probe has to run here. Log-only.
  function reactRootOf(from) {
    let el = from instanceof Element ? from : null
    while (el) {
      for (const k in el) {
        if (k.startsWith('__reactContainer$') || k === '_reactRootContainer') return el
      }
      el = el.parentElement
    }
    return null
  }
  function short(el) {
    if (!el) return null
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
  }
  let rootReported = false
  let misses = 0
  function reportRoot(ev) {
    if (rootReported) return
    if (ev.type === 'keydown' && ev.key !== 'Enter') return
    // Ignore our own floating panel — it is not in the page's React tree
    // and would otherwise latch a false "no React container" on the
    // first panel click.
    if (ev.composedPath().some((n) => n && n.id === 'alg-m0-panel-host')) return
    const root = reactRootOf(ev.target)
    // Latch on the first found root; for a non-React page, report
    // "none" only after three real (non-panel) events so a stray early
    // click on chrome outside the app can't mislabel the site.
    if (!root && ++misses < 3) return
    rootReported = true
    const rec = {
      kind: 'react-root',
      t: Math.round(performance.now()),
      target: short(ev.target),
      reactRoot: short(root),
      hasReactFiber: !!(
        ev.target && Object.keys(ev.target).some((k) => k.startsWith('__reactFiber$'))
      ),
      note: root
        ? 'React delegates at this container (below window/document in the capture path)'
        : 'no React container above target — not a React tree, or non-React composer',
    }
    console.log(PREFIX, 'REACT-ROOT', JSON.stringify(rec))
    try {
      window.postMessage({ [CHANNEL]: rec }, '*')
    } catch {
      /* ignore */
    }
  }
  window.addEventListener('keydown', reportRoot, true)
  window.addEventListener('click', reportRoot, true)

  // ---- fetch ----
  const origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const method = (init && init.method) || (input && input.method) || 'GET'
        const path = pathOf(input)
        if (method.toUpperCase() !== 'GET' || SEND_LIKE.test(path)) {
          emit('fetch', { method: method.toUpperCase(), path, sendLike: SEND_LIKE.test(path) })
        }
      } catch {
        /* never break the page */
      }
      return origFetch.apply(this, arguments)
    }
  }

  // ---- XHR ----
  const XHR = window.XMLHttpRequest
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open
    const origSend = XHR.prototype.send
    XHR.prototype.open = function (method, url) {
      try {
        this.__algM0 = { method: String(method).toUpperCase(), path: pathOf(url) }
      } catch {
        /* ignore */
      }
      return origOpen.apply(this, arguments)
    }
    XHR.prototype.send = function () {
      try {
        const m = this.__algM0
        if (m && (m.method !== 'GET' || SEND_LIKE.test(m.path))) {
          emit('xhr', { method: m.method, path: m.path, sendLike: SEND_LIKE.test(m.path) })
        }
      } catch {
        /* ignore */
      }
      return origSend.apply(this, arguments)
    }
  }

  // ---- WebSocket (Perplexity uses socket.io for queries) ----
  const WS = window.WebSocket
  if (WS && WS.prototype) {
    const origWsSend = WS.prototype.send
    WS.prototype.send = function (data) {
      try {
        const len =
          typeof data === 'string'
            ? data.length
            : data && typeof data.byteLength === 'number'
              ? data.byteLength
              : -1
        // socket.io ping/pong frames are tiny ("2"/"3"); skip them.
        if (len > 8)
          emit('ws', { method: 'WS', path: pathOf(this.url), bytes: len, sendLike: true })
      } catch {
        /* ignore */
      }
      return origWsSend.apply(this, arguments)
    }
  }

  // Distinct prefix on purpose: a banner starting with "NET " would
  // prefix-match a console filter for `NET ` and look like a request.
  console.log(
    PREFIX,
    'SNIFFER-INSTALLED',
    JSON.stringify({ world: 'MAIN', host: location.hostname }),
  )
})()
