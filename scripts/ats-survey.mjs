import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.argv[2];
const targets = {
  greenhouse: 'https://job-boards.greenhouse.io/shifttechnology/jobs/7987030003',
  lever: 'https://jobs.lever.co/bluelightconsulting/90a00189-03da-4922-9b2e-812ef0958379/apply',
  ashby: 'https://jobs.ashbyhq.com/angi/a22feaa0-7586-44ee-9a1f-266d50b4ca46/application',
  workable: 'https://apply.workable.com/j/9B48F62113/apply',
  smartrecruiters: 'https://jobs.smartrecruiters.com/SmartDev1/744000146138730',
  rippling: 'https://ats.rippling.com/button/jobs/d16f6e6a-1a1b-4ac6-a98d-2648b88e83f1',
  recruitee: 'https://wizdaa.recruitee.com/o/senior-react-native-react-engineer-latam-1/c/new',
  personio: 'https://hattec.jobs.personio.de/job/2780571',
  bamboohr: 'https://pemcco.bamboohr.com/careers/283',
};
const scrape = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labelFor = (el) => {
    const bits = [];
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) bits.push(l.innerText); }
    const wrap = el.closest('label'); if (wrap) bits.push(wrap.innerText);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const n = document.getElementById(id); if (n) bits.push(n.innerText); }
    if (el.getAttribute('aria-label')) bits.push(el.getAttribute('aria-label'));
    let p = el.parentElement; let hops = 0;
    while (p && hops++ < 3 && bits.length === 0) { const l = p.querySelector('label'); if (l) bits.push(l.innerText); p = p.parentElement; }
    return [...new Set(bits.map((s) => (s || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' | ').slice(0, 120);
  };
  return [...document.querySelectorAll('input, textarea, select')]
    .filter((el) => el.type !== 'hidden')
    .map((el) => ({
      tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', name: el.name || '',
      auto: el.getAttribute('autocomplete') || '', role: el.getAttribute('role') || '',
      req: el.required || el.getAttribute('aria-required') === 'true',
      placeholder: el.placeholder || '', label: labelFor(el), visible: vis(el),
      automationId: el.getAttribute('data-automation-id') || '', testId: el.getAttribute('data-testid') || el.getAttribute('data-qa') || '',
    }));
};
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const report = {};
for (const [name, url] of Object.entries(targets)) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 2000 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    for (const label of ['Apply for this job', 'Apply now', 'Apply', "I'm interested", 'Submit application']) {
      const [btn] = await page.$$(`xpath/.//button[contains(., "${label}")] | .//a[contains(., "${label}")]`);
      if (btn) { await btn.click().catch(() => {}); await new Promise((r) => setTimeout(r, 2500)); break; }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const fields = await page.evaluate(scrape);
    const frames = [];
    for (const f of page.frames()) if (f !== page.mainFrame()) { try { frames.push({ url: f.url(), fields: await f.evaluate(scrape) }); } catch {} }
    report[name] = { url, fields, frames: frames.filter((f) => f.fields.length) };
    console.log(name, 'fields:', fields.length, 'frames with fields:', report[name].frames.length);
    fs.writeFileSync(`${OUT}/${name}.dom.html`, await page.content());
  } catch (e) { console.log(name, 'ERR', e.message); report[name] = { url, error: e.message }; }
  await page.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/survey.json`, JSON.stringify(report, null, 2));
