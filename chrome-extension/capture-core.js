(function(global){
  'use strict';

  const MAX_RESPONSE_BYTES = 30_000_000;
  const PLATFORM_PROFILES = Object.freeze({
    traveloka: {
      id:'traveloka', label:'Traveloka', host:/traveloka\.com$/i,
      primaryFilter:'getReviews',
      matchesPrimary:url => endpointLeaf(url) === 'getReviews',
      matchesDiagnostic:url => isReviewDiagnosticRecord({ url })
    },
    tiket: {
      id:'tiket', label:'Tiket', host:/tiket\.com$/i,
      primaryFilter:'verticalReview/internalReview',
      matchesPrimary:url => /\/tix-review-core\/verticalReview\/internalReview(?:\?|$)/i.test(String(url || '')),
      matchesDiagnostic:() => false
    }
  });

  function detectPlatform(value = '') {
    let host = '';
    try { host = new URL(String(value || '')).hostname.replace(/^www\./i,''); } catch { host = String(value || ''); }
    for (const profile of Object.values(PLATFORM_PROFILES)) if (profile.host.test(host)) return profile.id;
    return '';
  }
  function profileForPlatform(value = '') { return PLATFORM_PROFILES[String(value || '').toLowerCase()] || null; }
  function profileForUrl(value = '') { return profileForPlatform(detectPlatform(value)); }


  function decodeBody(content, encoding) {
    const raw = String(content || '');
    if (String(encoding || '').toLowerCase() !== 'base64') return raw;
    try {
      const binary = atob(raw);
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch { return raw; }
  }

  function parseJsonBody(content) {
    let raw = String(content || '').replace(/^\uFEFF/, '').trim();
    raw = raw.replace(/^\)\]\}',?\s*/, '');
    if (!(raw.startsWith('{') || raw.startsWith('['))) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function reviewArraysIn(value, depth = 0, seen = new WeakSet(), out = []) {
    if (value == null || depth > 10) return out;
    if (Array.isArray(value)) {
      if (value.length && value.every(item => item && typeof item === 'object' && (
        'reviewId' in item || 'reviewTimestamp' in item || 'reviewContentText' in item || 'reviewScore' in item ||
        ('submitId' in item && 'ratingSummary' in item)
      ))) {
        out.push(value);
        return out;
      }
      for (const item of value) reviewArraysIn(item, depth + 1, seen, out);
      return out;
    }
    if (typeof value !== 'object') return out;
    if (seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value?.data?.reviews)) {
      out.push(value.data.reviews);
      return out;
    }
    if (Array.isArray(value?.data?.userReviews?.content)) {
      out.push(value.data.userReviews.content);
      return out;
    }
    if (Array.isArray(value?.userReviews?.content)) {
      out.push(value.userReviews.content);
      return out;
    }
    if (Array.isArray(value?.reviews)) {
      out.push(value.reviews);
      return out;
    }
    for (const next of Object.values(value)) reviewArraysIn(next, depth + 1, seen, out);
    return out;
  }

  function reviewsIn(value) {
    return reviewArraysIn(value).flat();
  }

  function reviewCountIn(value) {
    return reviewsIn(value).length;
  }

  function reviewIdentity(review) {
    if (!review || typeof review !== 'object') return '';
    const direct = review.reviewId ?? review.submitId ?? review.writingid ?? review.writingId ?? review.id;
    if (direct != null && String(direct).trim()) return `id:${String(direct).trim()}`;
    const timestamp = String(review.reviewTimestamp ?? review.reviewDate ?? review.createdAt ?? review.postedAt ?? '').trim();
    const reviewer = String(review?.reviewer?.reviewerId ?? review?.reviewer?.reviewerName ?? review.reviewerName ?? review.customerName ?? '').trim();
    const ticketComment = Array.isArray(review.comments) ? review.comments.map(item => String(item?.value || '')).join('|') : '';
    const text = String(review.reviewOriginalText ?? review.reviewContentText ?? ticketComment).trim();
    const score = String(review.reviewScore ?? review.ratingSummary ?? '').trim();
    if (!timestamp && !reviewer && !text) return '';
    return `fallback:${simpleHash(`${timestamp}|${reviewer}|${score}|${text}`)}`;
  }

  function hasNextIn(value, depth = 0, seen = new WeakSet()) {
    if (value == null || depth > 10) return null;
    if (Array.isArray(value)) {
      let fallback = null;
      for (const item of value) {
        const result = hasNextIn(item, depth + 1, seen);
        if (result === true) return true;
        if (result === false) fallback = false;
      }
      return fallback;
    }
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (typeof value?.data?.hasNext === 'boolean') return value.data.hasNext;
    if (typeof value?.hasNext === 'boolean') return value.hasNext;
    if (typeof value?.data?.userReviews?.last === 'boolean') return !value.data.userReviews.last;
    if (typeof value?.userReviews?.last === 'boolean') return !value.userReviews.last;
    let fallback = null;
    for (const next of Object.values(value)) {
      const result = hasNextIn(next, depth + 1, seen);
      if (result === true) return true;
      if (result === false) fallback = false;
    }
    return fallback;
  }

  function simpleHash(text) {
    let h = 2166136261;
    const source = String(text || '');
    for (let i = 0; i < source.length; i += 1) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }


  function endpointLeaf(url) {
    try {
      const path = new URL(String(url || '')).pathname.split('/').filter(Boolean);
      return String(path[path.length - 1] || '');
    } catch { return ''; }
  }

  function isReviewDiagnosticRecord(record) {
    const leaf = endpointLeaf(record?.url || record?.request?.url || '');
    return (/^getReview/i.test(leaf) && leaf !== 'getReviews') || leaf === 'getAvailableReviewWithAggregate';
  }

  function isRelevantReviewEndpoint(record) {
    const leaf = endpointLeaf(record?.url || record?.request?.url || '');
    return leaf === 'getReviews' || isReviewDiagnosticRecord(record);
  }

  function countValueIn(value, depth = 0, seen = new WeakSet()) {
    if (value == null || depth > 8) return null;
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const candidates = [value?.data?.count, value?.count];
    for (const candidate of candidates) {
      if (candidate != null && String(candidate).trim() !== '') {
        const n = Number(candidate);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = countValueIn(child, depth + 1, seen);
        if (found != null) return found;
      }
    }
    return null;
  }

  function requestUrl(request) { return String(request?.request?.url || ''); }

  function matchesRequest(request, filter = 'getReviews', successOnly = true) {
    const url = requestUrl(request);
    const needle = String(filter || '').trim().toLowerCase();
    if (needle && !url.toLowerCase().includes(needle)) return false;
    const status = Number(request?.response?.status || 0);
    if (successOnly && (status < 200 || status >= 300)) return false;
    return true;
  }

  function requestContent(request) {
    return new Promise(resolve => {
      try {
        if (!request || typeof request.getContent !== 'function') return resolve({ content:'', encoding:'', error:'Response body tidak tersedia.' });
        request.getContent((content, encoding) => resolve({ content: content || '', encoding: encoding || '', error:'' }));
      } catch (error) {
        resolve({ content:'', encoding:'', error:String(error?.message || error) });
      }
    });
  }

  function parseFormBody(text) {
    const raw = String(text || '').trim();
    if (!raw || !raw.includes('=')) return null;
    try {
      const params = new URLSearchParams(raw);
      const result = {};
      for (const [key, value] of params.entries()) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
          if (!Array.isArray(result[key])) result[key] = [result[key]];
          result[key].push(value);
        } else result[key] = value;
      }
      return Object.keys(result).length ? result : null;
    } catch { return null; }
  }

  function requestPayload(request) {
    const req = request?.request || {};
    const url = String(req.url || '');
    const postData = req.postData && typeof req.postData === 'object' ? req.postData : null;
    const text = String(postData?.text || '');
    const parsedJson = text ? parseJsonBody(text) : null;
    const parsedForm = parsedJson == null ? parseFormBody(text) : null;
    const query = {};
    try {
      const parsedUrl = new URL(url);
      for (const [key, value] of parsedUrl.searchParams.entries()) {
        if (Object.prototype.hasOwnProperty.call(query, key)) {
          if (!Array.isArray(query[key])) query[key] = [query[key]];
          query[key].push(value);
        } else query[key] = value;
      }
    } catch {}
    return {
      mimeType: String(postData?.mimeType || ''),
      text,
      json: parsedJson,
      form: parsedForm,
      available: Boolean(text || postData),
      query
    };
  }

  async function requestRecord(request, { filter = 'getReviews', successOnly = true, fromScan = false } = {}) {
    if (!matchesRequest(request, filter, successOnly)) return { record:null, reason:'filter' };
    const url = requestUrl(request);
    const method = String(request?.request?.method || 'GET');
    const status = Number(request?.response?.status || 0);
    const startedDateTime = String(request?.startedDateTime || new Date().toISOString());
    const payload = requestPayload(request);
    const result = await requestContent(request);
    if (!result.content) return { record:null, reason:'empty-body', error:result.error || '' };
    if (result.content.length > MAX_RESPONSE_BYTES) return { record:null, reason:'too-large' };
    const decoded = decodeBody(result.content, result.encoding);
    const body = parseJsonBody(decoded);
    if (body == null) return { record:null, reason:'not-json' };
    const responseHash = simpleHash(decoded.slice(0, 2_000_000));
    const requestHash = simpleHash(payload.text.slice(0, 1_000_000));
    // Include request start time so two genuine identical HTTP requests are preserved,
    // while the same DevTools entry observed once live and once via HAR scan is deduped.
    const fingerprint = `${method}|${url}|${startedDateTime}|${requestHash}|${status}|${responseHash}|${decoded.length}`;
    return {
      record: {
        url,
        method,
        status,
        mimeType: String(request?.response?.content?.mimeType || request?.response?.headers?.find?.(h => String(h.name).toLowerCase() === 'content-type')?.value || ''),
        startedDateTime,
        capturedAt: new Date().toISOString(),
        reviewCount: reviewCountIn(body),
        hasNext: hasNextIn(body),
        fromScan: Boolean(fromScan),
        request: payload,
        requestBodyAvailable: payload.available,
        responseBytes: decoded.length,
        requestHash,
        responseHash,
        fingerprint,
        body
      },
      reason:''
    };
  }

  function getHar() {
    return new Promise((resolve, reject) => {
      try {
        chrome.devtools.network.getHAR(har => resolve(har || { entries:[] }));
      } catch (error) { reject(error); }
    });
  }

  async function scanCurrentHar({ filter = 'getReviews', successOnly = true } = {}) {
    const har = await getHar();
    const entries = Array.isArray(har?.entries) ? har.entries : [];
    const records = [];
    const seen = new Set();
    const skipped = { filter:0, 'empty-body':0, 'too-large':0, 'not-json':0, duplicate:0, error:0 };
    for (const entry of entries) {
      try {
        const result = await requestRecord(entry, { filter, successOnly, fromScan:true });
        if (!result.record) {
          const key = Object.prototype.hasOwnProperty.call(skipped, result.reason) ? result.reason : 'error';
          skipped[key] += 1;
          continue;
        }
        if (seen.has(result.record.fingerprint)) { skipped.duplicate += 1; continue; }
        seen.add(result.record.fingerprint);
        records.push(result.record);
      } catch { skipped.error += 1; }
    }
    return { records, skipped, totalEntries:entries.length };
  }

  global.MyDatasetCaptureCore = {
    MAX_RESPONSE_BYTES,
    decodeBody, parseJsonBody, reviewArraysIn, reviewsIn, reviewCountIn, reviewIdentity, hasNextIn, simpleHash,
    matchesRequest, requestContent, requestPayload, requestRecord, scanCurrentHar, endpointLeaf, isReviewDiagnosticRecord, isRelevantReviewEndpoint, countValueIn,
    PLATFORM_PROFILES, detectPlatform, profileForPlatform, profileForUrl
  };
})(globalThis);
