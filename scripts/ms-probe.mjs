/**
 * Settles ONE question: is Microsoft's own careers API reachable with ordinary,
 * secure TLS from a GitHub Actions runner?
 *
 * WHY IT EXISTS
 *
 * Microsoft publishes its own listings API (gcsservices.careers.microsoft.com),
 * which is exactly the kind of first-party source this project reads. But from a
 * laptop and from this repo's dev environment the host is fronted by Azure CDN
 * serving a `*.azureedge.net` certificate that does not match the hostname, so a
 * correct TLS client rejects it (ERR_TLS_CERT_ALTNAME_INVALID). The project will
 * not disable TLS verification to get around that.
 *
 * Actions runners are hosted in Azure, so the edge they reach MAY serve the
 * correct certificate. This script finds out — with verification ON, never
 * bypassed — and if the answer is yes, prints enough of the response shape to
 * build the adapter from. If the answer is no, Microsoft stays parked, honestly.
 *
 * Run it from Actions: `gh workflow run ms-probe.yml`. It needs no secrets and
 * writes nothing — it only reads a public endpoint and prints what it found.
 */

const UA =
  process.env.CRAWLER_USER_AGENT ??
  'unsaturated-jobscout/0.1 (+https://github.com/abburimadhukar/unsaturated)';

const BASE = 'https://gcsservices.careers.microsoft.com/search/api/v1';

/** A WA-scoped search. `flt=true` returns the filter facets alongside the jobs. */
function searchUrl(location) {
  const p = new URLSearchParams({
    lc: location,
    l: 'en_us',
    pg: '1',
    pgSz: '20',
    o: 'Recent',
    flt: 'true',
  });
  return `${BASE}/search?${p.toString()}`;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json undefined; caller reports the body head */
  }
  return { status: res.status, contentType: res.headers.get('content-type'), text, json };
}

async function main() {
  console.log(`Probing Microsoft careers API as:\n  ${UA}\n`);

  let search;
  try {
    search = await getJson(searchUrl('Washington, United States'));
  } catch (err) {
    console.log('BLOCKED — the request did not complete with secure TLS.');
    console.log(`  error: ${err?.message ?? err}`);
    console.log(`  code : ${err?.cause?.code ?? 'n/a'}`);
    console.log('\nIf the code is ERR_TLS_CERT_ALTNAME_INVALID, the Actions edge is');
    console.log('served the same wrong certificate as everywhere else — Microsoft stays');
    console.log('parked. Any other code is a different problem worth reading.');
    process.exitCode = 1;
    return;
  }

  console.log(`HTTP ${search.status}  (${search.contentType ?? 'no content-type'})`);
  const result = search.json?.operationResult?.result;
  if (!result) {
    console.log('REACHABLE, but the response was not the expected shape.');
    console.log(`  body head: ${search.text.slice(0, 300).replace(/\s+/g, ' ')}`);
    process.exitCode = 1;
    return;
  }

  const jobs = result.jobs ?? [];
  console.log(`REACHABLE with secure TLS. totalJobs (WA) = ${result.totalJobs ?? '?'}, page held ${jobs.length}.\n`);

  const j = jobs[0];
  if (j) {
    console.log('First job — top-level keys:', Object.keys(j).join(', '));
    const props = j.properties ?? {};
    console.log('  properties keys   :', Object.keys(props).join(', '));
    console.log('  jobId             :', j.jobId);
    console.log('  title             :', j.title);
    console.log('  postingDate       :', j.postingDate ?? props.postedDate);
    console.log('  primaryLocation   :', props.primaryLocation);
    console.log('  locations         :', JSON.stringify(props.locations));
    console.log('  workSiteFlexibility:', props.workSiteFlexibility);
    console.log('  employmentType    :', props.employmentType);

    // The listing carries no full description, so confirm the detail endpoint too.
    try {
      const detail = await getJson(`${BASE}/job/${encodeURIComponent(j.jobId)}?lang=en_us`);
      const d = detail.json?.operationResult?.result;
      console.log(`\nDetail /job/${j.jobId}: HTTP ${detail.status}, keys:`, d ? Object.keys(d).join(', ') : '(unexpected shape)');
    } catch (err) {
      console.log(`\nDetail endpoint errored: ${err?.cause?.code ?? err?.message ?? err}`);
    }
  }

  console.log('\nVERDICT: Microsoft is reachable from Actions. A secure adapter can be built,');
  console.log('scoped per US state like Amazon, from the shape printed above.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
