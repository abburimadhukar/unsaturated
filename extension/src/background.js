/**
 * The click that starts everything.
 *
 * WHY THE PERMISSION IS NOT REQUESTED HERE — a bug found on 18 September 2026.
 *
 * The first version asked Chrome for the site permission inside this listener:
 *
 *   const granted = await chrome.permissions.contains(...)
 *                || await chrome.permissions.request(...);
 *
 * A click is a "user gesture", and `chrome.permissions.request` may only be
 * called while one is in hand. The `await` on the line before spends it, so
 * Chrome refused the request with "This function must be called during a user
 * gesture" — and pressing the toolbar button did nothing at all, silently.
 *
 * So the supported job sites are declared in the manifest and granted at
 * install, and anything else goes through a real button on a real page
 * (src/allow.html), where the gesture belongs to the click on that button.
 */

/** Runs the filler in every frame of a tab. Throws if we may not read the page. */
async function fill(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/content.js'],
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    // On a supported job site this simply works. Elsewhere, the click itself
    // grants `activeTab` for this tab, which is also enough.
    await fill(tab.id);
  } catch (err) {
    // No access to this page: offer to grant it, from a page with a button.
    try {
      const url = tab.url ? `?origin=${encodeURIComponent(new URL(tab.url).origin)}&tab=${tab.id}` : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`src/allow.html${url}`) });
    } catch (second) {
      // Nothing left to try. Say so in words: an unhandled rejection here shows
      // up on chrome://extensions as a bare "background.js:21 (anonymous
      // function)", which tells the person nothing at all — reported from a real
      // browser on 18 September 2026.
      console.error(
        'Unsaturated could not fill this page.',
        `\nFirst: ${err?.message ?? err}`,
        `\nThen: ${second?.message ?? second}`,
        `\nTab: ${tab.url ?? '(url not visible to the extension)'}`,
      );
    }
  }
});

// The "Allow" button on that page reports back here once Chrome has agreed.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'fill-tab' || !message.tabId) return;
  fill(message.tabId).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // an async reply is coming
});
