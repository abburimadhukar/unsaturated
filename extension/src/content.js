/**
 * What runs on the employer's page.
 *
 * It does nothing until asked. The extension has no content script registered
 * for any site: the service worker injects this file into the tab the person is
 * looking at, after they click the toolbar button and grant permission for that
 * one site. Filling is therefore always something a person started, on a page
 * they are looking at, in their own browser.
 *
 * The panel it draws is deliberately plain about three things: what was filled,
 * what was refused and why, and that we never press Submit.
 */
/*
 * The two modules below are loaded with a dynamic import rather than a static
 * one: `chrome.scripting.executeScript({files})` runs a CLASSIC script, so a
 * top-level `import` is a syntax error. They are web-accessible resources, which
 * is what makes `import(chrome.runtime.getURL(...))` legal here.
 */
const PANEL_ID = 'unsaturated-panel';

/** jsdom has no layout, a browser does — so visibility is measured here only. */
function isVisible(el) {
  if (!el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  // Greenhouse's résumé input is deliberately off-screen behind a drop zone, so
  // a file input is judged by its wrapper rather than by its own box.
  if (el.type === 'file') return true;
  return true;
}

function fields(describeField, doc = document) {
  return [...doc.querySelectorAll('input, textarea, select')]
    .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type))
    .map((el) => describeField(el, { visible: isVisible(el) }));
}

async function resumeFile(profile) {
  if (!profile.resume || !profile.resume.dataUrl) return null;
  const res = await fetch(profile.resume.dataUrl);
  const blob = await res.blob();
  return new File([blob], profile.resume.name, { type: blob.type || 'application/pdf' });
}

function panel() {
  let el = document.getElementById(PANEL_ID);
  if (el) return el.shadowRoot.querySelector('.body');
  el = document.createElement('div');
  el.id = PANEL_ID;
  el.attachShadow({ mode: 'open' });
  el.shadowRoot.innerHTML = `
    <style>
      .card { position: fixed; top: 16px; right: 16px; width: 320px; max-height: 80vh; overflow: auto;
              background: #fff; color: #111; border: 1px solid #d5d5d5; border-radius: 10px;
              box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.45 system-ui, sans-serif; z-index: 2147483647; }
      .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 600; }
      .hd .dot { width: 8px; height: 8px; border-radius: 50%; background: #e4572e; }
      .hd button { margin-left: auto; border: 0; background: none; font-size: 16px; cursor: pointer; color: #666; }
      .body { padding: 10px 12px; }
      h4 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
      ul { margin: 0; padding-left: 16px; }
      li { margin: 2px 0; }
      .ok { color: #1a7f37; }
      .why { color: #777; }
      .note { margin-top: 10px; padding: 8px; background: #fff8ec; border: 1px solid #f0dcb8; border-radius: 6px; }
    </style>
    <div class="card">
      <div class="hd"><span class="dot"></span> Unsaturated <button title="close">×</button></div>
      <div class="body">Reading the form…</div>
    </div>`;
  el.shadowRoot.querySelector('button').onclick = () => el.remove();
  document.documentElement.appendChild(el);
  return el.shadowRoot.querySelector('.body');
}

function render(body, result) {
  const li = (items, fn) => items.map(fn).join('');
  const name = (f) => (f.label || f.placeholder || f.name || f.id || 'field').slice(0, 60);
  body.innerHTML = `
    <div><strong>${result.done.length}</strong> filled ·
         <strong>${result.failed.length}</strong> failed ·
         <strong>${result.needsYou.length}</strong> left for you</div>
    ${result.done.length ? `<h4>Filled</h4><ul>${li(result.done, (d) => `<li class="ok">${name(d.field)} <span class="why">(${d.why})</span></li>`)}</ul>` : ''}
    ${result.failed.length ? `<h4>Could not fill</h4><ul>${li(result.failed, (d) => `<li>${name(d.field)} — ${d.reason}</li>`)}</ul>` : ''}
    ${result.needsYou.length ? `<h4>Needs you</h4><ul>${li(result.needsYou, (s) => `<li>${name(s.field)} <span class="why">(${s.reason})</span></li>`)}</ul>` : ''}
    <div class="note">Check every answer, then press the employer's own submit button.
    This extension never submits an application for you.</div>`;
}

/** Fields worth telling the person about: required, or a question we refused. */
function needsYou(skipped) {
  const interesting = ['sensitive', 'attestation', 'money', 'consent', 'narrative'];
  return skipped.filter((s) => s.field.required || interesting.includes(s.reason)).slice(0, 12);
}

async function run() {
  const body = panel();
  const [{ describeField, planFill }, { applyPlan }] = await Promise.all([
    import(chrome.runtime.getURL('src/matcher.js')),
    import(chrome.runtime.getURL('src/fill.js')),
  ]);
  const { profile } = await chrome.storage.local.get('profile');
  if (!profile) {
    body.innerHTML = 'No profile yet. Open the extension options and add your details.';
    return;
  }
  const plan = planFill(fields(describeField), profile);
  const result = await applyPlan(plan, { resumeFile: await resumeFile(profile) });
  render(body, { ...result, needsYou: needsYou(result.skipped) });
}

// Injected into every frame, but the panel belongs to the top document only.
run().catch((err) => {
  const body = panel();
  body.textContent = `Could not read this form: ${err.message}`;
});
