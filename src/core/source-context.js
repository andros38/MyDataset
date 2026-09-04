const TRACKING_QUERY = /^(?:utm_.+|gclid|fbclid|msclkid|yclid|cid|tag|searchrequestid|sessionid|session_id|ref|referrer|affiliate|aff_id)$/i;
const IDENTITY_QUERY = /^(?:inventory_id|inventoryid|hotel_id|hotelid|property_id|propertyid|product_id|productid|accommodation_id|accommodationid|listing_id|listingid|slug|hotel|property|product|name|hotel_name|property_name|product_name|spec)$/i;
const GENERIC_SEGMENTS = new Set([
  'review','reviews','ulasan','hotel','hotels','property','properties','product','products',
  'id','id-id','en','en-us','en-id','index','detail','details','pdp','list','listing','search','results'
]);

function safeUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}


function isHttpSourceUrl(value) {
  const parsed = safeUrl(value);
  return Boolean(parsed && /^(?:http:|https:)$/i.test(parsed.protocol));
}

function siteProfileFromUrl(value) {
  const parsed = safeUrl(value);
  if (!parsed) return '';
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)tiket\.com$/.test(host)) return 'tiket';
  if (/(^|\.)agoda\./.test(host)) return 'agoda';
  if (/(^|\.)traveloka\.com$/.test(host)) return 'traveloka';
  if (/(^|\.)(?:trip\.com|ctrip\.com)$/.test(host)) return 'trip';
  if (/(^|\.)booking\.com$/.test(host)) return 'booking';
  return 'generic';
}

function sourceUrlMatchesSite(value, siteProfile = '') {
  if (!isHttpSourceUrl(value)) return false;
  const expected = String(siteProfile || '').toLowerCase();
  if (!expected || expected === 'auto' || expected === 'generic') return true;
  return siteProfileFromUrl(value) === expected;
}

function titleCase(value) {
  const minor = new Set(['dan','di','ke','dari','of','the','and','by']);
  return String(value || '').split(/\s+/).filter(Boolean).map((word, index) => {
    if (/^[A-Z0-9]{2,5}$/.test(word)) return word;
    const lower = word.toLocaleLowerCase('id-ID');
    if (index > 0 && minor.has(lower)) return lower;
    return lower.charAt(0).toLocaleUpperCase('id-ID') + lower.slice(1);
  }).join(' ');
}

function humanizeSlug(value) {
  let text = '';
  try { text = decodeURIComponent(String(value || '')); } catch { text = String(value || ''); }
  text = text
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/(?:[-_])h?\d{6,}(?:[-_]\d+)*$/gi, '')
    .replace(/^\d+[-_]/, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /^\d+$/.test(text) || text.length < 3) return '';
  return titleCase(text);
}

function websiteNameFromUrl(value) {
  const parsed = safeUrl(value);
  if (!parsed) return '';
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const suffixes = ['.co.id','.com.au','.co.uk','.co.jp','.com.sg','.com.my','.co.nz','.com','.net','.org','.io','.ai','.id'];
  let base = host;
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) { base = base.slice(0, -suffix.length); break; }
  }
  const label = base.split('.').filter(Boolean).pop() || host.split('.')[0] || '';
  return titleCase(label);
}

function hasIdentityQuery(value) {
  const parsed = safeUrl(value);
  if (!parsed) return false;
  return [...parsed.searchParams.keys()].some(key => IDENTITY_QUERY.test(key));
}

function normalizeSourceUrl(value) {
  const parsed = safeUrl(value);
  if (!parsed) return String(value || '');
  parsed.hash = '';
  // Booking and Agoda hotel identity is carried by the pathname. Query parameters
  // on captured detail pages are predominantly search, affiliate, or transient
  // session state, so they are removed from the canonical provenance URL.
  if (/(^|\.)booking\.com$/i.test(parsed.hostname) && /\/hotel\//i.test(parsed.pathname)) {
    parsed.search = '';
    return parsed.toString();
  }
  if (/(^|\.)agoda\./i.test(parsed.hostname) && /\/hotel\//i.test(parsed.pathname)) {
    parsed.search = '';
    return parsed.toString();
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function chooseSourceUrl(actualUrl, canonicalUrl) {
  const actual = normalizeSourceUrl(actualUrl);
  const canonical = normalizeSourceUrl(canonicalUrl);
  if (!canonical) return actual;
  if (!actual) return canonical;
  // Review hubs such as Tiket use one generic canonical URL for every hotel.
  // Keep the actual URL when it contains the identity that the canonical drops.
  if (hasIdentityQuery(actual) && !hasIdentityQuery(canonical)) return actual;
  if (objectNameFromUrl(actual) && !objectNameFromUrl(canonical)) return actual;
  const actualParsed = safeUrl(actual);
  const canonicalParsed = safeUrl(canonical);
  if (!actualParsed || !canonicalParsed || actualParsed.hostname !== canonicalParsed.hostname) return actual;
  return canonical;
}

function objectNameFromUrl(value) {
  const parsed = safeUrl(value);
  if (!parsed) return '';

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').map(segment => segment.trim()).filter(Boolean);

  // Agoda commonly uses /<property-slug>/hotel/<city-slug>.html. The property
  // is the segment BEFORE /hotel/; the segment after it is only the city.
  if (/(^|\.)agoda\./i.test(host)) {
    const hotelIndex = segments.findIndex(segment => String(segment).toLowerCase() === 'hotel');
    if (hotelIndex > 0) {
      const candidate = humanizeSlug(segments[hotelIndex - 1]);
      if (candidate && !GENERIC_SEGMENTS.has(candidate.toLowerCase())) return candidate;
    }
  }

  // Traveloka hotel/detail URLs can place the property identity inside `spec`,
  // e.g. ...HOTEL.<numeric-id>.Amaris Hotel Panakkukang.2.
  const travelokaSpec = parsed.searchParams.get('spec');
  if (travelokaSpec) {
    const parts = String(travelokaSpec).split('.').filter(Boolean);
    const hotelIndex = parts.findIndex(part => String(part).toUpperCase() === 'HOTEL');
    if (hotelIndex >= 0 && parts.length > hotelIndex + 2) {
      const nameParts = parts.slice(hotelIndex + 2);
      if (nameParts.length > 1 && /^\d+$/.test(nameParts[nameParts.length - 1])) nameParts.pop();
      const specName = humanizeSlug(nameParts.join(' '));
      if (specName) return specName;
    }
  }

  const preferredKeys = [
    'hotel_name','property_name','product_name','slug','inventory_id','inventoryId',
    'hotel','property','product','name'
  ];
  for (const key of preferredKeys) {
    const raw = parsed.searchParams.get(key);
    const name = humanizeSlug(raw);
    if (name) return name;
  }
  const hotelIndex = segments.findIndex(segment => ['hotel','hotels','property','properties'].includes(String(segment).toLowerCase()));
  if (hotelIndex >= 0) {
    const after = segments.slice(hotelIndex + 1);
    for (const segment of [...after].reverse()) {
      const raw = String(segment).toLowerCase();
      if (GENERIC_SEGMENTS.has(raw) || /^(?:indonesia|malaysia|singapore|thailand|vietnam|philippines)$/i.test(raw)) continue;
      const name = humanizeSlug(segment);
      if (name && !GENERIC_SEGMENTS.has(name.toLowerCase())) return name;
    }
  }
  for (let index = 0; index < segments.length; index += 1) {
    const current = String(segments[index]).toLowerCase();
    if (['hotel','hotels','property','properties'].includes(current) && index > 0) {
      if (GENERIC_SEGMENTS.has(String(segments[index - 1]).toLowerCase())) continue;
      const previous = humanizeSlug(segments[index - 1]);
      if (previous && !GENERIC_SEGMENTS.has(previous.toLowerCase())) return previous;
    }
  }
  for (const segment of [...segments].reverse()) {
    const low = String(segment).toLowerCase();
    if (GENERIC_SEGMENTS.has(low)) continue;
    const name = humanizeSlug(segment);
    if (name && !GENERIC_SEGMENTS.has(name.toLowerCase())) return name;
  }
  return '';
}

function cleanPageName(value, siteName = '') {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 3 || text.length > 180) return '';
  text = text
    .replace(/^(?:review|reviews|ulasan|guest reviews?|hotel reviews?)\s*[:\-–—|]\s*/i, '')
    .replace(/\s*[:\-–—|]\s*(?:review|reviews|ulasan|guest reviews?)$/i, '')
    .trim();
  if (siteName) {
    const escaped = siteName.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('\\s*[-–—|]\\s*(?:www\\.)?' + escaped + '(?:\\.com|\\.id)?\\s*$', 'i'), '').trim();
    if (new RegExp('^(?:www\\.)?' + escaped + '(?:\\.(?:com|id|co\\.id))?$', 'i').test(text)) return '';
  }
  if (/^(?:review|reviews|ulasan|hotel|tiket|agoda|traveloka|trip|booking)$/i.test(text)) return '';
  return text;
}

function resolveSourceContext(signals = {}) {
  const actualUrl = String(signals.url || signals.actualUrl || '');
  const canonicalUrl = String(signals.canonicalUrl || '');
  const identityUrls = (Array.isArray(signals.identityUrls) ? signals.identityUrls : [])
    .map(String)
    .filter(value => /^(?:https?:|file:)/i.test(value));
  const identityUrl = identityUrls.find(hasIdentityQuery) || '';
  const effectiveUrl = hasIdentityQuery(actualUrl) ? actualUrl : (identityUrl || actualUrl);
  const sourceUrl = chooseSourceUrl(effectiveUrl, canonicalUrl);
  const siteName = websiteNameFromUrl(sourceUrl || effectiveUrl);
  const structured = (Array.isArray(signals.structuredNames) ? signals.structuredNames : [])
    .map(value => cleanPageName(value, siteName)).filter(Boolean);
  const metaNames = (Array.isArray(signals.metaNames) ? signals.metaNames : [])
    .map(value => cleanPageName(value, siteName)).filter(Boolean);
  const urlName = objectNameFromUrl(effectiveUrl || sourceUrl);
  const headings = (Array.isArray(signals.headings) ? signals.headings : [])
    .map(value => cleanPageName(value, siteName)).filter(Boolean);
  const titleName = cleanPageName(signals.title, siteName);
  const preferred = cleanPageName(signals.preferredObjectName, siteName);
  const profile = siteProfileFromUrl(effectiveUrl || sourceUrl);
  // Page-derived names beat location slugs. Agoda in particular often ends its
  // detail URL with /hotel/jakarta-id.html, which is a city and not the hotel.
  // Traveloka keeps a useful hotel identity in `spec`, so its URL remains an
  // earlier fallback after structured data.
  const candidates = profile === 'traveloka'
    ? [[structured[0],'structured-data'],[urlName,'url'],[headings[0],'heading'],[metaNames[0],'page-metadata'],[titleName,'title'],[preferred,'project']]
    : [[structured[0],'structured-data'],[headings[0],'heading'],[metaNames[0],'page-metadata'],[titleName,'title'],[urlName,'url'],[preferred,'project']];
  const chosen = candidates.find(([value]) => Boolean(value)) || ['', 'unknown'];
  const objectName = chosen[0] || '';
  return {
    objectName,
    siteName,
    sourceUrl,
    canonicalUrl: normalizeSourceUrl(canonicalUrl || sourceUrl || ''),
    actualUrl,
    identityUrl,
    detectedBy: chosen[1]
  };
}

module.exports = {
  TRACKING_QUERY,
  IDENTITY_QUERY,
  isHttpSourceUrl,
  siteProfileFromUrl,
  sourceUrlMatchesSite,
  humanizeSlug,
  websiteNameFromUrl,
  normalizeSourceUrl,
  chooseSourceUrl,
  objectNameFromUrl,
  cleanPageName,
  resolveSourceContext
};
