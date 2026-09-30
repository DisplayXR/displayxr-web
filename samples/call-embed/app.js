// call-embed — the one-line <dxr-call> embed, exactly as the copy box on the page shows it.
// See docs/call.md and docs/rfcs/0003-call-developer-experience.md §1.
//
// Importing the call entry registers the <dxr-call> custom element; the element mounts the call
// in itself on connect (mountCall(this, attrsToOpts(this))) and leaves on disconnect. This page
// resolves the entry to ../../js/ through its import map so it runs off the checkout / GitHub
// Pages; a real page loads the pre-bundled dist/call.js from the CDN instead (same element).

import { inline3DAvailable } from '@displayxr/inline3d';
import * as callModule from '@displayxr/inline3d/call';

const q = new URLSearchParams(location.search);
const el = document.getElementById('call');
const status = document.getElementById('status');

// ── page switches → element attributes (the snippet needs none of them) ──────────────────────
// ?signal=dev → the local dev server; ?signal=wss://… → your own. No ?signal → the hosted server.
const signal = q.get('signal');
if (signal === 'dev') el.setAttribute('signaling', 'ws://localhost:8787');
else if (signal) el.setAttribute('signaling', signal);
if (q.get('accent')) el.setAttribute('accent', q.get('accent'));
if (q.get('layout') === 'speaker') el.setAttribute('layout', 'speaker');
if (q.has('debug')) el.options = { ...(el.options || {}), debug: true };

// ── status pill ──────────────────────────────────────────────────────────────────────────────
status.className = 'status ' + (inline3DAvailable() ? 'woven' : 'flat');
status.textContent = inline3DAvailable()
  ? 'DisplayXR Browser — stereo participants are woven glasses-free 3D; 2D participants are lifted where the display can.'
  : 'No inline-3D here — this is an ordinary 2D call (a stereo sender shows its left eye).';

// ── the element ──────────────────────────────────────────────────────────────────────────────
// The C1 element registers itself on import. If this checkout's call module predates it (the
// docs and the code land as separate PRs), fall back to mountCall on the same node so the page
// still demonstrates the widget, and say so.
if (!customElements.get('dxr-call')) {
  const { mountCall } = callModule;
  if (typeof mountCall === 'function') {
    mountCall(el, el.options || {}).then((call) => { el.call = call; });
    status.textContent += ' (<dxr-call> is not registered by this SDK build; mounted with mountCall() instead.)';
  } else {
    status.className = 'status flat';
    status.textContent = 'This SDK build has neither <dxr-call> nor mountCall() — the C1 call code has not landed here yet. The snippets below are still the ones to copy.';
  }
}

// Log every call event the element re-dispatches, same convention as the other samples.
for (const ev of ['joined', 'left', 'peer', 'peerleft', 'state', 'format', 'display', 'speaker', 'error', 'warning']) {
  el.addEventListener(`dxr-call:${ev}`, (e) => console.log(`[call-embed] ${ev} ${JSON.stringify(e.detail)}`));
}

// ── copy buttons ─────────────────────────────────────────────────────────────────────────────
for (const btn of document.querySelectorAll('.copy')) {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(`snippet-${btn.dataset.copy}`).textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      btn.dataset.done = '1';
    } catch {
      // No clipboard permission (an insecure context, a strict policy): select it for a manual copy.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(`snippet-${btn.dataset.copy}`));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      btn.textContent = 'Selected — press Ctrl/Cmd+C';
    }
    setTimeout(() => { btn.textContent = 'Copy'; delete btn.dataset.done; }, 1800);
  });
}

// Debug hooks, same convention as the other samples' __call.
window.__callEl = el;
Object.defineProperty(window, '__call', { get: () => el.call, configurable: true });
