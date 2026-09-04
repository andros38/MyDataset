const { cleanReviewTitle, normalizeDateValue, stripContentControlLabels, isNarrativeFieldName } = require('./normalizers');


function looksLikeReviewMetadataAggregate(value) {
  const text = String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 220) return false;
  const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|desember)';
  const dateRatingTail = new RegExp(`\\d{1,2}\\s+${month}\\s+\\d{4}\\s*(?:[•·|–—-]\\s*)?\\d+(?:[.,]\\d+)?\\s*\\/\\s*(?:5|10)(?:[.,]0+)?\\s*$`, 'i');
  if (!dateRatingTail.test(text)) return false;
  const travelMetadata = /\b(?:perjalanan\s+bisnis|business\s+trip|pasangan|couple|keluarga|family|solo|sendiri|teman|friends?|rombongan|group|liburan|leisure)\b/i.test(text);
  const sentenceLike = /[.!?](?:\s|$)/.test(text);
  return travelMetadata || (!sentenceLike && text.length <= 180);
}

function applyTransform(value, field = {}) {
  if (value == null) return null;
  let result = value;
  const transform = field.transform || 'none';

  if (typeof result === 'string' && field.trim !== false) result = result.trim();

  // Dataset-oriented cleanup for the common review schema. This is applied
  // before type conversion so preview, JSONL, JSON and CSV stay consistent.
  if (String(field.name || '').toLowerCase() === 'review_title') {
    result = cleanReviewTitle(result);
  }

  const fieldSemantics = `${field.name || ''} ${field.semanticRole || ''}`;
  if (typeof result === 'string' && isNarrativeFieldName(fieldSemantics)) {
    result = stripContentControlLabels(result);
  }

  // A review without a written comment is valid. Some OTA cards collapse the
  // reviewer header (name + trip type + date + rating) into one text node when
  // the actual comment is absent. Never promote that metadata bundle to
  // review_text; keep it null so downstream NLP and duplicate audit stay clean.
  if (/review[_\s-]*text|review[_\s-]*comment|comment[_\s-]*text/i.test(fieldSemantics)
      && looksLikeReviewMetadataAggregate(result)) {
    return null;
  }

  // Rating is stored as two numeric facts: rating_score and rating_max.
  // Presentation strings such as "8/10", "5/5 · Fantastis", or "/5"
  // are split before generic number extraction so they never become "810"/"55".
  const ratingRole = /rating[_\s-]*max|max[_\s-]*score|rating[_\s-]*scale/i.test(fieldSemantics)
    ? 'max'
    : (/rating[_\s-]*score|review[_\s-]*score|(?:^|\s)score(?:$|\s)/i.test(fieldSemantics) ? 'score' : '');
  if (ratingRole && typeof result === 'string') {
    const text = result.trim();
    const pair = text.match(/([+-]?\d+(?:[.,]\d+)?)\s*\/\s*([+-]?\d+(?:[.,]\d+)?)/);
    const denominator = text.match(/^\/\s*([+-]?\d+(?:[.,]\d+)?)$/);
    const standalone = text.match(/^([+-]?\d+(?:[.,]\d+)?)$/);
    const token = pair ? (ratingRole === 'max' ? pair[2] : pair[1]) : (denominator ? denominator[1] : (standalone ? standalone[1] : null));
    if (token != null) result = token.replace(',', '.');
  }

  if (transform === 'extractNumber') {
    const normalized = String(result)
      .replace(/\s+/g, '')
      .replace(/[^0-9,.-]/g, '');
    const comma = normalized.lastIndexOf(',');
    const dot = normalized.lastIndexOf('.');
    let numeric = normalized;
    if (comma > dot) numeric = normalized.replace(/\./g, '').replace(',', '.');
    else if (dot > comma && comma >= 0) numeric = normalized.replace(/,/g, '');
    else if ((normalized.match(/\./g) || []).length > 1) numeric = normalized.replace(/\./g, '');
    result = numeric;
  } else if (transform === 'lowercase') {
    result = String(result).toLowerCase();
  } else if (transform === 'uppercase') {
    result = String(result).toUpperCase();
  }

  // Canonical rating fields are numeric by contract even if an older project
  // saved their field type as text.
  if (ratingRole) {
    const n = Number(String(result).replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  }

  const type = field.dataType || 'text';
  if (type === 'number') {
    const n = Number(String(result).replace(/\s/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    if (typeof result === 'boolean') return result;
    const normalized = String(result).toLowerCase();
    if (['true', '1', 'yes', 'ya'].includes(normalized)) return true;
    if (['false', '0', 'no', 'tidak'].includes(normalized)) return false;
    return null;
  }
  if (type === 'date') {
    return normalizeDateValue(result);
  }
  return result == null ? null : String(result);
}

module.exports = { applyTransform };
