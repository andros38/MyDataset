'use strict';

// Runs in the embedded website's main world. It only observes review-shaped
// JSON responses already requested by the page and stores a bounded in-memory
// copy so DOM extraction can reuse source-native identifiers (for example
// Tiket submitId) without inventing IDs.
const REVIEW_CAPTURE_SCRIPT = `
(() => {
  if (window.__PETIKDATA_REVIEW_CAPTURE_READY__) return;
  Object.defineProperty(window, '__PETIKDATA_REVIEW_CAPTURE_READY__', { value: true, configurable: true });
  window.__PETIKDATA_CAPTURED_REVIEWS__ = Array.isArray(window.__PETIKDATA_CAPTURED_REVIEWS__) ? window.__PETIKDATA_CAPTURED_REVIEWS__ : [];
  window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__ = Array.isArray(window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__) ? window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__ : [];
  const MAX = 5000;
  const MAX_BATCHES = 40;
  const seen = new Set(window.__PETIKDATA_CAPTURED_REVIEWS__.map(item => String(item.__petikKey || item.reviewId || item.submitId || item.reviewTimestamp || item.reviewDate || JSON.stringify(item).slice(0, 120))));
  const looksReviewUrl = value => /(?:review|reviews|ulasan|comment|getReview|getReviews)/i.test(String(value || ''));
  const keyOf = item => String(item?.reviewId || item?.submitId || item?.writingid || item?.writingId || item?.commentId || item?.id || item?.reviewTimestamp || item?.reviewDate || item?.createdAt || item?.postedAt || item?.reviewContentText || item?.reviewOriginalText || '').slice(0, 320);
  const nativeIdOf = item => {
    if (!item || typeof item !== 'object') return '';
    for (const key of ['reviewId','review_id','submitId','submit_id','writingid','writingId','commentId','comment_id']) {
      const value = item[key];
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  };
  const pushReview = (item, url, batch = null) => {
    if (!item || typeof item !== 'object') return null;
    const hasReviewShape = ['reviewId','review_id','submitId','submit_id','writingid','writingId','commentId','comment_id','reviewTimestamp','reviewDate','reviewContentText','reviewOriginalText','reviewerName','customerName','reviewScore','ratingSummary'].some(key => item[key] != null)
      || (item.reviewer && typeof item.reviewer === 'object')
      || (typeof item.content === 'string' && /review|ulasan|comment/i.test(url || ''));
    if (!hasReviewShape) return null;
    const record = { ...item, __petikSourceUrl: String(url || ''), __petikCapturedAt: Date.now() };
    record.__petikKey = keyOf(record) || JSON.stringify(record).slice(0, 320);
    const nativeId = nativeIdOf(record);
    if (batch && nativeId && !batch.seen.has(nativeId)) {
      batch.seen.add(nativeId);
      batch.reviews.push(record);
    }
    if (!record.__petikKey || seen.has(record.__petikKey)) return record;
    seen.add(record.__petikKey);
    window.__PETIKDATA_CAPTURED_REVIEWS__.push(record);
    if (window.__PETIKDATA_CAPTURED_REVIEWS__.length > MAX) {
      window.__PETIKDATA_CAPTURED_REVIEWS__.splice(0, window.__PETIKDATA_CAPTURED_REVIEWS__.length - MAX);
    }
    return record;
  };
  const walk = (value, url, depth = 0, batch = null) => {
    if (value == null || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 600)) walk(item, url, depth + 1, batch);
      return;
    }
    if (typeof value !== 'object') return;
    pushReview(value, url, batch);
    for (const next of Object.values(value)) {
      if (next && (Array.isArray(next) || typeof next === 'object')) walk(next, url, depth + 1, batch);
    }
  };
  const captureText = (url, text) => {
    if (!looksReviewUrl(url) && !/(?:reviewId|submitId|reviewTimestamp|reviewDate|reviewContentText|reviewOriginalText|writingid|writingId|ratingSummary|customerName)/i.test(String(text || '').slice(0, 250000))) return;
    try {
      const parsed = JSON.parse(text);
      const batch = { url: String(url || ''), capturedAt: Date.now(), reviews: [], seen: new Set() };
      walk(parsed, url, 0, batch);
      if (batch.reviews.length) {
        window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__.push({
          url: batch.url,
          capturedAt: batch.capturedAt,
          reviewIds: batch.reviews.map(nativeIdOf).filter(Boolean),
          reviews: batch.reviews.slice(0, 250)
        });
        if (window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__.length > MAX_BATCHES) {
          window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__.splice(0, window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__.length - MAX_BATCHES);
        }
      }
    } catch {}
  };
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function petikDataFetch(...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0] || response?.url || '');
        const contentType = String(response?.headers?.get?.('content-type') || '');
        if (looksReviewUrl(url) || /json/i.test(contentType)) response.clone().text().then(text => captureText(url, text)).catch(() => {});
      } catch {}
      return response;
    };
  }
  const NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    const originalOpen = NativeXHR.prototype.open;
    const originalSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function petikDataOpen(method, url, ...rest) {
      this.__petikDataUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };
    NativeXHR.prototype.send = function petikDataSend(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            if (typeof this.responseText === 'string' && this.responseText) {
              captureText(this.__petikDataUrl, this.responseText);
              return;
            }
          } catch {}
          try {
            const payload = this.response;
            if (typeof payload === 'string') captureText(this.__petikDataUrl, payload);
            else if (payload && typeof payload === 'object') {
              let preview = '';
              try { preview = JSON.stringify(payload).slice(0, 250000); } catch {}
              if (looksReviewUrl(this.__petikDataUrl) || /(?:reviewId|submitId|reviewTimestamp|reviewDate|reviewContentText|reviewOriginalText|writingid|writingId|ratingSummary|customerName)/i.test(preview)) walk(payload, this.__petikDataUrl, 0);
            }
          } catch {}
        });
      } catch {}
      return originalSend.apply(this, args);
    };
  }
})();
`;

module.exports = { REVIEW_CAPTURE_SCRIPT };
