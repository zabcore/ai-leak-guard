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
//   4. Exercise each path in order with SYNTHETIC TEST FILES ONLY (see
//      "Test files" below). Never use real customer or patient files.
//      Paths to walk, one per matrix cell:
//        (a) Click the composer's file-attach button, pick ONE file.
//        (b) Click the button, pick TWO OR MORE files (Ctrl/Cmd-click).
//        (c) Drag ONE file onto the composer and release.
//        (d) Drag ONE file over the composer but ESCAPE-out (release outside).
//        (e) Attach a file, then click the composer's own X to remove it
//            before hitting Send.
//   5. Copy the console output into the PR discussion for each site.
//      IMPORTANT: this script deliberately does NOT log File.name to
//      guard against pasting file names into a PR by mistake — but the
//      site's own UI (thumbnails, filename chips) may still display real
//      names, so it is on the reviewer to keep those out of any pasted
//      screenshots or transcripts.
//
// TEST FILES
// Use synthetic, non-identifying files created for this spike, e.g.:
//   printf 'hello' > /tmp/spike-a0-doc.pdf
//   printf 'hello' > /tmp/spike-a0-image.png
// Do NOT use documents that contain real customer, patient, employee,
// or any personal data — even the file name in the site's own thumbnails
// can leak identity into console screenshots.
//
// WHAT IT PROVES
//   - Whether a discoverable `<input type="file">` exists in the light
//     DOM or an open shadow root (`inputs` count at install time, and
//     re-scanned on DOM mutations in every tracked open ShadowRoot).
//   - Whether `change` events on file inputs reach a window-capture
//     listener at all — this is the necessary condition for any
//     interception mechanism to work. When the event originates inside
//     a closed shadow root, `event.target` is retargeted to the shadow
//     host and file metadata is unavailable at window; the observer
//     still logs the event so the reviewer can distinguish "no event
//     reached window" (a truly closed seam) from "event reached window
//     but target is the shadow host" (interception still possible;
//     replay likely not).
//   - Whether `dragover` / `drop` fire on window and what the drop
//     target's tag/role/dataset is (indicates whether the composer or
//     a dropzone descendant handles it).
//   - Whether the browser fires a follow-up `input` event on the file
//     input (some frameworks re-read the input on `input`, not
//     `change`).
//
// WHAT `eventPhase` AND `currentTarget` REPORT HERE
//   The values recorded on each event line refer to THIS window-capture
//   observer, not to any host-page listener. `eventPhase` will always be
//   1 (CAPTURING_PHASE) because we register with `useCapture: true`, and
//   `currentTarget` will always be `window`. They are logged for
//   completeness only; you cannot infer whether the host attached its
//   listener in capture or bubble from these values.
//
// WHAT IT INTENTIONALLY DOES NOT PROVE
//   - Upload timing (is the network request fired on selection or on
//     submit?) — for this, use the DevTools Network tab in parallel and
//     note whether an upload request appears immediately after the
//     change/drop line. (The script cannot observe the site's fetch/XHR
//     without monkey-patching, which is intervention and is out of
//     scope.)
//   - Whether `stopImmediatePropagation` would actually prevent the
//     upload — that requires calling it, which this script must not do.
//
// SAFETY
//   - No preventDefault / stopPropagation calls anywhere below.
//   - No writes to input.files, input.value, DataTransfer, fetch, or
//     XHR.
//   - No network requests originated by this script.
//   - Uses closed shadow: no. Reads only.
//   - Does not patch Element.prototype.attachShadow.
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

  // Element-shape only: tag name and nothing else. `id`, `className`,
  // `role`, and `name` are all page-controlled and can carry account,
  // account-scoped, or document-identifying strings (e.g. an `aria-label`
  // that embeds a filename or an `id` derived from a user identifier).
  // Since the runbook says the observer output is safe to paste into a
  // PR, this function must not surface any of them.
  const describe = (node) => {
    if (!(node instanceof Element)) return String(node)
    return node.tagName.toLowerCase()
  }

  // NOTE: `File.name` is INTENTIONALLY omitted here. See the runbook in
  // the file header — file names can contain personal, customer, or
  // patient data and this script's output is meant to be safe to paste
  // into a PR discussion. Only non-identifying metadata is retained.
  const summarizeFiles = (files) => {
    if (!files) return null
    return {
      count: files.length,
      entries: Array.from(files).map((f) => ({
        size: f.size,
        type: f.type,
      })),
    }
  }

  const findFileInputs = (root = document) => {
    const inputs = Array.from(root.querySelectorAll('input[type="file"]'))
    // Also probe declared open shadow roots (we cannot pierce closed ones).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let n
    while ((n = walker.nextNode())) {
      if (n.shadowRoot) {
        inputs.push(...findFileInputs(n.shadowRoot))
      }
    }
    return inputs
  }

  // Collect every open ShadowRoot reachable from `root` so we can attach
  // MutationObservers to each one — a MutationObserver on documentElement
  // does NOT cross shadow boundaries even with subtree: true.
  const findOpenShadowRoots = (root = document) => {
    const roots = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let n
    while ((n = walker.nextNode())) {
      if (n.shadowRoot) {
        roots.push(n.shadowRoot)
        // Recurse into nested open shadow roots.
        roots.push(...findOpenShadowRoots(n.shadowRoot))
      }
    }
    return roots
  }

  const inputsNow = findFileInputs()
  console.log(
    `[spike-a0] observer installed on ${location.hostname} — file inputs (light DOM + open shadow roots): ${inputsNow.length}`,
    inputsNow.map(describe),
  )

  // Re-scan on DOM mutations so late-mounted composer inputs are surfaced.
  // MutationObserver does not cross shadow boundaries, so we install one
  // per known open ShadowRoot AND on document.documentElement, and on
  // every mutation we discover any newly-appeared open shadow roots and
  // attach observers to those too.
  const observedRoots = new WeakSet()
  let lastCount = inputsNow.length

  const onMutation = () => {
    // Discover shadow roots that appeared since the last tick.
    for (const shadowRoot of findOpenShadowRoots()) {
      if (!observedRoots.has(shadowRoot)) {
        observedRoots.add(shadowRoot)
        try {
          mo.observe(shadowRoot, { childList: true, subtree: true })
        } catch {
          // Some polyfilled roots reject observe(); ignore rather than
          // break the diagnostic.
        }
      }
    }
    const cur = findFileInputs().length
    if (cur !== lastCount) {
      lastCount = cur
      console.log(`[spike-a0] ${rel()} file-input count changed → ${cur}`)
    }
  }

  const mo = new MutationObserver(onMutation)
  mo.observe(document.documentElement, { childList: true, subtree: true })
  for (const shadowRoot of findOpenShadowRoots()) {
    observedRoots.add(shadowRoot)
    try {
      mo.observe(shadowRoot, { childList: true, subtree: true })
    } catch {
      // Ignore — same rationale as above.
    }
  }

  // Capture-phase window listeners so we see events during the window
  // capture phase. Passive: no preventDefault / stopPropagation.
  //
  // For change/input we log two shapes:
  //   1. `source: "file-input"` — a real, light-DOM `<input type="file">`
  //      fired. `files` carries the summary; interception AND replay are
  //      on the table.
  //   2. `source: "unknown-non-file-target"` — an event reached window
  //      whose target is NOT a file input and does NOT match any element
  //      the observer can identify (textareas, selects, contenteditables,
  //      or a shadow-host retargeting all look the same at this layer).
  //      This bucket is deliberately unresolved: it might indicate a
  //      closed-shadow file selection (Gemini's `<rich-textarea>`), but
  //      it might equally be the user tabbing through a form or typing
  //      into a textarea. The reviewer resolves it by correlating the
  //      log line with (a) the picker action they just performed and
  //      (b) an upload request in the Network tab firing in the same
  //      window. Do NOT infer closed-shadow origin from these lines
  //      alone; `composedPath()` cannot prove it.
  //   3. Everything else — non-file inputs, form fields with a known
  //      light-DOM target — is dropped as noise.
  const logChangeLike = (kind) => (ev) => {
    const t = ev.target
    const targetKnown = t instanceof HTMLInputElement && t.type === 'file'
    const path = ev.composedPath()
    // A "candidate" for possible closed-shadow attribution is only ever
    // an event whose top-of-composed-path IS its own target (retargeting
    // signature) AND whose target is not itself an HTMLInputElement.
    // That includes real closed-shadow retargeting to a shadow host, but
    // also every ordinary textarea / select / contenteditable change; the
    // observer cannot distinguish those two without cross-referencing the
    // reviewer's action + Network tab.
    const hasUnknownNonFileTarget =
      !targetKnown && path.length > 0 && path[0] === t && !(t instanceof HTMLInputElement)
    if (!targetKnown && !hasUnknownNonFileTarget) return

    console.log(`[spike-a0] ${rel()} ${kind}`, {
      phase: ev.eventPhase, // reflects THIS listener; always 1 (CAPTURING)
      currentTarget: describe(ev.currentTarget), // always window
      target: describe(t),
      targetKnown,
      source: targetKnown ? 'file-input' : 'unknown-non-file-target',
      multiple: targetKnown ? t.multiple : null,
      files: targetKnown ? summarizeFiles(t.files) : null,
      composedPathHead: path.slice(0, 6).map(describe),
    })
  }

  const logDragLike = (kind) => (ev) => {
    const dt = ev.dataTransfer
    const hasFiles = !!dt && dt.types && Array.from(dt.types).includes('Files')
    if (!hasFiles && kind !== 'drop') return // ignore text-drag noise
    console.log(`[spike-a0] ${rel()} ${kind}`, {
      phase: ev.eventPhase, // reflects THIS listener; always 1 (CAPTURING)
      currentTarget: describe(ev.currentTarget), // always window
      target: describe(ev.target),
      composedPath: ev.composedPath().slice(0, 6).map(describe),
      files: hasFiles ? summarizeFiles(dt.files) : null,
    })
  }

  window.addEventListener('change', logChangeLike('change'), true)
  window.addEventListener('input', logChangeLike('input'), true)
  window.addEventListener('dragenter', logDragLike('dragenter'), true)
  window.addEventListener('dragover', logDragLike('dragover'), true)
  window.addEventListener('drop', logDragLike('drop'), true)

  console.log('[spike-a0] Ready. Exercise the paths from the script header.')
})()
