/**
 * The profile, kept in the browser's own extension storage.
 *
 * The résumé is held as a data URL so the content script can rebuild a real File
 * for the employer's file input without any network call. Nothing in here
 * reaches a server: this build has no account and talks to nobody.
 */
const TEXT_FIELDS = [
  'firstName', 'lastName', 'preferredName', 'email', 'phone',
  'city', 'region', 'country', 'postcode', 'address',
  'linkedin', 'github', 'website', 'currentCompany', 'currentTitle',
];

async function load() {
  const { profile } = await chrome.storage.local.get('profile');
  if (!profile) return;
  for (const key of TEXT_FIELDS) document.getElementById(key).value = profile[key] || '';
  if (profile.resume) {
    document.getElementById('resumeName').textContent = `Stored: ${profile.resume.name}`;
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const { profile: current } = await chrome.storage.local.get('profile');
  const profile = { ...(current || {}) };
  for (const key of TEXT_FIELDS) profile[key] = document.getElementById(key).value.trim();

  const file = document.getElementById('resume').files[0];
  if (file) {
    profile.resume = {
      name: file.name,
      dataUrl: await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(file);
      }),
    };
  }
  await chrome.storage.local.set({ profile });
  document.getElementById('saved').textContent = 'Saved';
  setTimeout(() => (document.getElementById('saved').textContent = ''), 2000);
});

load();
