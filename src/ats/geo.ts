/**
 * Country inference from free-text locations.
 *
 * Needed because the providers that matter most for the on-site pocket —
 * Workday and Greenhouse — publish a single unstructured location string with no
 * country field. Without this, a US-focused feed silently fills with Manila,
 * Chennai and Galway roles, which is what happened before this existed.
 */

const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA',
  'RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR',
]);

const US_STATE_NAMES =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;

// "Remote, US" matched but "US Remote", "US - Remote" and "Remote Nationwide"
// did not, so 121 plainly-American postings were filed as unknown.
const US_MARKERS =
  /\b(united states|usa|u\.s\.a?\.?|us based|(remote|nationwide)[\s,\-–]*(us|usa)|(us|usa)[\s,\-–]*(remote|nationwide)|nationwide remote|remote nationwide)\b/i;

/**
 * US cities that appear without a state or country.
 *
 * Several providers publish a bare city — "San Francisco", "Boston", "Austin" —
 * and every one of those was landing in the unknown bucket, the single biggest
 * group of undecoded locations. Only names that are unambiguously American are
 * listed: no "Vancouver" (Canada), "London" (England), "Birmingham" (England),
 * "Paris" or "Toronto", all of which are genuinely ambiguous without a state.
 */
const US_CITIES =
  /\b(san francisco|new york city|nyc\b|los angeles|chicago|houston|philadelphia|phoenix|san antonio|san diego|san jose|austin|jacksonville|fort worth|columbus|charlotte|indianapolis|seattle|denver|washington,? d\.?c\.?|boston|nashville|detroit|oklahoma city|portland|las vegas|memphis|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|mesa|kansas city|atlanta|omaha|colorado springs|raleigh|virginia beach|long beach|oakland|minneapolis|tulsa|arlington|tampa|new orleans|santa clara|sunnyvale|mountain view|palo alto|menlo park|redmond|bellevue|cupertino|pittsburgh|cincinnati|st\.? louis|salt lake city|boulder|ann arbor|madison|durham|chapel hill|scottsdale|plano|irvine|santa monica|brooklyn|manhattan|queens|bronx)\b/i;

/** Country name → ISO code. Ordered checks run before US detection. */
const COUNTRY_NAMES: [RegExp, string][] = [
  [/\b(united kingdom|england|scotland|wales|great britain|\buk\b)\b/i, 'GB'],
  [/\b(ireland|republic of ireland)\b/i, 'IE'],
  [/\bindia\b/i, 'IN'],
  [/\b(philippines|filipino)\b/i, 'PH'],
  [/\bmalaysia\b/i, 'MY'],
  [/\bsingapore\b/i, 'SG'],
  [/\b(canada|ontario|quebec|british columbia|alberta)\b/i, 'CA'],
  [/\b(germany|deutschland)\b/i, 'DE'],
  [/\bfrance\b/i, 'FR'],
  [/\b(spain|espa[nñ]a)\b/i, 'ES'],
  [/\b(netherlands|holland)\b/i, 'NL'],
  [/\bbelgium\b/i, 'BE'],
  [/\bitaly\b/i, 'IT'],
  [/\bportugal\b/i, 'PT'],
  [/\bpoland\b/i, 'PL'],
  [/\bromania\b/i, 'RO'],
  [/\b(czech|czechia)\b/i, 'CZ'],
  [/\bhungary\b/i, 'HU'],
  [/\baustria\b/i, 'AT'],
  [/\bswitzerland\b/i, 'CH'],
  [/\bsweden\b/i, 'SE'],
  [/\bdenmark\b/i, 'DK'],
  [/\bnorway\b/i, 'NO'],
  [/\bfinland\b/i, 'FI'],
  [/\baustralia\b/i, 'AU'],
  [/\bnew zealand\b/i, 'NZ'],
  [/\bjapan\b/i, 'JP'],
  [/\b(china|prc)\b/i, 'CN'],
  [/\b(hong kong)\b/i, 'HK'],
  [/\btaiwan\b/i, 'TW'],
  [/\b(south korea|korea)\b/i, 'KR'],
  [/\bvietnam\b/i, 'VN'],
  [/\bthailand\b/i, 'TH'],
  [/\bindonesia\b/i, 'ID'],
  [/\bisrael\b/i, 'IL'],
  [/\b(united arab emirates|\buae\b|dubai|abu dhabi)\b/i, 'AE'],
  [/\bsaudi\b/i, 'SA'],
  [/\begypt\b/i, 'EG'],
  [/\bsouth africa\b/i, 'ZA'],
  [/\bkenya\b/i, 'KE'],
  [/\bnigeria\b/i, 'NG'],
  [/(?<!\bnew\s)\bmexico\b/i, 'MX'],
  [/\bbrazil\b/i, 'BR'],
  [/\bargentina\b/i, 'AR'],
  [/\bcolombia\b/i, 'CO'],
  [/\bchile\b/i, 'CL'],
  [/\bcosta rica\b/i, 'CR'],

  // Countries the corpus actually contains but this list never named, so their
  // jobs were filed "unknown" while the location text said the country outright
  // — "Vilnius, Lithuania" being the clearest case. Capital cities are included
  // because several providers give the city alone.
  [/\b(lithuania|vilnius|kaunas)\b/i, 'LT'],
  [/\b(latvia|riga)\b/i, 'LV'],
  [/\b(estonia|tallinn|tartu)\b/i, 'EE'],
  [/\b(ukraine|kyiv|kiev|lviv|kharkiv|odesa|odessa)\b/i, 'UA'],
  [/\b(slovakia|bratislava|kosice)\b/i, 'SK'],
  [/\b(slovenia|ljubljana)\b/i, 'SI'],
  [/\b(bulgaria|sofia|plovdiv|varna)\b/i, 'BG'],
  [/\b(greece|athens|thessaloniki)\b/i, 'GR'],
  [/\b(serbia|belgrade|novi sad)\b/i, 'RS'],
  [/\b(croatia|zagreb|split)\b/i, 'HR'],
  [/\b(bosnia|sarajevo)\b/i, 'BA'],
  [/\b(north macedonia|skopje)\b/i, 'MK'],
  [/\b(albania|tirana)\b/i, 'AL'],
  [/\bmoldova\b/i, 'MD'],
  [/\b(cyprus|nicosia|limassol)\b/i, 'CY'],
  [/\bmalta\b/i, 'MT'],
  [/\b(iceland|reykjavik)\b/i, 'IS'],
  [/\bluxembourg\b/i, 'LU'],
  [/\b(turkey|t[uü]rkiye|istanbul|ankara|izmir)\b/i, 'TR'],
  [/\b(peru|lima)\b/i, 'PE'],
  [/\b(uruguay|montevideo)\b/i, 'UY'],
  [/\bparaguay\b/i, 'PY'],
  [/\bbolivia\b/i, 'BO'],
  [/\b(ecuador|quito|guayaquil)\b/i, 'EC'],
  [/\bvenezuela\b/i, 'VE'],
  [/\bpanam[aá]\b/i, 'PA'],
  [/\bguatemala\b/i, 'GT'],
  [/\bhonduras\b/i, 'HN'],
  [/\b(dominican republic|santo domingo)\b/i, 'DO'],
  [/\b(morocco|casablanca|rabat)\b/i, 'MA'],
  [/\b(tunisia|tunis)\b/i, 'TN'],
  [/\bghana\b/i, 'GH'],
  [/\buganda\b/i, 'UG'],
  [/\b(jordan|amman)\b/i, 'JO'],
  [/\b(qatar|doha)\b/i, 'QA'],
  [/\bkuwait\b/i, 'KW'],
  [/\bbahrain\b/i, 'BH'],
  [/\boman\b/i, 'OM'],
  [/\b(pakistan|karachi|lahore|islamabad)\b/i, 'PK'],
  [/\b(bangladesh|dhaka)\b/i, 'BD'],
  [/\bsri lanka\b/i, 'LK'],
  [/\bnepal\b/i, 'NP'],
  [/\b(cambodia|phnom penh)\b/i, 'KH'],
];

/**
 * Major offshore delivery-centre cities that frequently appear with no country
 * attached ("Manila - 6805 Ayala Ave", "Bengaluru"). These are the ones that
 * actually pollute a US feed, so they are worth naming explicitly.
 */
const CITY_COUNTRY: [RegExp, string][] = [
  // Widened because "Trivandrum, IN" was read as Indiana: the collision guard
  // below only works when the city is recognised, so a missing city name is not
  // a cosmetic gap — it changes the country.
  [/\b(bengaluru|bangalore|hyderabad|pune|chennai|noida|gurgaon|gurugram|mumbai|new delhi|delhi|kolkata|ahmedabad|coimbatore|trivandrum|thiruvananthapuram|kochi|cochin|indore|jaipur|nagpur|vadodara|bhubaneswar|mysore|mysuru|chandigarh|trichy|tiruchirappalli|visakhapatnam|vizag|lucknow|kanpur|surat|bhopal|vijayawada|madurai|thane|navi mumbai|whitefield)\b/i, 'IN'],
  [/\b(manila|makati|cebu|taguig|quezon city)\b/i, 'PH'],
  [/\b(kuala lumpur|penang|cyberjaya)\b/i, 'MY'],
  [/\b(london|manchester|edinburgh|glasgow|bristol|leeds|birmingham)\b/i, 'GB'],
  [/\b(dublin|cork|galway|limerick)\b/i, 'IE'],
  [/\b(toronto|vancouver|montreal|calgary|ottawa|waterloo)\b/i, 'CA'],
  [/\b(berlin|munich|münchen|hamburg|frankfurt|cologne|stuttgart|düsseldorf)\b/i, 'DE'],
  [/\b(paris|toulouse|lyon|bordeaux|nantes|lille|roanne|rennes)\b/i, 'FR'],
  [/\b(madrid|barcelona|valencia|seville)\b/i, 'ES'],
  [/\b(amsterdam|rotterdam|utrecht|eindhoven)\b/i, 'NL'],
  [/\b(warsaw|krakow|kraków|wroclaw|gdansk)\b/i, 'PL'],
  [/\b(bucharest|cluj|timisoara|iasi)\b/i, 'RO'],
  [/\b(prague|brno)\b/i, 'CZ'],
  [/\b(budapest|debrecen)\b/i, 'HU'],
  [/\b(sydney|melbourne|brisbane|perth|canberra)\b/i, 'AU'],
  [/\b(tokyo|osaka|kyoto)\b/i, 'JP'],
  [/\b(tel aviv|jerusalem|haifa|herzliya)\b/i, 'IL'],
  [/\b(sao paulo|são paulo|rio de janeiro)\b/i, 'BR'],
  [/\b(mexico city|guadalajara|monterrey)\b/i, 'MX'],
  [/\b(san jose, costa rica|heredia)\b/i, 'CR'],
  [/\b(zurich|zürich|geneva|basel|lausanne)\b/i, 'CH'],
  [/\b(stockholm|gothenburg)\b/i, 'SE'],
  [/\b(copenhagen|aarhus)\b/i, 'DK'],
  [/\b(oslo|bergen)\b/i, 'NO'],
  [/\b(lisbon|porto)\b/i, 'PT'],
  [/\b(milan|rome|turin)\b/i, 'IT'],
  [/\b(brussels|antwerp|ghent)\b/i, 'BE'],
  [/\b(vienna|graz)\b/i, 'AT'],
  [/\b(shanghai|beijing|shenzhen|guangzhou)\b/i, 'CN'],
  [/\b(seoul|busan)\b/i, 'KR'],
  [/\b(ho chi minh|hanoi|da nang)\b/i, 'VN'],
  [/\b(bangkok)\b/i, 'TH'],
  [/\b(jakarta|bandung)\b/i, 'ID'],
];

function normalizeExplicit(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  // Validate against the ISO set rather than trusting any two capitals: "UK" is
  // not an ISO code (GB is), and an ATS that puts a US state in its country
  // field would otherwise yield Canada for "CA" and India for "IN".
  const upper = t.toUpperCase();
  if (/^[A-Z]{2}$/.test(t)) {
    if (upper === 'UK') return 'GB';
    if (COUNTRY_LABELS[upper]) return upper;
  }
  for (const [pattern, code] of COUNTRY_NAMES) if (pattern.test(t)) return code;
  if (US_MARKERS.test(t)) return 'US';
  return undefined;
}

/**
 * Best-effort country code. Non-US signals are checked first: a string like
 * "Washington, United Kingdom" would otherwise match a US state name and be
 * misfiled as US.
 */
export function inferCountry(
  locationRaw: string | undefined,
  explicit?: string,
): string | undefined {
  if (explicit) {
    const fromExplicit = normalizeExplicit(explicit);
    if (fromExplicit) return fromExplicit;
  }
  if (!locationRaw) return undefined;
  const t = locationRaw.trim();
  if (!t) return undefined;

  // An explicit country NAME still wins first: "Washington, United Kingdom" is
  // British despite the state name.
  for (const [pattern, code] of COUNTRY_NAMES) if (pattern.test(t)) return code;

  // Then explicit US signals, BEFORE the city table. Running cities first filed
  // "Vienna, Virginia, United States" as Austria, "Vancouver, Washington" as
  // Canada, and "London, KY" / "Paris, TX" / "Rome, GA" as their European
  // namesakes — 46 corpus rows whose location literally said United States.
  if (US_MARKERS.test(t)) return 'US';

  // "Austin, TX" / "Bethesda, MD 20817" — a two-letter token that is a real
  // state code.
  //
  // Except when that token is also the country code of a foreign city named in
  // the same string. "Pune, IN" and "Bangalore, IN" were being read as Indiana
  // and filed as United States — the mirror image of the Vienna, Virginia bug,
  // and just as wrong. Several state codes collide with country codes: IN, DE,
  // CA, MD, PA, LA, MO, MT, NE, SC, SD, TN, ID, AL, AR.
  const cityCountry = CITY_COUNTRY.find(([pattern]) => pattern.test(t))?.[1];
  for (const part of t.split(/[,|;\-–]/)) {
    const token = part.trim().split(/\s+/)[0];
    if (!token) continue;
    const upper = token.toUpperCase();
    if (!US_STATE_CODES.has(upper)) continue;
    // The city agrees with the code: it is the country, not the state.
    if (cityCountry && cityCountry === upper) return cityCountry;
    return 'US';
  }
  if (US_STATE_NAMES.test(t)) return 'US';

  // Foreign city names next — only once nothing said United States.
  for (const [pattern, code] of CITY_COUNTRY) if (pattern.test(t)) return code;

  // Bare US cities last of all, so a foreign namesake is never overruled: the
  // CITY_COUNTRY table above already claimed the ambiguous ones, and this list
  // deliberately excludes names shared with another country.
  if (US_CITIES.test(t)) return 'US';

  return undefined;
}

export const COUNTRY_LABELS: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', IE: 'Ireland', IN: 'India',
  PH: 'Philippines', MY: 'Malaysia', SG: 'Singapore', CA: 'Canada',
  DE: 'Germany', FR: 'France', ES: 'Spain', NL: 'Netherlands', BE: 'Belgium',
  IT: 'Italy', PT: 'Portugal', PL: 'Poland', RO: 'Romania', CZ: 'Czechia',
  HU: 'Hungary', AT: 'Austria', CH: 'Switzerland', SE: 'Sweden', DK: 'Denmark',
  NO: 'Norway', FI: 'Finland', AU: 'Australia', NZ: 'New Zealand', JP: 'Japan',
  CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', KR: 'South Korea', VN: 'Vietnam',
  TH: 'Thailand', ID: 'Indonesia', IL: 'Israel', AE: 'UAE', SA: 'Saudi Arabia',
  EG: 'Egypt', ZA: 'South Africa', KE: 'Kenya', NG: 'Nigeria', MX: 'Mexico',
  BR: 'Brazil', AR: 'Argentina', CO: 'Colombia', CL: 'Chile', CR: 'Costa Rica',
  // Added alongside the country patterns above. Without a label the dropdown
  // shows a bare code, which reads like a bug rather than a country.
  LT: 'Lithuania', LV: 'Latvia', EE: 'Estonia', UA: 'Ukraine', SK: 'Slovakia',
  SI: 'Slovenia', BG: 'Bulgaria', GR: 'Greece', RS: 'Serbia', HR: 'Croatia',
  BA: 'Bosnia and Herzegovina', MK: 'North Macedonia', AL: 'Albania',
  MD: 'Moldova', CY: 'Cyprus', MT: 'Malta', IS: 'Iceland', LU: 'Luxembourg',
  TR: 'Turkey', PE: 'Peru', UY: 'Uruguay', PY: 'Paraguay', BO: 'Bolivia',
  EC: 'Ecuador', VE: 'Venezuela', PA: 'Panama', GT: 'Guatemala', HN: 'Honduras',
  DO: 'Dominican Republic', MA: 'Morocco', TN: 'Tunisia', GH: 'Ghana',
  UG: 'Uganda', JO: 'Jordan', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain',
  OM: 'Oman', PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal',
  KH: 'Cambodia',
};

/**
 * Tidies a location for display.
 *
 * ATS feeds carry whatever the employer typed, which includes full street
 * addresses ("7000 Target Pkwy N,NCD-0375 Brooklyn Park,MN 55445") and
 * twenty-city lists. Neither is readable in a job card, so this keeps the part
 * a person actually needs — the city and region — and summarises the rest.
 */
export function cleanLocation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // Multi-location lists: keep the first two, count the remainder.
  const parts = s.split(/\s*;\s*/).filter(Boolean);
  if (parts.length > 2) {
    return `${parts[0]}, ${parts[1]} +${parts.length - 2} more`;
  }
  s = parts.join('; ');

  // Drop a leading street address: a segment starting with a house number, or
  // an internal mail-stop code.
  s = s
    .replace(/^\d+\s+[^,]*,\s*/, '')
    .replace(/\b[A-Z]{2,4}-\d{3,}\b,?\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Trailing ZIP / postcode adds nothing once the city is present.
  // \d{5} alone turned "Bengaluru, Karnataka 560103" into "...Karnataka 5".
  // Six digits first: \d{5} run first ate the last five of a 6-digit Indian PIN
  // and left "Bengaluru, Karnataka 5".
  s = s.replace(/\s*\d{6}$/, '').replace(/\s*\d{5}(-\d{4})?$/, '').replace(/,\s*$/, '').trim();

  // "Brooklyn Park,MN" -> "Brooklyn Park, MN"
  s = s.replace(/,(?=\S)/g, ', ');

  return s.length > 0 ? s.slice(0, 80) : null;
}
