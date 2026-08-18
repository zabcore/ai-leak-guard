// AI Leak Guard — Spike A0: passive upload-event observer.
//
// PURPOSE
// Prove or falsify each cell of the compatibility matrix in
// docs/SPIKE_A0_UPLOAD_INTERCEPTION.md by reporting what actually happens
// on each site when the user picks or drops a file. NEVER intercepts,
// NEVER calls preventDefault / stopPropagation / stopImmediatePropagation,
// NEVER mutates input.files or window.fetch. If you catch this script
// altering native upload behavior, treat it as a bug in the script and
// don't ship the finding.
//
// HOW TO RUN
// This file is deliberately NOT part of the built extension — it is a
// throwaway diagnostic. Load it manually via Chrome DevTools:
//
//   1. Open the target site (chatgpt.com / claude.ai / gemini.google.com /
//      www.perplexity.ai / copilot.microsoft.com) in a normal (non-
//      incognito) window with the AI Leak Guard extension DISABLED so its
//      window-capture paste listener can't confound the drop-event trace.
//   2. Open DevTools → Sources → Snippets → New snippet → paste this file.
//   3. Right-click the snippet → Run. The console will print
//      `[spike-a0] observer installed on <hostname>` and then log one
//      structured line per file-related event.
//   4. Exercise each path in order and note the printed lines:
//        (a) Click the composer's file-attach button, pick ONE file.
//        (b) Click the button, pick TWO OR MORE files (Ctrl/Cmd-click).
//        (c) Drag ONE file onto the composer and release.
//        (d) Drag ONE file over the composer but ESCAPE-out (release outside).
//        (e) Attach a file, then click the composer's own X to remove it
//            before hitting Send.
//   5. Copy the console output into the PR discussion for each site.
//
// WHAT IT PROVES
//   - Whether a discoverable `<input type="file">` exists in the light DOM
//     (`inputs` count at install time, and re-scanned on DOM mutations).
//   - Whether `change` events on file inputs reach a window-capture listener
//     (they must, for our extension to be able to run before the host).
//   - Whether the host's own listener runs in capture or bubble, and on
//     which node in the flow — inferred from `eventPhase` and `currentTarget`.
//   - Whether `dragover` / `drop` fire on window and what the drop target's
//     tag/role/dataset is (indicates whether the composer or a dropzone
//     descendant handles it).
//   - Whether the browser fires a follow-up `input` event on the file input
//     (some frameworks re-read the input on `input`, not `change`).
//
// WHAT IT INTENTIONALLY DOES NOT PROVE
//   - Upload timing (is the network request fired on selection or on submit?)
//     — for this, use the DevTools Network tab in parallel and note whether
//     an upload request appears immediately after the change/drop line.
//     (The script cannot observe the site's fetch/XHR without monkey-
//     patching, which is intervention and is out of scope.)
//   - Whether stopImmediatePropagation would actually prevent the upload
//     — that requires calling it, which this script must not do.
//
// SAFETY
//   - No preventDefault / stopPropagation calls anywhere below.
//   - No writes to input.files, input.value, DataTransfer, fetch, or XHR.
//   - No network requests originated by this script.
//   - Uses closed shadow: no. Reads only.
//   - Guards against reinstalling itself when the snippet is re-run.

;(() => {
  const KEY = '__ai_leak_guard_spike_a0_installed__'
  if (window[KEY]) {
    console.warn('[spike-a0] observer already installed on this page; skipping re-install.')
    return
  }
  window[KEY] = true

  const t0 = performance.now()
  const rel = () => `+${Math.round(performance.now() - t0)}ms`

  const describe = (node) => {
    if (!(node instanceof Element)) return String(node)
    const bits = [node.tagName.toLowerCase()]
    if (node.id) bits.push(`#${node.id}`)
    if (node.className && typeof node.className === 'string') {
      const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.')
      if (cls) bits.push(`.${cls}`)
    }
    const role = node.getAttribute?.('role')
    if (role) bits.push(`[role=${role}]`)
    const name = node.getAttribute?.('name')
    if (name) bits.push(`[name=${name}]`)
    return bits.join('')
  }

  const summarizeFiles = (files) => {
    if (!files) return null
    const arr = Array.from(files)
    return arr.map((f) => ({ name: f.name, size: f.size, type: f.type }))
  }

  const findFileInputs = (root = document) => {
    const inputs = Array.from(root.querySelectorAll('input[type="file"]'))
    // Also probe declared shadow roots (open only — we cannot pierce closed).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let n
    while ((n = walker.nextNode())) {
      if (n.shadowRoot) {
        inputs.push(...findFileInputs(n.shadowRoot))
      }
    }
    return inputs
  }

  const inputsNow = findFileInputs()
  console.log(
    `[spike-a0] observer installed on ${location.hostname} — light-DOM file inputs: ${inputsNow.length}`,
    inputsNow.map(describe),
  )

  // Re-scan on DOM mutations so late-mounted composer inputs are surfaced.
  let lastCount = inputsNow.length
  const mo = new MutationObserver(() => {
    const cur = findFileInputs().length
    if (cur !== lastCount) {
      lastCount = cur
      console.log(`[spike-a0] ${rel()} file-input count changed → ${cur}`)
    }
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })

  // Capture-phase window listeners so we see events BEFORE the host handles
  // them. Passive: no preventDefault / stopPropagation.
  const logEvent = (kind) => (ev) => {
    // Only report file-relevant events to keep noise down.
    if (kind === 'change' || kind === 'input') {
      const t = ev.target
      if (!(t instanceof HTMLInputElement) || t.type !== 'file') return
      console.log(`[spike-a0] ${rel()} ${kind}`, {
        phase: ev.eventPhase, // 1 CAPTURING, 2 AT_TARGET, 3 BUBBLING
        target: describe(t),
        currentTarget: describe(ev.currentTarget),
        multiple: t.multiple,
        files: summarizeFiles(t.files),
      })
      return
    }
    if (kind === 'drop' || kind === 'dragover' || kind === 'dragenter') {
      const dt = ev.dataTransfer
      const hasFiles = !!dt && dt.types && Array.from(dt.types).includes('Files')
      if (!hasFiles && kind !== 'drop') return // ignore text-drag noise
      console.log(`[spike-a0] ${rel()} ${kind}`, {
        phase: ev.eventPhase,
        target: describe(ev.target),
        currentTarget: describe(ev.currentTarget),
        composedPath: ev.composedPath().slice(0, 6).map(describe),
        files: hasFiles ? summarizeFiles(dt.files) : null,
      })
    }
  }

  window.addEventListener('change', logEvent('change'), true)
  window.addEventListener('input', logEvent('input'), true)
  window.addEventListener('dragenter', logEvent('dragenter'), true)
  window.addEventListener('dragover', logEvent('dragover'), true)
  window.addEventListener('drop', logEvent('drop'), true)

  console.log('[spike-a0] Ready. Exercise the paths from the script header.')
})()
