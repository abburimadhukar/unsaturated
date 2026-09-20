'use client';

import Link from 'next/link';
import { useState } from 'react';

import { isPublicSourceUrl, outreachDraft, type ContactType } from '../../src/after-apply/draft.js';
import type { ResearchGroup, ResearchLane } from '../../src/after-apply/research.js';

interface JobContext {
  key: string;
  title: string;
  company: string;
  applyUrl: string | null;
  closed: boolean;
}

export function AfterApplyWorkspace({ job, lanes, scanConfigured }: {
  job: JobContext;
  lanes: ResearchLane[];
  scanConfigured: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [groups, setGroups] = useState<ResearchGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactType, setContactType] = useState<ContactType>('manager');
  const [contactUrl, setContactUrl] = useState('');
  const [sourceDetail, setSourceDetail] = useState('');
  const [proof, setProof] = useState('');
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  async function scan() {
    setScanning(true);
    setScanError('');
    try {
      const response = await fetch('/api/after-apply/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobKey: job.key }),
      });
      const data = await response.json() as { error?: string; groups?: ResearchGroup[] };
      if (!response.ok || !Array.isArray(data.groups)) {
        setScanError(data.error ?? 'Could not scan public sources right now.');
        return;
      }
      setGroups(data.groups);
    } catch {
      setScanError('Could not scan public sources right now. Use the search links below.');
    } finally {
      setScanning(false);
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="aapage">
      <nav className="aanav"><Link href="/">← Back to jobs</Link><Link href="/account">Account</Link></nav>
      <div className="aaeyebrow">AFTER APPLYING</div>
      <h1>{job.title}</h1>
      <p className="aameta">{job.company} · {job.closed ? 'Posting may be closed' : 'Posting in feed'}
        {job.applyUrl && <> · <a href={job.applyUrl} target="_blank" rel="noopener noreferrer">Employer posting ↗</a></>}
      </p>
      <p className="aaintro">Find the right person, verify the connection, and write one relevant note. This does not contact anyone or change your application.</p>

      <section className="aacard">
        <div className="aastep">01 / Confirm</div>
        <h2>Did you actually submit the application?</h2>
        <p>The feed’s “applied” marker can be set by opening a posting. Confirm here before writing a note that says you applied.</p>
        <label className="aacheck"><input type="checkbox" checked={confirmed} onChange={(event) => {
          setConfirmed(event.target.checked);
          if (!event.target.checked) setDraft('');
        }} /> Yes, I submitted this application</label>
      </section>

      <section className="aacard">
        <div className="aastep">02 / Research</div>
        <h2>Find and verify a person</h2>
        <p>These are search leads, not verified hiring managers. Open a profile and check their current company, team, and connection to this role before reaching out.</p>
        {scanConfigured ? (
          <div className="aascanrow">
            <button type="button" className="primary" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Searching…' : 'Scan public sources'}</button>
            <span>Sign-in required · uses a server-side search key</span>
          </div>
        ) : <p className="aaquiet">Automatic source scan is not configured yet. The public searches below work without an account or API key.</p>}
        {scanError && <p className="aaerror" role="alert">{scanError} {scanError.includes('Sign in') && <Link href="/account">Go to account</Link>}</p>}
        <div className="aalanes">
          {lanes.map((lane) => {
            const group = groups.find((item) => item.id === lane.id);
            return <div className="aalane" key={lane.id}>
              <div className="aalanehead"><h3>{lane.label}</h3><a href={lane.searchUrl} target="_blank" rel="noopener noreferrer">Search yourself ↗</a></div>
              {group?.unavailable && <p>Search unavailable for this category; try the direct link.</p>}
              {group && !group.unavailable && group.leads.length === 0 && <p>No leads returned. Try the direct search.</p>}
              {group?.leads.map((lead) => <div className="aalead" key={lead.url}>
                <a href={lead.url} target="_blank" rel="noopener noreferrer">{lead.title} ↗</a>
                {lead.description && <p>{lead.description}</p>}
                <small>{new URL(lead.url).hostname}</small>
              </div>)}
            </div>;
          })}
        </div>
      </section>

      <section className="aacard">
        <div className="aastep">03 / Outreach</div>
        <h2>Write a note worth receiving</h2>
        <p>Use a verified profile and one specific public detail. Add only achievements you can substantiate. Nothing is sent automatically.</p>
        <div className="aaform">
          <label>Person’s name<input value={contactName} maxLength={80} onChange={(event) => setContactName(event.target.value)} placeholder="e.g. Jordan Lee" /></label>
          <label>Who are they?<select value={contactType} onChange={(event) => setContactType(event.target.value as ContactType)}><option value="manager">Potential team leader</option><option value="recruiter">Recruiter</option></select></label>
          <label className="aawide">Verified public profile URL<input type="url" value={contactUrl} onChange={(event) => setContactUrl(event.target.value)} placeholder="https://…" />{isPublicSourceUrl(contactUrl) && <a href={contactUrl} target="_blank" rel="noopener noreferrer">Open this profile ↗</a>}</label>
          <label className="aawide">Specific detail you found in a public source<textarea value={sourceDetail} maxLength={500} onChange={(event) => setSourceDetail(event.target.value)} placeholder="Write a complete sentence, e.g. I saw your team launched a new data platform" /></label>
          <label className="aawide">Your relevant proof<textarea value={proof} maxLength={500} onChange={(event) => setProof(event.target.value)} placeholder="Write a complete sentence about your own work; numbers only if accurate" /></label>
        </div>
        <div className="aadraftactions">
          <button type="button" className="primary" disabled={!confirmed || !contactName.trim() || !isPublicSourceUrl(contactUrl) || !sourceDetail.trim() || !proof.trim()} onClick={() => {
            setDraft(outreachDraft({ contactName, contactType, company: job.company, jobTitle: job.title, sourceDetail, proof }));
            setCopied(false);
          }}>Draft message</button>
          {!confirmed && <span>Confirm submission above first.</span>}
          {confirmed && !isPublicSourceUrl(contactUrl) && <span>Add a verified HTTPS profile URL.</span>}
        </div>
        {draft && <div className="aadraft">
          <label htmlFor="aa-message">Edit before sending</label>
          <textarea id="aa-message" value={draft} onChange={(event) => { setDraft(event.target.value); setCopied(false); }} />
          <button type="button" disabled={!draft.trim()} onClick={() => void copyDraft()}>{copied ? 'Copied' : 'Copy message'}</button>
        </div>}
        <p className="aaquiet">Your name, evidence, and draft stay in this page’s browser state; they are not sent to our server. No scraping, email discovery, or automatic messages.</p>
      </section>
    </main>
  );
}
