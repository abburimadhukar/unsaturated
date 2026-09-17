/**
 * The click that starts everything.
 *
 * Nothing is injected until the person presses the toolbar button, and the
 * extension asks for permission for that one site at that moment. There is no
 * `content_scripts` block in the manifest and no `<all_urls>` permission, so an
 * installed-but-unused extension can read nothing at all.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return;
  const origin = `${new URL(tab.url).origin}/*`;

  const granted = await chrome.permissions.contains({ origins: [origin] })
    || await chrome.permissions.request({ origins: [origin] });
  if (!granted) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['src/content.js'],
  });
});
