'use client';

import { useCallback, useEffect, useState } from 'react';
import { initialsOf } from '../../src/ui/initials.js';

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

  async function signOut() {
    await fetch('/api/auth/signout', { method: 'POST' }).catch(() => {});
    window.location.replace('/signin');
  }

  if (!checked || !me?.user) {
    return <main className="account"><p className="muted">Loading…</p></main>;
  }

  const p = me.profile;
  const named = Boolean(p.firstName || p.lastName);

  return (
    <main className="account">
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
            : 'No resume yet. Paste one and jobs get a match score.'}
        </p>
        {p.skills.length > 0 && (
          <div className="chips">
            {p.skills.map((s) => <span key={s} className="chip skill">{s}</span>)}
          </div>
        )}
        {!showResume && (
          <button onClick={() => setShowResume(true)}>
            {p.skills.length ? 'Replace resume' : 'Add resume'}
          </button>
        )}
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
