const MONTHS = new Map([
  ['januari', 1], ['jan', 1], ['january', 1],
  ['februari', 2], ['feb', 2], ['february', 2],
  ['maret', 3], ['mar', 3], ['march', 3],
  ['april', 4], ['apr', 4],
  ['mei', 5], ['may', 5],
  ['juni', 6], ['jun', 6], ['june', 6],
  ['juli', 7], ['jul', 7], ['july', 7],
  ['agustus', 8], ['agu', 8], ['agt', 8], ['aug', 8], ['august', 8],
  ['september', 9], ['sep', 9], ['sept', 9],
  ['oktober', 10], ['okt', 10], ['oct', 10], ['october', 10],
  ['november', 11], ['nov', 11],
  ['desember', 12], ['des', 12], ['dec', 12], ['december', 12]
]);

// Teks berikut adalah label kontrol antarmuka, bukan bagian dari komentar.
// Urutan terpanjang lebih dulu mencegah "selengkapnya" memotong label
// "lihat selengkapnya" secara parsial.
const CONTENT_CONTROL_LABELS = Object.freeze([
  'tampilkan lebih sedikit', 'tampilkan lebih banyak',
  'lihat lebih sedikit', 'lihat lebih banyak',
  'baca lebih sedikit', 'baca lebih banyak',
  'tampilkan selengkapnya', 'lihat selengkapnya', 'baca selengkapnya',
  'continue reading', 'show less', 'show more', 'see less', 'see more',
  'view less', 'view more', 'read less', 'read more',
  'selengkapnya'
].sort((a, b) => b.length - a.length));

function stripContentControlLabels(value, options = {}) {
  if (value == null) return value;
  const preserveLineBreaks = options.preserveLineBreaks === true;
  let text = repairCommonMojibake(value).replace(/\u00a0/g, ' ');
  text = preserveLineBreaks
    ? text.replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : text.replace(/\s+/g, ' ').trim();
  if (!text) return text;

  // Beberapa SPA menempelkan label tombol langsung ke huruf/tanda baca
  // terakhir komentar. Karena itu pencocokan sengaja tidak mensyaratkan spasi.
  let changed = true;
  while (changed && text) {
    changed = false;
    for (const label of CONTENT_CONTROL_LABELS) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next = text.replace(new RegExp(`(?:\\s*(?:\\.{2,}|\\u2026+|[·•|–—-]+)\\s*)?${escaped}\\s*$`, 'iu'), '').trim();
      if (next !== text) {
        text = next;
        changed = true;
        break;
      }
    }
  }
  return text;
}

function isNarrativeFieldName(name) {
  return /(?:review|ulasan|comment|komentar|feedback|testimonial|sentiment|description|content|body).*(?:text|copy|content|body|description)?|^(?:text|comment|komentar|ulasan)$/i.test(String(name || ''));
}

function repairCommonMojibake(value) {
  if (value == null) return value;
  return String(value)
    // Common UTF-8 smart quote sequences decoded as Windows-1252/Latin-1.
    .replace(/â€œ|â€|â€ž|â€Ÿ/g, '"')
    .replace(/â€˜|â€™|â€š|â€›/g, "'")
    .replace(/â€¯|Â /g, ' ')
    .replace(/Â(?=\S|$)/g, '')
    // A partially damaged smart-quote marker sometimes remains as "â€".
    .replace(/â€/g, '');
}

function cleanReviewTitle(value) {
  if (value == null) return value;
  let text = repairCommonMojibake(value)
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/["“”„‟«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function pad2(value) { return String(value).padStart(2, '0'); }
function isoDate(year, month, day) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}


function formatScrapedAt(value = new Date()) {
  const existing = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(existing)) return existing;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${offset}`;
}

function referenceCalendarParts(reference = new Date()) {
  if (reference instanceof Date && !Number.isNaN(reference.getTime())) {
    return {
      year: reference.getFullYear(), month: reference.getMonth() + 1, day: reference.getDate(),
      hour: reference.getHours(), minute: reference.getMinutes(), second: reference.getSeconds()
    };
  }
  const raw = String(reference ?? '').trim();
  const calendar = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (calendar && isoDate(calendar[1], calendar[2], calendar[3])) {
    return {
      year: Number(calendar[1]), month: Number(calendar[2]), day: Number(calendar[3]),
      hour: calendar[4] == null ? 12 : Number(calendar[4]),
      minute: Number(calendar[5] || 0), second: Number(calendar[6] || 0)
    };
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      year: parsed.getFullYear(), month: parsed.getMonth() + 1, day: parsed.getDate(),
      hour: parsed.getHours(), minute: parsed.getMinutes(), second: parsed.getSeconds()
    };
  }
  const now = new Date();
  return {
    year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
    hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds()
  };
}

function normalizeRelativeDateValue(value, reference = new Date()) {
  // Missing/optional review dates are valid source states. Never let one null
  // value abort a complete multi-page run.
  if (value == null) return null;
  const repaired = repairCommonMojibake(value);
  if (repaired == null) return null;
  const original = String(repaired).replace(/\s+/g, ' ').trim();
  if (!original) return null;
  const text = original
    .replace(/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:on\s+|pada\s+)?/i, '')
    .trim();
  const base = referenceCalendarParts(reference);
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day, base.hour ?? 12, base.minute || 0, base.second || 0));
  const lower = text.toLowerCase();

  if (/^(?:today|hari ini|just now|baru saja)$/.test(lower)) return isoDate(base.year, base.month, base.day);
  if (/^(?:yesterday|kemarin)$/.test(lower)) {
    date.setUTCDate(date.getUTCDate() - 1);
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const match = lower.match(/^(?:(a|an|one|satu)\s+|(\d+)\s*)(minute|minutes|minute\(s\)|hour|hours|hour\(s\)|day|days|day\(s\)|week|weeks|week\(s\)|month|months|month\(s\)|year|years|year\(s\)|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i);
  if (!match) return null;
  const amount = match[1] ? 1 : Number(match[2]);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000) return null;
  const unit = match[3].toLowerCase();

  if (/^(?:minute|minutes|minute\(s\)|menit)$/.test(unit)) date.setUTCMinutes(date.getUTCMinutes() - amount);
  else if (/^(?:hour|hours|hour\(s\)|jam)$/.test(unit)) date.setUTCHours(date.getUTCHours() - amount);
  else if (/^(?:day|days|day\(s\)|hari)$/.test(unit)) date.setUTCDate(date.getUTCDate() - amount);
  else if (/^(?:week|weeks|week\(s\)|minggu|pekan)$/.test(unit)) date.setUTCDate(date.getUTCDate() - amount * 7);
  else if (/^(?:month|months|month\(s\)|bulan)$/.test(unit)) date.setUTCMonth(date.getUTCMonth() - amount);
  else if (/^(?:year|years|year\(s\)|tahun)$/.test(unit)) date.setUTCFullYear(date.getUTCFullYear() - amount);
  else return null;
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function normalizeDateValue(value, reference = new Date()) {
  if (value == null) return null;
  let text = repairCommonMojibake(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const epochMatch = text.match(/^["']?(\d{10}|\d{13})["']?$/);
  if (epochMatch) {
    const numeric = Number(epochMatch[1]);
    const ms = epochMatch[1].length === 10 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate()) || text;
  }

  const relative = normalizeRelativeDateValue(text, reference);
  if (relative) return relative;

  // Plain ISO date is already canonical. For a legacy ISO datetime created by
  // v0.7, recover the machine-local calendar day. Older CrawlStudio versions
  // converted page dates through Date.toISOString(), which could shift an
  // Indonesian review one day backwards (for example 28 Juli -> 27T16:00Z).
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return isoDate(match[1], match[2], match[3]) || text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const legacyDate = new Date(text);
    if (!Number.isNaN(legacyDate.getTime())) {
      return isoDate(legacyDate.getFullYear(), legacyDate.getMonth() + 1, legacyDate.getDate()) || text.slice(0, 10);
    }
  }

  text = text
    .replace(/^diulas\s+pada\s+/i, '')
    .replace(/^reviewed\s+(?:on\s+)?/i, '')
    .replace(/^posted\s+(?:on\s+)?/i, '')
    .trim();

  // Indonesian / day-first month names: 28 Juli 2026.
  match = text.match(/\b(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})\b/i);
  if (match) {
    const monthName = match[2].replace(/\./g, '').toLowerCase();
    const month = MONTHS.get(monthName);
    if (month) return isoDate(match[3], month, match[1]) || text;
  }

  // English month-first: July 28, 2026.
  match = text.match(/\b([A-Za-zÀ-ÿ.]+)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (match) {
    const monthName = match[1].replace(/\./g, '').toLowerCase();
    const month = MONTHS.get(monthName);
    if (month) return isoDate(match[3], month, match[2]) || text;
  }

  // Common numeric day-first formats.
  match = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (match) return isoDate(match[3], match[2], match[1]) || text;

  // Final fallback for browser-recognized dates. Export calendar date only.
  const timestamp = Date.parse(text);
  if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
  return text;
}

function cleanRatingLabel(value) {
  if (value == null) return value;
  const text = repairCommonMojibake(value).replace(/\s+/g, ' ').trim();

  // Some sites render the scale denominator as a separate sibling, e.g. "/5".
  // When the user intentionally maps that element to rating_label, keep only
  // the useful numeric value so downstream CSV/Excel processing does not need
  // to strip presentation punctuation again.
  const denominatorOnly = text.match(/^\/\s*([+-]?\d+(?:[.,]\d+)?)$/);
  if (denominatorOnly) {
    const n = Number(denominatorOnly[1].replace(',', '.'));
    return Number.isFinite(n) ? String(n) : denominatorOnly[1].replace(',', '.');
  }

  // Keep the common scale maxima 5 and 10 idempotently. This matters because
  // rows can pass through sanitization more than once (runner -> RunStore ->
  // export/UI). Other standalone numeric values are still treated as a likely
  // accidental duplicate of rating_score.
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) {
    const n = Number(text.replace(',', '.'));
    if (n === 5 || n === 10) return String(n);
    return '';
  }
  return text;
}

function sanitizeExportRow(row) {
  let output = { ...row };
  const detectedSubject = String(output.review_subject ?? output._objectName ?? '').trim();
  if (detectedSubject && !String(output.review_subject ?? '').trim()) output.review_subject = detectedSubject;
  // Keep review_subject near the record identity instead of burying it among technical provenance columns.
  if (detectedSubject) {
    const ordered = {};
    let inserted = false;
    for (const [key, value] of Object.entries(output)) {
      ordered[key] = value;
      if (key === 'review_id') { ordered.review_subject = detectedSubject; inserted = true; }
    }
    if (!inserted) ordered.review_subject = detectedSubject;
    output = ordered;
  }
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === 'string' && isNarrativeFieldName(key)) {
      const preserveLineBreaks = /^(?:review_text|review_original_text|review_positive_text|review_negative_text|reply_text|review_reply_text)$/i.test(key);
      output[key] = stripContentControlLabels(value, { preserveLineBreaks });
    }
  }
  if (Object.prototype.hasOwnProperty.call(output, 'review_title')) {
    output.review_title = cleanReviewTitle(output.review_title);
  }
  if (Object.prototype.hasOwnProperty.call(output, 'rating_label')) {
    output.rating_label = cleanRatingLabel(output.rating_label);
  }
  if (Object.prototype.hasOwnProperty.call(output, 'review_date')) {
    const rawDate = output.review_date;
    // A broad selector can legitimately miss the date on one card/page. Treat
    // that as an empty value instead of throwing and terminating the run.
    const relative = rawDate == null || String(rawDate).trim() === ''
      ? null
      : normalizeRelativeDateValue(rawDate, output._scrapedAt || new Date());
    if (relative && !Object.prototype.hasOwnProperty.call(output, 'review_date_raw')) output.review_date_raw = rawDate;
    output.review_date = rawDate == null ? null : normalizeDateValue(rawDate, output._scrapedAt || new Date());
  } else if (Object.prototype.hasOwnProperty.call(output, 'review_date_raw')) {
    const normalized = normalizeDateValue(output.review_date_raw, output._scrapedAt || new Date());
    if (normalized && normalized !== output.review_date_raw) output.review_date = normalized;
  }
  if (Object.prototype.hasOwnProperty.call(output, '_scrapedAt')) {
    output._scrapedAt = formatScrapedAt(output._scrapedAt);
  }
  return output;
}

function sanitizeExportRows(rows) {
  return Array.isArray(rows) ? rows.map(sanitizeExportRow) : [];
}

module.exports = {
  CONTENT_CONTROL_LABELS,
  repairCommonMojibake,
  stripContentControlLabels,
  isNarrativeFieldName,
  cleanReviewTitle,
  cleanRatingLabel,
  normalizeRelativeDateValue,
  normalizeDateValue,
  formatScrapedAt,
  sanitizeExportRow,
  sanitizeExportRows
};
