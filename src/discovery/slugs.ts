/**
 * Company name → candidate ATS tokens.
 *
 * Every ATS puts the employer's own slug in the URL (jobs.lever.co/lyrahealth,
 * boards.greenhouse.io/stripe), and those slugs derive from the company name in
 * a small number of predictable ways.
 *
 * Tech companies slug cleanly — "Vercel" is `vercel`. Enterprises do not: they
 * carry legal suffixes, sector words and long formal names, and they very often
 * use an internal acronym instead ("Hewlett Packard Enterprise" → `hpe`). That
 * gap is why enterprise discovery hit 22% against 68% for tech names, so the
 * generated candidates below are deliberately broader for multi-word names.
 */

/** Legal and sector words that almost never survive into a tenant slug. */
const NOISE =
  /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|sas|bv|plc|group|holdings|holding|technologies|technology|tech|labs|software|systems|solutions|international|worldwide|global|enterprises|partners|services|industries|brands|stores|america|american|usa|us|the)\b/gi;

/** Sector words to try dropping — "Lyra Health" is often just `lyra`. */
const SECTOR = /\b(health|healthcare|financial|finance|bank|banking|energy|insurance|motor|motors|pharmaceuticals?|medical|media|communications|electric|foods?|airlines?|air|stores?|university)\b/gi;

/**
 * Hand-curated overrides for large employers whose tenant bears little relation
 * to their name. These are the cases no generated rule will ever reach.
 */
const ALIASES: Record<string, string[]> = {
  'jpmorgan chase': ['jpmc', 'jpmorganchase', 'chase'],
  'bank of america': ['bankofamerica', 'boa', 'bofa'],
  'wells fargo': ['wellsfargo', 'wf'],
  'unitedhealth group': ['unitedhealthgroup', 'uhg', 'unitedhealth'],
  'hewlett packard enterprise': ['hpe'],
  'hp inc': ['hp'],
  'general motors': ['generalmotors', 'gm'],
  'general electric': ['ge', 'generalelectric'],
  'general dynamics': ['gd', 'generaldynamics'],
  'american express': ['amex', 'americanexpress'],
  'lockheed martin': ['lockheedmartin', 'lmco'],
  'northrop grumman': ['northropgrumman', 'ngc'],
  'booz allen hamilton': ['boozallen', 'bah'],
  'caci international': ['caci'],
  'l3harris': ['l3harris', 'harris'],
  'huntington ingalls': ['hii', 'huntingtoningalls'],
  'exxon mobil': ['exxonmobil', 'exxon'],
  'conocophillips': ['conocophillips', 'cop'],
  'marathon petroleum': ['marathonpetroleum', 'mpc'],
  'nextera energy': ['nexteraenergy', 'nextera', 'fpl'],
  'american electric power': ['aep'],
  'consolidated edison': ['coned', 'conedison'],
  'united parcel service': ['ups'],
  'charles schwab': ['schwab', 'charlesschwab'],
  'fidelity investments': ['fidelity', 'fmr'],
  'state street': ['statestreet'],
  'northern trust': ['northerntrust'],
  'capital one': ['capitalone'],
  'discover financial': ['discover'],
  'cvs health': ['cvshealth', 'cvs'],
  'hca healthcare': ['hcahealthcare', 'hca'],
  'kaiser permanente': ['kaiserpermanente', 'kp'],
  'mass general brigham': ['massgeneralbrigham', 'mgb', 'partners'],
  'johns hopkins medicine': ['jhu', 'johnshopkins'],
  'newyork-presbyterian': ['nyp', 'newyorkpresbyterian'],
  'bristol myers squibb': ['bms', 'bristolmyerssquibb'],
  'eli lilly': ['lilly', 'elililly'],
  'becton dickinson': ['bd', 'bectondickinson'],
  'boston scientific': ['bostonscientific', 'bsc'],
  'texas instruments': ['ti', 'texasinstruments'],
  'micron technology': ['micron'],
  'applied materials': ['appliedmaterials', 'amat'],
  'western digital': ['westerndigital', 'wdc'],
  'seagate technology': ['seagate'],
  'dell technologies': ['dell'],
  'cisco systems': ['cisco'],
  'dxc technology': ['dxc'],
  'ntt data': ['nttdata', 'ntt'],
  'deere and company': ['johndeere', 'deere'],
  'stanley black and decker': ['stanleyblackanddecker', 'sbd'],
  'illinois tool works': ['itw'],
  'johnson controls': ['johnsoncontrols', 'jci'],
  'trane technologies': ['trane'],
  'carrier global': ['carrier'],
  'coca-cola': ['cocacola', 'coke'],
  'jm smucker': ['smucker', 'jmsmucker'],
  'yum brands': ['yum'],
  'marriott international': ['marriott'],
  'mgm resorts': ['mgmresorts', 'mgm'],
  'warner bros discovery': ['wbd', 'warnerbros'],
  'charter communications': ['charter', 'spectrum'],
  't-mobile': ['tmobile'],
  'at&t': ['att'],
  'ch robinson': ['chrobinson', 'chrw'],
  'jb hunt': ['jbhunt'],
  'old dominion freight': ['odfl', 'olddominion'],
  'union pacific': ['unionpacific', 'up'],
  'norfolk southern': ['norfolksouthern', 'nscorp'],
  'delta air lines': ['delta'],
  'united airlines': ['united', 'unitedairlines'],
  'american airlines': ['aa', 'americanairlines'],
  'southwest airlines': ['southwest', 'swa'],
  'alaska air group': ['alaskaair', 'alaskaairlines'],
  'liberty mutual': ['libertymutual'],
  'state farm': ['statefarm'],
  'prudential financial': ['prudential'],
  'principal financial': ['principal'],
  'lincoln financial': ['lincolnfinancial', 'lfg'],
  'voya financial': ['voya'],
  'guardian life': ['guardianlife', 'guardian'],
  'erie insurance': ['erieinsurance', 'erie'],
  'cincinnati financial': ['cinfin'],
  'regions bank': ['regions'],
  'fifth third bank': ['53', 'fifththird'],
  'citizens bank': ['citizensbank', 'citizens'],
  'huntington bank': ['huntington'],
  'm&t bank': ['mtb', 'mtbank'],
  'ally financial': ['ally'],
  'pnc financial': ['pnc'],
  'us bancorp': ['usbank', 'usbancorp'],
  'intercontinental exchange': ['ice'],
  'cme group': ['cmegroup', 'cme'],
};

/** Acronym from initials — the pattern behind HPE, IBM, AEP, UPS. */
function acronym(words: string[]): string | undefined {
  if (words.length < 2 || words.length > 4) return undefined;
  const letters = words.map((w) => w[0]).filter(Boolean).join('');
  return letters.length >= 2 && letters.length <= 5 ? letters : undefined;
}

export function slugCandidates(companyName: string): string[] {
  const base = companyName
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Order matters: probing stops at the first board that answers, and callers
  // cap how many candidates they try. Specific forms therefore go first and
  // ambiguous ones last — a bare acronym like "ge" or "up" could easily be some
  // unrelated company's board, so it must never be tried before the full name.
  const ordered: string[] = [];
  const push = (s: string | undefined) => {
    if (s && s.length >= 2 && s.length <= 60 && !ordered.includes(s)) ordered.push(s);
  };

  // Curated aliases are known-correct rather than guessed, so they lead.
  const aliasKey = companyName.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const alias of ALIASES[aliasKey] ?? []) push(alias);

  const noNoise = base.replace(NOISE, '').replace(/\s+/g, ' ').trim();
  const noSector = noNoise.replace(SECTOR, '').replace(/\s+/g, ' ').trim();
  const variants = [base, noNoise, noSector].filter(Boolean);

  for (const v of variants) push(v.replace(/[\s-]/g, ''));
  for (const v of variants) push(v.replace(/\s+/g, '-'));
  for (const v of variants) {
    const first = v.split(' ')[0];
    if (first && first.length >= 4) push(first);
  }
  // Acronyms last, and only for names long enough that the acronym is meaningful.
  for (const v of variants) push(acronym(v.split(' ').filter(Boolean)));

  return ordered.slice(0, 7);
}
