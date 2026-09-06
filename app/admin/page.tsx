'use client';

import { useEffect, useState } from 'react';
import { initialsOf } from '../../src/ui/initials.js';

/**
 * Who is using the site, and how much.
 *
 * Four people share this and there was no way to see any of it. The permission
 * check is entirely server-side — this page just renders whatever /api/admin
 * agrees to return, and that route answers 404 to everyone else, so hiding the
 * link is tidiness rather than security.
 *
 * Resume text is deliberately absent. How many skills someone has extracted is
 * a useful signal about whether the feature is working; the CV itself is theirs.
 */

interface AdminUser {
  email: string;
  firstName: string | null;
  lastName: string | null;
  applied: number;
  seen: number;
  skills: number;
  resumeChars: number;
  lastActive: string | null;
  joined: string | null;
  isYou: boolean;
}

interface Payload {
  users: AdminUser[];
  seatsUsed: number;
  anonymousProfiles: number;
  error?: string;
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export default function Admin() {
  const [data, setData] = useState<Payload | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/admin');
        if (res.status === 404 || res.status === 401) {
          setDenied(true);
          return;
        }
        setData((await res.json()) as Payload);
      } catch {
        setDenied(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <main className="account page-account"><p className="muted">Loading…</p></main>;

  if (denied) {
    return (
      <main className="account page-account">
        <a className="backlink" href="/">← Back to jobs</a>
        <p className="muted">This page is not available.</p>
      </main>
    );
  }

  const users = data?.users ?? [];
  const totalApplied = users.reduce((n, u) => n + u.applied, 0);

  return (
    <main className="account page-account">
      <a className="backlink" href="/">← Back to jobs</a>

      <div className="acct-id">
        <div>
          <h1>Team</h1>
          <p className="muted">
            {data?.seatsUsed ?? 0} of 4 seats used
            {data?.anonymousProfiles ? ` · ${data.anonymousProfiles} anonymous visitors` : ''}
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="stats">
          <div className="stat">
            <b className="tnum">{totalApplied}</b>
            <span>applications, everyone</span>
          </div>
          <div className="stat">
            <b className="tnum">{users.filter((u) => u.skills > 0).length}</b>
            <span>have added a resume</span>
          </div>
          <div className="stat">
            <b className="tnum">{users.filter((u) => u.firstName).length}</b>
            <span>have set a name</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>People</h2>
        {users.length === 0 && <p className="muted">Nobody has signed in yet.</p>}
        <ul className="people">
          {users.map((u) => {
            const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
            return (
              <li key={u.email} className="person">
                <span className="avatar">{initialsOf(u.firstName, u.lastName, u.email)}</span>
                <div className="who">
                  <b>
                    {name || <span className="muted">No name set</span>}
                    {u.isYou && <span className="chip you">you</span>}
                  </b>
                  <span className="muted">{u.email}</span>
                </div>
                <div className="usage">
                  <span title="Jobs applied to">
                    <b className="tnum">{u.applied}</b> applied
                  </span>
                  <span title="Jobs opened">
                    <b className="tnum">{u.seen}</b> seen
                  </span>
                  <span title="Skills extracted from their resume">
                    <b className="tnum">{u.skills}</b> skills
                  </span>
                  <span className="muted">active {when(u.lastActive)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
