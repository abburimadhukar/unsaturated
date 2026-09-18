/**
 * Granting one site, from a real button.
 *
 * `chrome.permissions.request` needs a user gesture that has not been spent on
 * an `await`. A click on THIS button is that gesture, which is why the request
 * is the first thing the handler does — see the note in background.js.
 */
const params = new URLSearchParams(location.search);
const origin = params.get('origin');
const tabId = Number(params.get('tab'));
const state = document.getElementById('state');

if (origin) document.getElementById('origin').textContent = origin;
else document.getElementById('allow').disabled = true;

document.getElementById('allow').addEventListener('click', () => {
  // No await before this call.
  chrome.permissions.request({ origins: [`${origin}/*`] }, async (granted) => {
    if (!granted) {
      state.textContent = 'Not allowed — nothing was changed.';
      return;
    }
    const reply = await chrome.runtime.sendMessage({ type: 'fill-tab', tabId });
    state.textContent = reply?.ok
      ? 'Allowed. Filling that tab now — switch back to it.'
      : `Allowed, but the fill failed: ${reply?.error ?? 'unknown error'}`;
  });
});
