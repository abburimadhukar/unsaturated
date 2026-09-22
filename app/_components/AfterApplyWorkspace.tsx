'use client';

import Link from 'next/link';
import { useState } from 'react';

import { isPublicSourceUrl, outreachDraft, type ContactType } from '../../src/after-apply/draft.js';
import type { ContactLead, ResearchReport } from '../../src/after-apply/research.js';

interface JobContext {
  key: string;
  title: string;
  company: string;
  applyUrl: string | null;
  closed: boolean;
}

export function AfterApplyWorkspace({ job, scanConfigured, backTo }: {
  job: JobContext;
  scanConfigured: boolean;
  /** Already checked against BACK_TO by the page; never a raw query value. */
  backTo?: { href: string; label: string };
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<ResearchReport | null>(null);
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
      const data = await response.json() as { error?: string; report?: ResearchReport };
      if (!response.ok || !data.report || !Array.isArray(data.report.contacts) || !Array.isArray(data.report.signals)) {
        setScanError(data.error ?? 'Could not research this job right now.');
        return;
      }
      setReport(data.report);
    } catch {
      setScanError('Could not research this job right now. Please try later.');
    } finally {
      setScanning(false);
    }
  }

  function chooseContact(lead: ContactLead) {
    setContactName(lead.name);
    setContactType(lead.category === 'Recruiting' ? 'recruiter' : lead.category === 'Employee' ? 'employee' : 'manager');
    setContactUrl(lead.sourceUrl);
    setSourceDetail(`I noticed ${lead.connection.replace(/[.!?\s]+$/, '')}`);
    setDraft('');
    document.getElementById('aa-outreach')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      <nav className="aanav">
        <Link href={backTo?.href ?? '/'}>← Back to {backTo?.label ?? 'jobs'}</Link>
        <Link href="/account">Account</Link>
      </nav>
      <div className="aaeyebrow">AFTER APPLYING</div>
      <h1>{job.title}</h1>
      <p className="aameta">{job.company} · {job.closed ? 'Posting may be closed' : 'Posting in feed'}
        {job.applyUrl && <> · <a href={job.applyUrl} target="_blank" rel="noopener noreferrer">Employer posting ↗</a></>}
      </p>
      <p className="aaintro">See relevant people and company context directly, with links to the public evidence. Nothing is sent to anyone and your application is unchanged.</p>

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
        <div className="aastep">02 / Find people</div>
        <h2>People and useful signals for this job</h2>
        <p>We look for current recruiting or team contacts and show the evidence behind each suggestion. A public connection does not prove someone manages this exact opening.</p>
        {scanConfigured ? (
          <div className="aascanrow">
            <button type="button" className="primary" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Researching this job…' : report ? 'Refresh findings' : 'Find people and insights'}</button>
            <span>Sign-in required · public web research may take a minute</span>
          </div>
        ) : <p className="aaquiet">Live research is not configured on this site yet.</p>}
        {scanError && <p className="aaerror" role="alert">{scanError} {scanError.includes('Sign in') && <Link href="/account">Go to account</Link>}</p>}
        {report && <div className="aaresults" aria-live="polite">
          <p className="aaresultmeta">Public sources checked {new Date(report.searchedAt).toLocaleString()} · Open each source before reaching out.</p>
          <h3>People to consider</h3>
          {report.contacts.length === 0
            ? <div className="aaempty">No credible named contact found for this job. We will not invent a hiring manager.</div>
            : <div className="aacontacts">{report.contacts.map((lead) => <article className="aacontact" key={lead.sourceUrl + lead.name}>
              <span className="aacategory">{lead.category} · Potential contact</span>
              <h4>{lead.name}</h4>
              <p className="aarole">{lead.role}</p>
              <p><strong>Public connection:</strong> {lead.connection}</p>
              <p><strong>Why this person:</strong> {lead.whyRelevant}</p>
              <div className="aacontactactions">
                <a href={lead.sourceUrl} target="_blank" rel="noopener noreferrer">View evidence: {lead.sourceTitle} ↗</a>
                <button type="button" onClick={() => chooseContact(lead)}>Use this contact ↓</button>
              </div>
            </article>)}</div>}
          <h3>Company and team context</h3>
          {report.signals.length === 0
            ? <p className="aaquiet">No sufficiently sourced company signal found this time.</p>
            : <div className="aasignals">{report.signals.map((signal) => <article className="aasignal" key={signal.sourceUrl}>
              <h4>{signal.title}</h4><p>{signal.detail}</p>
              <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer">View source: {signal.sourceTitle} ↗</a>
            </article>)}</div>}
        </div>}
      </section>

      <section className="aacard" id="aa-outreach">
        <div className="aastep">03 / Outreach</div>
        <h2>Write a note worth receiving</h2>
        <p>Use a verified profile and one specific public detail. Add only achievements you can substantiate. Nothing is sent automatically.</p>
        <div className="aaform">
          <label>Person’s name<input value={contactName} maxLength={80} onChange={(event) => setContactName(event.target.value)} placeholder="e.g. Jordan Lee" /></label>
          <label>Who are they?<select value={contactType} onChange={(event) => setContactType(event.target.value as ContactType)}><option value="manager">Potential team leader</option><option value="recruiter">Recruiter</option><option value="employee">Employee</option></select></label>
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
        <p className="aaquiet">The message fields and draft stay in this page’s browser state. Research uses the job details only. No email discovery or automatic messages.</p>
      </section>
    </main>
  );
}
