'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The sign-in page.
 *
 * Its own route rather than a panel on the feed, because a panel that opens at
 * the top of a long scrolling page is easy to miss entirely — which is exactly
 * what happened. A dedicated page has one job and cannot be scrolled past.
 *
 * Also where the magic link lands. Supabase puts the token in the URL fragment,
 * which browsers never send to a server, so the page has to read it, hand it
 * over, and strip it from the address bar before it ends up in history.
 */

type Phase = 'idle' | 'sending' | 'sent' | 'landing' | 'error';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [seatsLeft, setSeatsLeft] = useState<number | null>(null);

  const goToFeed = useCallback(() => {
    // replace, not assign: the sign-in page should not sit in history behind
    // the feed, or the back button lands on a page you have already used.
    window.location.replace('/');
  }, []);

  // Already signed in? Nothing to do here.
  useEffect(() => {
    if (window.location.hash.includes('access_token=')) return;
    void (async () => {
      try {
        const res = await fetch('/api/me');
        if (!res.ok) return;
        const body = (await res.json()) as { user: { email: string } | null };
        if (body.user) goToFeed();
      } catch {
        // Offline or the API is down — leave the form up rather than blocking.
      }
    })();
  }, [goToFeed]);

  // Completing a magic link.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes('access_token=')) return;

    const params = new URLSearchParams(hash.slice(1));
    const token = params.get('access_token');
    // Sent along so the session survives past the access token's one hour.
    const refresh = params.get('refresh_token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) return;

    setPhase('landing');
    void (async () => {
      try {
        const res = await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: token, refresh_token: refresh }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) {
          setPhase('error');
          setMessage(body.error ?? 'that link did not work');
          return;
        }
        goToFeed();
      } catch {
        setPhase('error');
        setMessage('could not complete sign-in');
      }
    })();
  }, [goToFeed]);

  async function send() {
    setPhase('sending');
    setMessage(null);
    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as { error?: string; message?: string; seatsLeft?: number };
      if (typeof body.seatsLeft === 'number') setSeatsLeft(body.seatsLeft);
      if (!res.ok) {
        setPhase('error');
        setMessage(body.error ?? 'could not send the link');
        return;
      }
      setPhase('sent');
      setMessage(body.message ?? 'Check your email.');
    } catch {
      setPhase('error');
      setMessage('could not reach the server');
    }
  }

  if (phase === 'landing') {
    return (
      <div className="auth">
        <div className="authcard">
          <div className="authmark"><span className="dot" />Unsaturated</div>
          <h1>Signing you in…</h1>
          <p className="authsub">One moment.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="authcard">
        <div className="authmark"><span className="dot" />Unsaturated</div>

        <h1>Sign in</h1>
        <p className="authsub">
          Jobs read straight from employers&rsquo; own career pages — cloud, software, data
          and HRIS roles, refreshed through the day.
        </p>

        {phase === 'sent' ? (
          <>
            <div className="authnote ok">
              <strong>Check your email.</strong>
              <span>{message}</span>
            </div>
            <p className="authfine">
              The link signs you in on this device. It expires shortly, so use it soon.
            </p>
            <button className="authghost" onClick={() => { setPhase('idle'); setMessage(null); }}>
              Use a different address
            </button>
          </>
        ) : (
          <>
            <label className="authlabel" htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && email) void send(); }}
            />

            <button
              className="authprimary"
              onClick={() => void send()}
              disabled={phase === 'sending' || !email}
            >
              {phase === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
            </button>

            {message && (
              <div className={`authnote ${phase === 'error' ? 'bad' : ''}`}>
                <span>{message}</span>
              </div>
            )}

            <p className="authfine">
              No password. We email you a link and you click it.
              {seatsLeft !== null && seatsLeft > 0 && ` ${seatsLeft} of 4 places left.`}
              {seatsLeft === 0 && ' All four places are taken.'}
            </p>
          </>
        )}
      </div>

      <p className="authfoot">
        Four accounts, claimed first come. Nothing is reserved until you click the link.
      </p>
    </div>
  );
}
