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
    console.log(PREFIX, 'NET', JSON.stringify(rec))
    try {
      window.postMessage({ [CHANNEL]: rec }, '*')
    } catch {
      /* ignore */
    }
  }

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

  console.log(PREFIX, 'NET sniffer installed (MAIN world) on', location.hostname)
})()
