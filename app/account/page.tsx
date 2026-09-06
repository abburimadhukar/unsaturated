'use client';

import { useCallback, useEffect, useState } from 'react';
import { initialsOf } from '../../src/ui/initials.js';
import { ACCEPTED, extractResumeText, isAcceptedFile } from '../../src/ui/resume-file.js';

/**
 * Everything about the person, on one page.
 *
 * The header used to carry five controls in a row — applied count, seen count,
 * resume, theme, sign out — which is a settings menu pretending to be a toolbar.
 * They live here instead. The applied count stays in the header as well, because
 * it is also a filter and belongs where the filtering happens.
 */

interface Me {
  profile: {
    skills: string[];
    resumeChars: number;
    updatedAt: string | null;
    firstName: string | null;
    lastName: string | null;
    resumeName: string | null;
    resumeSize: number | null;
  };
  state: { seen: string[]; applied: string[] };
  user: { email: string } | null;
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [resume, setResume] = useState('');
  const [showResume, setShowResume] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light'
      ? 'dark'
      : 'light',
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe(body);
        setFirst(body.profile.firstName ?? '');
        setLast(body.profile.lastName ?? '');
      }
    } catch {
      // A blip must not throw someone out of their own account page.
    } finally {
      setChecked(true);
    }

    // Ask the route rather than comparing the email here. The server holds the
    // list and the verified session; a browser-side check would be a second,
    // weaker copy of the same rule, free to disagree with it.
    try {
      setIsAdmin((await fetch('/api/admin')).ok);
    } catch {
      setIsAdmin(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Same gate as the feed: signed out, there is nothing here to show.
  useEffect(() => {
    if (checked && !me?.user) window.location.replace('/signin');
  }, [checked, me]);

  function setThemeTo(next: 'dark' | 'light') {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('unsaturated.theme', next);
    } catch {
      // Private browsing throws. The theme still applies for this session.
    }
  }

  async function saveName() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch('/api/profile/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: first, lastName: last }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) { setError(body?.error ?? 'could not save your name'); return; }
      setSaved('Name saved.');
      await load();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function saveResume() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) { setError(body?.error ?? 'could not save your resume'); return; }
      setShowResume(false);
      setResume('');
      setSaved('Resume saved.');
      await load();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Upload, and read the text out of it in the browser.
   *
   * The file is stored EITHER WAY. A scanned PDF with no text layer is a real
   * thing people will try, and losing their upload over it would be the wrong
   * answer — the file is kept, the warning says so, and the paste box is
   * offered as the way to get a match score.
   */
  async function uploadFile(file: File) {
    setError(null);
    setSaved(null);
    setFileNote(null);

    if (!isAcceptedFile(file.name)) {
      setFileNote('Use a PDF, DOCX, TXT or Markdown file.');
      return;
    }

    setUploading(true);
    setBusy(true);
    try {
      // Read first: if the file is unreadable the person learns immediately
      // rather than after a needless upload.
      const { text, warning } = await extractResumeText(file);

      const form = new FormData();
      form.append('file', file);
      const up = await fetch('/api/profile/resume-file', { method: 'POST', body: form });
      const upBody = (await up.json().catch(() => null)) as { error?: string } | null;
      if (!up.ok) { setError(upBody?.error ?? 'could not store that file'); return; }

      if (text) {
        const res = await fetch('/api/profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resume: text }),
        });
        if (!res.ok) setFileNote('File saved, but the skills could not be updated.');
      }

      setFileNote(warning);
      if (!warning) setSaved(`Saved ${file.name}.`);
      await load();
    } catch {
      setError('could not reach the server');
    } finally {
      setUploading(false);
      setBusy(false);
    }
  }

  async function openFile() {
    setError(null);
    try {
      const res = await fetch('/api/profile/resume-file');
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) { setError(body?.error ?? 'could not open that file'); return; }
      window.open(body.url, '_blank', 'noopener');
    } catch {
      setError('could not reach the server');
    }
  }

  async function removeFile() {
    setBusy(true);
    setError(null);
    setFileNote(null);
    try {
      const res = await fetch('/api/profile/resume-file', { method: 'DELETE' });
      if (!res.ok) { setError('could not remove that file'); return; }
      // Deliberately not a claim that the skills are gone — they are not, and
      // saying so would be untrue.
      setSaved('File removed. Your extracted skills are unchanged.');
      await load();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch('/api/auth/signout', { method: 'POST' }).catch(() => {});
    window.location.replace('/signin');
  }

  if (!checked || !me?.user) {
    return <main className="account page-account"><p className="muted">Loading…</p></main>;
  }

  const p = me.profile;
  const named = Boolean(p.firstName || p.lastName);
  const fileSize = (bytes: number | null) => {
    if (!bytes) return '';
    return bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  return (
    <main className="account page-account">
      <a className="backlink" href="/">← Back to jobs</a>

      <div className="acct-id">
        <span className="avatar lg">{initialsOf(p.firstName, p.lastName, me.user.email)}</span>
        <div>
          <h1>{named ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() : 'Your account'}</h1>
          <p className="muted">{me.user.email}</p>
        </div>
      </div>

      {error && <p className="err">{error}</p>}
      {saved && <p className="okmsg">{saved}</p>}

      <section className="panel">
        <h2>Name</h2>
        {/* Prompted rather than assumed. Anyone who signed in before names were
            asked for has none, and showing the part of their address before the
            @ would look like a filled-in field that nobody filled in. */}
        {!named && <p className="muted">You signed in before we asked for a name. Add it here.</p>}
        <div className="namerow">
          <label>
            First name
            <input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={60} autoComplete="given-name" />
          </label>
          <label>
            Last name
            <input value={last} onChange={(e) => setLast(e.target.value)} maxLength={60} autoComplete="family-name" />
          </label>
        </div>
        <button className="primary" onClick={() => void saveName()} disabled={busy || !first.trim() || !last.trim()}>
          Save name
        </button>
      </section>

      {/* Only rendered when /api/admin actually answers. The route decides;
          this is a link, not a permission. */}
      {isAdmin && (
        <section className="panel">
          <h2>Team</h2>
          <p className="muted">See everyone&rsquo;s activity across the four seats.</p>
          <a className="primary linkbtn" href="/admin">Open team view</a>
        </section>
      )}

      <section className="panel">
        <h2>Appearance</h2>
        <div className="segmented">
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => setThemeTo('dark')}>☾ Dark</button>
          <button className={theme === 'light' ? 'on' : ''} onClick={() => setThemeTo('light')}>☀ Light</button>
        </div>
        <p className="muted">Remembered on this device.</p>
      </section>

      <section className="panel">
        <h2>Resume</h2>
        <p className="muted">
          {p.skills.length
            ? `${p.skills.length} skills, from ${p.resumeChars.toLocaleString()} characters of resume.`
            : 'No resume yet. Upload a file or paste one, and jobs get a match score.'}
        </p>

        {/* The stored file, when there is one. Kept separately from the skills:
            replacing the file does not drop the skills, and pasting text does
            not drop the file. */}
        {p.resumeName && (
          <div className="filerow">
            <span className="fileicon" aria-hidden="true">📄</span>
            <span className="filename">{p.resumeName}</span>
            <span className="muted">{fileSize(p.resumeSize)}</span>
            <div className="grow" />
            <button onClick={() => void openFile()} disabled={busy}>Download</button>
            <button onClick={() => void removeFile()} disabled={busy}>Remove</button>
          </div>
        )}

        {p.skills.length > 0 && (
          <div className="chips">
            {p.skills.map((s) => <span key={s} className="chip skill">{s}</span>)}
          </div>
        )}

        {fileNote && <p className="filenote">{fileNote}</p>}

        <div className="row">
          {/* A label rather than a styled button, so the file picker opens from
              a real input and keyboard users get it for free. */}
          <label className={`filebtn${busy ? ' busy' : ''}`}>
            {uploading ? 'Reading…' : p.resumeName ? 'Replace file' : 'Upload PDF or DOCX'}
            <input
              type="file"
              accept={ACCEPTED}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Cleared so choosing the same file twice fires again — after a
                // failed read, picking it once more is the obvious thing to try.
                e.target.value = '';
                if (f) void uploadFile(f);
              }}
            />
          </label>
          {!showResume && (
            <button onClick={() => setShowResume(true)}>
              {p.skills.length ? 'Paste instead' : 'Or paste text'}
            </button>
          )}
        </div>

        {showResume && (
          <>
            <textarea
              rows={10}
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              placeholder="Paste your resume. Only the skills are kept."
            />
            <div className="row">
              <button className="primary" onClick={() => void saveResume()} disabled={busy || !resume.trim()}>
                Save resume
              </button>
              <button onClick={() => { setShowResume(false); setResume(''); }}>Cancel</button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Activity</h2>
        <div className="stats">
          <a className="stat" href="/?onlyApplied=1">
            <b className="tnum">{me.state.applied.length.toLocaleString()}</b>
            <span>applied</span>
          </a>
          <div className="stat">
            <b className="tnum">{me.state.seen.length.toLocaleString()}</b>
            <span>jobs opened</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <button onClick={() => void signOut()}>Sign out</button>
      </section>
    </main>
  );
}
