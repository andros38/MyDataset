const { normalizeDateValue, sanitizeExportRow } = require('./normalizers');

const CANONICAL_SCHEMA_VERSION = 'mydataset-review-v8';
const STANDARD_SCHEMA_VERSION = 'mydataset-review-standard-v8';
const RATING_NORMALIZED_MAX = 10;

// rating_normalized deliberately is NOT part of the single-run schema.
// It is added only by the combined-dataset pipeline when more than one
// rating_max exists in the merged dataset.
const CANONICAL_REVIEW_COLUMNS = Object.freeze([
  'review_id','canonical_object','source_object_name','review_subject','review_provider',
  'review_title','review_text','review_positive_text','review_negative_text','review_original_text',
  'review_date','review_datetime','review_datetime_utc','review_timestamp',
  'rating_score','rating_max','rating_label',
  'reviewer_id','reviewer_name','reviewer_status','reviewer_country',
  'travel_type','room_type','stay_start_date','stay_end_date','stay_detail','reaction_count',
  'reply_name','reply_text','reply_date','media_count','media_urls','translation_status',
  'source_site','source_type','source_url','source_file','source_page','captured_at',
  'acquisition_method','session_id','run_id','schema_version'
]);

const STANDARD_REVIEW_COLUMNS = Object.freeze([
  'review_id','canonical_object','source_object_name','review_subject','review_provider',
  'review_title','review_text','review_positive_text','review_negative_text','review_date',
  'rating_score','rating_max','rating_label',
  'reviewer_name','reviewer_country','reviewer_status','travel_type','room_type','stay_start_date','stay_end_date','stay_detail',
  'source_site','source_url','acquisition_method','session_id','run_id'
]);

function first(row, names, fallback = '') {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function normalizeSiteName(value = '') {
  const raw = String(value || '').replace(/^www\./i,'').trim();
  if (/agoda/i.test(raw)) return 'AGODA';
  if (/traveloka/i.test(raw)) return 'TRAVELOKA';
  if (/tiket/i.test(raw)) return 'TIKET';
  if (/trip(?:\.com)?/i.test(raw)) return 'TRIP';
  if (/booking(?:\.com)?/i.test(raw)) return 'BOOKING';
  if (!raw || /^auto$/i.test(raw)) return '';
  return raw.toUpperCase();
}

function siteFromRow(row = {}, context = {}) {
  const direct = first(row, ['source_site','review_provider','review_origin'], context.siteName || context.siteProfile || '');
  const normalizedDirect = normalizeSiteName(direct);
  if (normalizedDirect) return normalizedDirect;
  const url = String(first(row, ['_sourceUrl','source_url'], context.sourceUrl || ''));
  if (/agoda\./i.test(url)) return 'AGODA';
  if (/traveloka\./i.test(url)) return 'TRAVELOKA';
  if (/tiket\./i.test(url)) return 'TIKET';
  if (/trip\.com/i.test(url)) return 'TRIP';
  if (/booking\.com/i.test(url)) return 'BOOKING';
  return normalizeSiteName(context.siteProfile) || 'GENERIC';
}

function ratingPair(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/\u00a0/g, ' ');
  const match = raw.match(/([+-]?\d+(?:[.,]\d+)?)\s*\/\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const score = Number(match[1].replace(',', '.'));
  const max = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return null;
  return { score, max };
}

function numericRatingValue(value, component = 'score') {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const pair = ratingPair(value);
  if (pair) return component === 'max' ? pair.max : pair.score;
  const raw = String(value ?? '').trim().replace(',', '.');
  const denominator = raw.match(/^\/\s*([+-]?\d+(?:\.\d+)?)$/);
  if (denominator) {
    const n = Number(denominator[1]);
    return Number.isFinite(n) ? n : null;
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function ratingParts(row = {}) {
  const rawScore = first(row, ['rating_score','reviewScore','score','rating']);
  const rawMax = first(row, ['rating_max','reviewMaxScore','max_score','rating_scale']);
  let ratingLabel = String(first(row, ['rating_label'])).trim();

  const scorePair = ratingPair(rawScore);
  const labelPair = ratingPair(ratingLabel);
  let score = numericRatingValue(rawScore, 'score');
  let max = numericRatingValue(rawMax, 'max');

  // A source may expose "8/10" in one element. Split it before storage so the
  // dataset never depends on presentation punctuation such as "/5" or "/10".
  if (max == null && scorePair) max = scorePair.max;
  if (score == null && labelPair) score = labelPair.score;
  if (max == null && labelPair) max = labelPair.max;

  // Some DOM pages expose only the denominator as a sibling (e.g. "/5").
  // This is source evidence, not an inferred website-specific scale.
  if (max == null) {
    const labelMax = numericRatingValue(ratingLabel, 'max');
    if (labelMax === 5 || labelMax === 10) max = labelMax;
  }

  // Remove scale presentation from rating_label. Keep only the semantic label.
  if (ratingLabel) {
    ratingLabel = ratingLabel
      .replace(/^\s*[+-]?\d+(?:[.,]\d+)?\s*\/\s*[+-]?\d+(?:[.,]\d+)?\s*(?:[·|:\-–—]\s*)?/u, '')
      .replace(/^\s*\/\s*[+-]?\d+(?:[.,]\d+)?\s*$/u, '')
      .trim();
    if (/^[+-]?\d+(?:[.,]\d+)?$/.test(ratingLabel)) ratingLabel = '';
  }

  return {
    score: Number.isFinite(score) ? score : '',
    max: Number.isFinite(max) && max > 0 ? max : '',
    label: ratingLabel
  };
}

function normalizedRating(score, max, targetMax = RATING_NORMALIZED_MAX) {
  const s = numericRatingValue(score, 'score');
  const m = numericRatingValue(max, 'max');
  const target = Number(targetMax);
  if (!Number.isFinite(s) || !Number.isFinite(m) || m <= 0 || !Number.isFinite(target) || target <= 0) return '';
  return Math.round((s / m * target) * 100) / 100;
}

function inferRatingMax(score, row = {}, context = {}) {
  const parts = ratingParts({ ...row, rating_score: score });
  return parts.max;
}

function ratingScaleProfile(rows = [], targetMax = RATING_NORMALIZED_MAX) {
  const maxima = [...new Set((Array.isArray(rows) ? rows : [])
    .map(row => numericRatingValue(row?.rating_max, 'max'))
    .filter(value => Number.isFinite(value) && value > 0))]
    .sort((a,b) => a-b);
  return {
    enabled: maxima.length > 1,
    sourceMaxima: maxima,
    targetMax: Number(targetMax) || RATING_NORMALIZED_MAX
  };
}

function insertNormalizedColumn(row = {}, value = '') {
  const output = {};
  let inserted = false;
  for (const [key, current] of Object.entries(row || {})) {
    if (key === 'rating_normalized' || key === 'rating_normalized_max') continue;
    output[key] = current;
    if (key === 'rating_max') {
      output.rating_normalized = value;
      inserted = true;
    }
  }
  if (!inserted) output.rating_normalized = value;
  return output;
}

function stripNormalizedColumns(row = {}) {
  const output = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key === 'rating_normalized' || key === 'rating_normalized_max') continue;
    output[key] = value;
  }
  return output;
}

function applyConditionalRatingNormalization(rows = [], options = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const profile = options.profile || ratingScaleProfile(source, options.targetMax);
  if (!profile.enabled) return { rows: source.map(stripNormalizedColumns), profile };
  return {
    rows: source.map(row => insertNormalizedColumn(row, normalizedRating(row?.rating_score, row?.rating_max, profile.targetMax))),
    profile
  };
}

function standardColumnsForRows(rows = []) {
  const hasNormalized = (Array.isArray(rows) ? rows : []).some(row => Object.prototype.hasOwnProperty.call(row || {}, 'rating_normalized'));
  if (!hasNormalized) return [...STANDARD_REVIEW_COLUMNS];
  const columns = [];
  for (const key of STANDARD_REVIEW_COLUMNS) {
    columns.push(key);
    if (key === 'rating_max') columns.push('rating_normalized');
  }
  return columns;
}

function normalizeStayDetailCanonical(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text
    .replace(/^Menginap\s+di\s+/i, 'Menginap pada ')
    .replace(/^Stayed\s+in\s+/i, 'Menginap pada ');
}

function toCanonicalReview(input = {}, context = {}) {
  const row = sanitizeExportRow(input || {});
  const rating = ratingParts(row);
  const subject = first(row, ['review_subject','_objectName','object_name'], context.reviewSubject || context.objectName || '');
  const sourceObjectName = first(row, ['source_object_name','_sourceObjectName','_objectName','review_subject','object_name'], context.sourceObjectName || subject || context.objectName || '');
  const canonicalObject = first(row, ['canonical_object'], context.canonicalObject || context.reviewSubject || subject || sourceObjectName || '');
  const sourceSite = siteFromRow(row, context);
  const reviewDateRaw = first(row, ['review_date','review_date_raw','date','reviewDate']);
  const output = {
    review_id: String(first(row, ['review_id','reviewId','id'])),
    canonical_object: String(canonicalObject || ''),
    source_object_name: String(sourceObjectName || ''),
    review_subject: String(subject || ''),
    review_provider: String(first(row, ['review_provider','reviewProviderText','reviewProvider'], sourceSite)),
    review_title: String(first(row, ['review_title','title'])),
    review_text: String(first(row, ['review_text','reviewContentText','comment','content','text'])),
    review_positive_text: String(first(row, ['review_positive_text','reviewPositives','positiveText'])),
    review_negative_text: String(first(row, ['review_negative_text','reviewNegatives','negativeText'])),
    review_original_text: String(first(row, ['review_original_text','reviewOriginalText'])),
    review_date: reviewDateRaw ? (normalizeDateValue(reviewDateRaw, row._scrapedAt || row._capturedAt || new Date()) || String(reviewDateRaw)) : '',
    review_datetime: String(first(row, ['review_datetime'])),
    review_datetime_utc: String(first(row, ['review_datetime_utc'])),
    review_timestamp: String(first(row, ['review_timestamp','reviewTimestamp'])),
    rating_score: rating.score,
    rating_max: rating.max,
    rating_label: rating.label,
    reviewer_id: String(first(row, ['reviewer_id','author_id','user_id'])),
    reviewer_name: String(first(row, ['reviewer_name','author','user_name','reviewer'])),
    reviewer_status: String(first(row, ['reviewer_status'])),
    reviewer_country: String(first(row, ['reviewer_country','country'])),
    travel_type: String(first(row, ['travel_type','trip_type','traveler_type'])),
    room_type: String(first(row, ['room_type','room','room_name'])),
    stay_start_date: String(first(row, ['stay_start_date','checkin_date','checkinDate'])),
    stay_end_date: String(first(row, ['stay_end_date','checkout_date','checkoutDate'])),
    stay_detail: normalizeStayDetailCanonical(first(row, ['stay_detail','stay_info'])),
    reaction_count: String(first(row, ['reaction_count'])),
    reply_name: String(first(row, ['reply_name','review_reply_name','replier_name'])),
    reply_text: String(first(row, ['reply_text','review_reply_text'])),
    reply_date: String(first(row, ['reply_date','review_reply_date'])),
    media_count: first(row, ['media_count'], ''),
    media_urls: String(first(row, ['media_urls'])),
    translation_status: String(first(row, ['translation_status'])),
    source_site: sourceSite,
    source_type: String(first(row, ['source_type','_sourceType'], context.sourceType || 'browser-dom')),
    source_url: String(first(row, ['source_url','_sourceUrl'], context.sourceUrl || '')),
    source_file: String(first(row, ['source_file','_sourceFile'])),
    source_page: String(first(row, ['source_page','_page'])),
    captured_at: String(first(row, ['captured_at','_capturedAt','_scrapedAt'])),
    acquisition_method: String(first(row, ['acquisition_method','_acquisitionMethod'], context.acquisitionMethod || '')),
    session_id: String(first(row, ['session_id','_sessionId'], context.sessionId || '')),
    run_id: String(first(row, ['run_id','_runId'], context.runId || '')),
    schema_version: CANONICAL_SCHEMA_VERSION
  };
  return Object.fromEntries(CANONICAL_REVIEW_COLUMNS.map(key => [key, output[key] ?? '']));
}

function canonicalizeRows(rows, context = {}) {
  return Array.isArray(rows) ? rows.map(row => toCanonicalReview(row, context)) : [];
}

function toStandardReview(input = {}, context = {}) {
  const canonical = toCanonicalReview(input, context);
  return Object.fromEntries(STANDARD_REVIEW_COLUMNS.map(key => [key, canonical[key] ?? '']));
}

function standardizeRows(rows, context = {}) {
  return Array.isArray(rows) ? rows.map(row => toStandardReview(row, context)) : [];
}

module.exports = {
  CANONICAL_SCHEMA_VERSION, STANDARD_SCHEMA_VERSION, CANONICAL_REVIEW_COLUMNS, STANDARD_REVIEW_COLUMNS,
  RATING_NORMALIZED_MAX, normalizeSiteName, normalizedRating, numericRatingValue, ratingParts, inferRatingMax,
  ratingScaleProfile, applyConditionalRatingNormalization, standardColumnsForRows,
  toCanonicalReview, canonicalizeRows, toStandardReview, standardizeRows
};
