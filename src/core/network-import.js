const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeDateValue, formatScrapedAt, sanitizeExportRow } = require('./normalizers');
const { resolveSourceContext, isHttpSourceUrl, sourceUrlMatchesSite } = require('./source-context');

function naturalCompare(a, b) {
  return new Intl.Collator('id', { numeric: true, sensitivity: 'base' }).compare(String(a || ''), String(b || ''));
}

function parseJsonStream(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const values = [];
  let index = 0;
  const skipWhitespace = () => { while (index < source.length && /\s/.test(source[index])) index += 1; };
  while (index < source.length) {
    skipWhitespace();
    if (index >= source.length) break;
    const start = index;
    const opener = source[index];
    if (opener !== '{' && opener !== '[') throw new Error(`JSON tidak valid di karakter ${index + 1}; objek/array diharapkan.`);
    const closer = opener === '{' ? '}' : ']';
    let depth = 0; let inString = false; let escaped = false; let end = -1;
    for (; index < source.length; index += 1) {
      const ch = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) { end = index + 1; break; }
      }
    }
    if (end < 0) throw new Error('JSON terpotong: penutup objek/array tidak ditemukan.');
    const chunk = source.slice(start, end);
    try { values.push(JSON.parse(chunk)); }
    catch (error) { throw new Error(`JSON tidak dapat dibaca: ${error.message}`); }
    index = end;
  }
  return values;
}

function responseCandidates(value) {
  if (Array.isArray(value)) {
    if (value.every(item => item && typeof item === 'object' && (Array.isArray(item?.data?.reviews) || Array.isArray(item?.data?.userReviews?.content)))) return value;
    if (value.every(item => item && typeof item === 'object' && ('reviewId' in item || 'reviewTimestamp' in item))) {
      return [{ data: { status: 'SUCCESS', hasNext: false, reviews: value } }];
    }
    return value.flatMap(responseCandidates);
  }
  if (!value || typeof value !== 'object') return [];
  if (value._mydataset_capture && Array.isArray(value.responses)) return value.responses.flatMap(responseCandidates);
  if (Array.isArray(value?.data?.reviews) || Array.isArray(value?.data?.userReviews?.content)) return [value];
  if (Array.isArray(value?.reviews)) return [{ data: { status: value.status || 'SUCCESS', hasNext: value.hasNext, reviews: value.reviews } }];
  return [];
}

function captureMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = value._mydataset_capture;
  if (!meta || typeof meta !== 'object') return null;
  const datasetMetadata = meta.datasetMetadata && typeof meta.datasetMetadata === 'object' && !Array.isArray(meta.datasetMetadata)
    ? JSON.parse(JSON.stringify(meta.datasetMetadata)) : null;
  return {
    schemaVersion: Number(meta.schemaVersion || 1),
    extensionVersion: String(meta.extensionVersion || ''),
    capturedAt: String(meta.capturedAt || ''),
    sourceUrl: String(meta.sourceUrl || ''),
    pageTitle: String(meta.pageTitle || ''),
    platform: String(meta.platform || ''),
    filter: String(meta.filter || ''),
    responseCount: Number(meta.responseCount || 0),
    reviewCount: Number(meta.reviewCount || 0),
    rawReviewCount: Number(meta.rawReviewCount ?? meta.reviewCount ?? 0),
    uniqueReviewCount: Number(meta.uniqueReviewCount ?? meta.reviewCount ?? 0),
    duplicateReviewCount: Number(meta.duplicateReviewCount || 0),
    lastHasNext: typeof meta.lastHasNext === 'boolean' ? meta.lastHasNext : null,
    endpointPaginationComplete: typeof meta.endpointPaginationComplete === 'boolean' ? meta.endpointPaginationComplete : null,
    captureComplete: typeof meta.captureComplete === 'boolean' ? meta.captureComplete : null,
    apiReportedReviewCount: meta.apiReportedReviewCount == null ? null : Number(meta.apiReportedReviewCount),
    apiCountDifference: meta.apiCountDifference == null ? null : Number(meta.apiCountDifference),
    apiCountMatches: typeof meta.apiCountMatches === 'boolean' ? meta.apiCountMatches : null,
    skipCoverageComplete: typeof meta.skipCoverageComplete === 'boolean' ? meta.skipCoverageComplete : null,
    aggregateTotal: meta.aggregateTotal == null ? null : Number(meta.aggregateTotal),
    aggregateTraveloka: meta.aggregateTraveloka == null ? null : Number(meta.aggregateTraveloka),
    aggregateOther: meta.aggregateOther == null ? null : Number(meta.aggregateOther),
    datasetMetadata
  };
}

function finiteCount(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function endpointLeaf(url) {
  try {
    const pieces = new URL(String(url || '')).pathname.split('/').filter(Boolean);
    return String(pieces[pieces.length - 1] || '');
  } catch { return ''; }
}

function parseJsonBody(value) {
  if (value == null || typeof value === 'object') return value && typeof value === 'object' ? value : null;
  const text = String(value || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function decodeHarContent(content = {}) {
  const text = String(content?.text || '');
  if (!text) return '';
  if (String(content?.encoding || '').toLowerCase() === 'base64') {
    try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
  }
  return text;
}

function harObject(value) {
  if (Array.isArray(value?.log?.entries)) return value;
  if (Array.isArray(value?.entries)) return { log: { entries: value.entries, pages: value.pages || [] } };
  return null;
}

function harHeaderValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  const found = (Array.isArray(headers) ? headers : []).find(item => String(item?.name || '').toLowerCase() === wanted);
  return String(found?.value || '');
}

function harRequestData(entry) {
  const text = String(entry?.request?.postData?.text || '').trim();
  const parsed = parseJsonBody(text);
  if (!parsed || typeof parsed !== 'object') return {};
  const data = parsed.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : parsed;
}

function harResponseBody(entry) {
  const status = Number(entry?.response?.status || 0);
  if (status && (status < 200 || status >= 300)) return null;
  const text = decodeHarContent(entry?.response?.content || {});
  return parseJsonBody(text);
}

function travelokaIdentityFromUrl(value) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { return { sourceUrl: '', objectId: '', entityType: '', objectName: '' }; }
  if (!/(^|\.)traveloka\.com$/i.test(parsed.hostname)) return { sourceUrl: '', objectId: '', entityType: '', objectName: '' };
  const spec = parsed.searchParams.get('spec') || '';
  let objectId = '';
  let entityType = '';
  if (spec) {
    const parts = String(spec).split('.').filter(Boolean);
    const index = parts.findIndex(part => /^(?:HOTEL|XPERIENCE|FLIGHT|RESTAURANT)$/i.test(String(part)));
    if (index >= 0) {
      entityType = String(parts[index] || '').toUpperCase();
      objectId = String(parts[index + 1] || '').trim();
    }
  }
  const source = resolveSourceContext({ url: raw });
  return { sourceUrl: raw, objectId, entityType, objectName: String(source.objectName || '').trim() };
}

function candidateIdFor(key) {
  return `traveloka_${crypto.createHash('sha1').update(String(key || 'source')).digest('hex').slice(0, 12)}`;
}

function stableComparable(value) {
  if (Array.isArray(value)) return value.map(stableComparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableComparable(value[key])]));
}

function requestFilterSignature(data = {}) {
  const filter = data?.filter && typeof data.filter === 'object' ? data.filter : {};
  return JSON.stringify(stableComparable(filter));
}

function requestConfigSignature(data = {}) {
  return JSON.stringify(stableComparable({
    configId: data?.configId ?? null,
    productType: data?.productType ?? null,
    origin: data?.origin ?? null,
    sort: data?.sort ?? null,
    limit: data?.limit == null ? null : String(data.limit),
    filter: data?.filter && typeof data.filter === 'object' ? data.filter : {}
  }));
}

function isReviewDiagnosticEndpoint(leaf) {
  return (/^getReview/i.test(String(leaf || '')) && leaf !== 'getReviews') || leaf === 'getAvailableReviewWithAggregate';
}

function pageMapFromHar(har) {
  const map = new Map();
  const pages = Array.isArray(har?.log?.pages) ? har.log.pages : [];
  pages.forEach(page => map.set(String(page?.id || ''), String(page?.title || '')));
  return map;
}

function sourceUrlForHarEntry(entry, pageMap) {
  const pageUrl = String(pageMap.get(String(entry?.pageref || '')) || '');
  if (isHttpSourceUrl(pageUrl) && sourceUrlMatchesSite(pageUrl, 'traveloka')) return pageUrl;
  const referer = harHeaderValue(entry?.request?.headers, 'referer');
  if (isHttpSourceUrl(referer) && sourceUrlMatchesSite(referer, 'traveloka')) return referer;
  return '';
}

function reviewIdentity(review, fallbackIndex = 0) {
  const id = String(review?.reviewId ?? '').trim();
  if (id) return `id:${id}`;
  const raw = `${review?.reviewTimestamp ?? ''}|${review?.reviewer?.reviewerId ?? review?.reviewer?.reviewerName ?? ''}|${review?.reviewScore ?? ''}|${review?.reviewOriginalText ?? review?.reviewContentText ?? ''}|${fallbackIndex}`;
  return `fallback:${crypto.createHash('sha1').update(raw).digest('hex')}`;
}

function reviewPopulationStats(responses = []) {
  const seen = new Set();
  let raw = 0; let unique = 0; let duplicateIds = 0; let withText = 0; let withoutText = 0;
  for (const response of responses) {
    const reviews = Array.isArray(response?.data?.reviews) ? response.data.reviews.filter(isTravelokaReview) : [];
    raw += reviews.length;
    reviews.forEach((review, index) => {
      const key = reviewIdentity(review, index);
      if (seen.has(key)) { duplicateIds += 1; return; }
      seen.add(key); unique += 1;
      const text = String(review?.reviewContentText ?? review?.reviewOriginalText ?? '').trim();
      if (text) withText += 1; else withoutText += 1;
    });
  }
  return { raw, unique, duplicateIds, withText, withoutText };
}

function coverageFromHarRecords(records = []) {
  const pages = records.map((record, index) => {
    const data = record.requestData || {};
    const skip = Number(data.skip);
    const limit = Number(data.limit);
    return {
      sequence: index + 1,
      skip: Number.isFinite(skip) ? skip : null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
      returned: Array.isArray(record?.body?.data?.reviews) ? record.body.data.reviews.length : 0,
      hasNext: typeof record?.body?.data?.hasNext === 'boolean' ? record.body.data.hasNext : null,
      entryIndex: Number(record.entryIndex || index)
    };
  }).filter(item => item.skip != null && item.limit != null);
  if (!pages.length) return { available: false, contiguous: null, firstSkip: null, lastSkip: null, nominalLimit: null, requestCount: records.length, duplicateSkipCount: null, missingSkips: [], lastHasNext: null };
  const ordered = [...pages].sort((a, b) => a.skip - b.skip || a.entryIndex - b.entryIndex);
  const uniqueSkips = [...new Set(ordered.map(item => item.skip))].sort((a, b) => a - b);
  const nominalLimit = ordered[0].limit;
  const missingSkips = [];
  // getReviews pagination is zero-based. Include a missing leading offset in the
  // coverage audit instead of checking only gaps between the first/last observed request.
  for (let expected = 0; expected <= uniqueSkips[uniqueSkips.length - 1]; expected += nominalLimit) {
    if (!uniqueSkips.includes(expected)) missingSkips.push(expected);
    if (missingSkips.length >= 500) break;
  }
  const terminalCandidates = ordered.filter(item => item.skip === uniqueSkips[uniqueSkips.length - 1]);
  const terminal = terminalCandidates[terminalCandidates.length - 1] || ordered[ordered.length - 1];
  const firstData = records.find(record => record?.requestData && typeof record.requestData === 'object')?.requestData || {};
  return {
    available: true,
    contiguous: missingSkips.length === 0,
    firstSkip: uniqueSkips[0],
    lastSkip: uniqueSkips[uniqueSkips.length - 1],
    nominalLimit,
    requestCount: ordered.length,
    duplicateSkipCount: ordered.length - uniqueSkips.length,
    missingSkips,
    lastHasNext: terminal?.hasNext ?? null,
    objectId: firstData.objectId ?? null,
    configId: firstData.configId ?? null,
    origin: firstData.origin ?? null,
    sort: firstData.sort ?? null,
    filter: firstData.filter && typeof firstData.filter === 'object' ? { ...firstData.filter } : {}
  };
}

function countValueIn(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  for (const candidate of [value?.data?.count, value?.count]) {
    const count = finiteCount(candidate);
    if (count != null) return count;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = countValueIn(child, depth + 1, seen);
      if (found != null) return found;
    }
  }
  return null;
}

function diagnosticSummary(records = []) {
  const endpoints = {};
  let reportedCount = null;
  let requestFilter = null;
  let requestOrigin = null;
  let countRequests = 0;
  let aggregateTotal = null;
  let aggregateTraveloka = null;
  let aggregateOther = null;
  let aggregateOtherProvider = '';
  let entity = '';
  let availableAggregate = false;
  let summaryAggregate = false;
  for (const record of records) {
    const leaf = endpointLeaf(record?.entry?.request?.url || '');
    if (!leaf) continue;
    endpoints[leaf] = (endpoints[leaf] || 0) + 1;
    const body = record.body;
    const data = record.requestData || {};
    if (leaf === 'getReviewCount') {
      countRequests += 1;
      const count = countValueIn(body);
      if (count != null) reportedCount = count;
      if (data.filter && typeof data.filter === 'object') requestFilter = { ...data.filter };
      if (data.origin != null && String(data.origin).trim()) requestOrigin = String(data.origin);
    }
    if (leaf === 'getAvailableReviewWithAggregate') {
      const response = body?.data || {};
      const traveloka = response?.traveloka || {};
      const other = response?.other || {};
      const tv = finiteCount(traveloka?.count); const oth = finiteCount(other?.count);
      if (tv != null) aggregateTraveloka = tv;
      if (oth != null) aggregateOther = oth;
      if (traveloka?.objectName) entity = String(traveloka.objectName);
      else if (other?.objectName) entity = String(other.objectName);
      if (other?.provider) aggregateOtherProvider = String(other.provider);
      availableAggregate = true;
    }
    if (leaf === 'getReviewAggregateSummary') {
      const aggregate = body?.data?.reviewAggregate || {};
      const direct = finiteCount(aggregate?.count);
      if (direct != null) aggregateTotal = direct;
      if (aggregate?.objectName) entity = String(aggregate.objectName);
      summaryAggregate = true;
    }
  }
  const sum = aggregateTraveloka != null && aggregateOther != null ? aggregateTraveloka + aggregateOther : null;
  if (aggregateTotal == null && sum != null) aggregateTotal = sum;
  return {
    endpoints,
    count: { reportedCount, requestFilter, requestOrigin, requestCount: countRequests },
    aggregate: {
      aggregateTotal, aggregateTraveloka, aggregateOther, aggregateOtherProvider, entity,
      consistent: aggregateTotal == null || sum == null ? null : aggregateTotal === sum,
      evidence: { availableReviewWithAggregate: availableAggregate, reviewAggregateSummary: summaryAggregate }
    }
  };
}

function buildHarDatasetMetadata(candidate, population, coverage, diagnostics, sourceContext) {
  const reported = diagnostics?.count?.reportedCount == null ? null : Number(diagnostics.count.reportedCount);
  const format = coverage?.filter?.format || diagnostics?.count?.requestFilter?.format || '';
  const difference = reported == null ? null : reported - Number(population.unique || 0);
  const observedComplete = coverage.lastHasNext === false && coverage.contiguous !== false;
  const aggregate = diagnostics.aggregate || {};
  return {
    schemaVersion: 2,
    platform: 'Traveloka',
    source_format: 'HAR',
    entity: String(aggregate.entity || sourceContext.objectName || candidate.objectName || '').trim(),
    entity_type: String(candidate.entityType || 'HOTEL'),
    entity_id: String(candidate.objectId || ''),
    page_title: String(candidate.pageTitle || sourceContext.objectName || ''),
    source_url: String(sourceContext.sourceUrl || candidate.sourceUrl || ''),
    source_entity_url: String(sourceContext.sourceEntityUrl || ''),
    source_review_url: String(sourceContext.sourceReviewUrl || ''),
    source_url_canonical: String(sourceContext.canonicalUrl || sourceContext.sourceEntityUrl || sourceContext.sourceUrl || candidate.sourceUrl || ''),
    aggregate_total: aggregate.aggregateTotal ?? null,
    aggregate_traveloka: aggregate.aggregateTraveloka ?? null,
    aggregate_other: aggregate.aggregateOther ?? null,
    aggregate_other_provider: String(aggregate.aggregateOtherProvider || ''),
    aggregate_consistent: aggregate.consistent ?? null,
    filter: coverage?.filter && typeof coverage.filter === 'object' ? { ...coverage.filter } : (diagnostics?.count?.requestFilter || {}),
    listing_origin: coverage?.origin ?? null,
    count_request_origin: diagnostics?.count?.requestOrigin ?? null,
    api_reported_count: reported,
    api_reported_text_count: format === 'FORMAT_VALUE_TEXT' ? reported : null,
    retrieved_records: Number(population.raw || 0),
    unique_records: Number(population.unique || 0),
    text_records: Number(population.withText || 0),
    empty_text_records: Number(population.withoutText || 0),
    source_duplicate_review_ids: Number(population.duplicateIds || 0),
    format_distribution: {
      requested_format: String(format || ''),
      all_unique_records: Number(population.unique || 0),
      with_text: Number(population.withText || 0),
      without_text: Number(population.withoutText || 0)
    },
    pagination: {
      first_skip: coverage.firstSkip ?? null,
      last_skip: coverage.lastSkip ?? null,
      limit: coverage.nominalLimit ?? null,
      request_count: coverage.requestCount ?? candidate.reviewRecords.length,
      missing_offsets: Array.isArray(coverage.missingSkips) ? coverage.missingSkips.length : null,
      missing_skip_values: Array.isArray(coverage.missingSkips) ? [...coverage.missingSkips] : [],
      duplicate_offsets: coverage.duplicateSkipCount ?? null,
      last_has_next: coverage.lastHasNext ?? null,
      complete: observedComplete
    },
    count_discrepancy: {
      reported_vs_retrieved: difference,
      comparison_basis: 'source_unique_ids',
      cause: difference == null ? 'getReviewCount not captured' : (difference === 0 ? 'no discrepancy observed' : 'not established by public API response')
    },
    coverage_claim: observedComplete ? 'complete_observed_getReviews_pagination' : (coverage.lastHasNext === true ? 'incomplete_observed_getReviews_pagination' : 'terminal_state_not_fully_verified'),
    population_complete_claim: false,
    evidence: {
      imported_by_application: 'MyDataset',
      acquisition_source: 'chrome-har',
      getReviews_response_count: Number(candidate.reviewRecords.length || 0),
      diagnostic_endpoint_counts: { ...(diagnostics.endpoints || {}) },
      aggregate_sources: { ...(aggregate.evidence || {}) },
      count_endpoint_requests: Number(diagnostics?.count?.requestCount || 0),
      skip_coverage_available: Boolean(coverage.available),
      har_pagerefs: [...candidate.pagerefs]
    }
  };
}

function inspectTravelokaHarLoadedFiles(loadedFiles, options = {}) {
  const candidates = new Map();
  const diagnosticsPending = [];
  for (const loaded of loadedFiles.filter(item => item.sourceFormat === 'har')) {
    const har = loaded.har;
    const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
    const pages = pageMapFromHar(har);
    entries.forEach((entry, entryIndex) => {
      const leaf = endpointLeaf(entry?.request?.url || '');
      if (leaf !== 'getReviews' && !isReviewDiagnosticEndpoint(leaf)) return;
      const status = Number(entry?.response?.status || 0);
      if (status && (status < 200 || status >= 300)) return;
      const body = harResponseBody(entry);
      if (!body) return;
      const requestData = harRequestData(entry);
      const sourceUrl = sourceUrlForHarEntry(entry, pages);
      const urlIdentity = travelokaIdentityFromUrl(sourceUrl);
      const objectId = String(requestData.objectId ?? urlIdentity.objectId ?? '').trim();
      const entityType = String(requestData.productType ?? urlIdentity.entityType ?? 'HOTEL').trim().toUpperCase();
      const pageref = String(entry?.pageref || '');
      const filterSignature = requestFilterSignature(requestData);
      const configSignature = requestConfigSignature(requestData);
      // Satu HAR dapat memuat hotel yang sama dengan filter berbeda (misalnya
      // FORMAT_VALUE_TEXT lalu FORMAT_VALUE_ALL). Jangan gabungkan pagination
      // tersebut hanya karena objectId sama; perlakukan konfigurasi listing
      // sebagai kandidat sumber yang berbeda agar provenance tidak tercampur.
      const sourceKey = objectId || `${loaded.filePath}|${pageref || sourceUrl || 'unknown'}`;
      const logicalKey = leaf === 'getReviews' ? `${sourceKey}|${configSignature}` : sourceKey;
      const id = candidateIdFor(logicalKey);
      const record = { entry, entryIndex, body, requestData, sourceUrl, objectId, entityType, pageref, filterSignature, configSignature, loaded };
      if (leaf === 'getReviews') {
        const reviews = Array.isArray(body?.data?.reviews) ? body.data.reviews : [];
        if (!reviews.length && typeof body?.data?.hasNext !== 'boolean') return;
        if (!candidates.has(id)) {
          candidates.set(id, {
            id, logicalKey, objectId, entityType, sourceUrl, objectName: urlIdentity.objectName,
            filterSignature, configSignature, requestConfig: { ...requestData },
            pageTitle: sourceUrl, pagerefs: new Set(), reviewRecords: [], diagnosticRecords: [], files: new Set()
          });
        }
        const candidate = candidates.get(id);
        candidate.objectId = candidate.objectId || objectId;
        candidate.entityType = candidate.entityType || entityType;
        candidate.sourceUrl = candidate.sourceUrl || sourceUrl;
        candidate.objectName = candidate.objectName || urlIdentity.objectName;
        candidate.pageTitle = candidate.pageTitle || sourceUrl;
        if (pageref) candidate.pagerefs.add(pageref);
        candidate.reviewRecords.push(record);
        candidate.files.add(loaded.filePath);
      } else {
        diagnosticsPending.push({ id, objectId, pageref, sourceUrl, record });
      }
    });
  }
  if (!candidates.size) throw new Error('HAR tidak berisi response Traveloka getReviews dengan response body yang dapat dibaca. Ekspor HAR harus menyertakan content/response body.');

  for (const pending of diagnosticsPending) {
    const leaf = endpointLeaf(pending.record?.entry?.request?.url || '');
    const pool = [...candidates.values()].filter(item =>
      (!pending.objectId || item.objectId === pending.objectId) &&
      (!pending.pageref || item.pagerefs.has(pending.pageref) || item.objectId === pending.objectId)
    );
    if (leaf === 'getReviewCount') {
      const sig = requestFilterSignature(pending.record?.requestData || {});
      const exact = pool.find(item => item.filterSignature === sig);
      const target = exact || (pool.length === 1 ? pool[0] : null);
      if (target) target.diagnosticRecords.push(pending.record);
      continue;
    }
    // Aggregate/filter metadata describes the object rather than one page of
    // listing. Attach it to all matching filter candidates of the same object.
    const targets = pool.length ? pool : (candidates.size === 1 ? [...candidates.values()] : []);
    targets.forEach(target => target.diagnosticRecords.push(pending.record));
  }

  const summaries = [...candidates.values()].map(candidate => {
    const responses = candidate.reviewRecords.map(record => record.body);
    const population = reviewPopulationStats(responses);
    const coverage = coverageFromHarRecords(candidate.reviewRecords);
    const diagnostics = diagnosticSummary(candidate.diagnosticRecords);
    const diagnosticName = String(diagnostics?.aggregate?.entity || '').trim();
    const source = resolveSourceContext({
      url: candidate.sourceUrl,
      title: diagnosticName || candidate.objectName || '',
      preferredObjectName: diagnosticName || candidate.objectName || ''
    });
    const objectName = diagnosticName || source.objectName || candidate.objectName || (candidate.objectId ? `Traveloka ${candidate.entityType || 'objek'} ${candidate.objectId}` : 'Traveloka');
    const sourceUrl = isHttpSourceUrl(source.sourceUrl) && sourceUrlMatchesSite(source.sourceUrl, 'traveloka') ? source.sourceUrl : candidate.sourceUrl;
    const sourceContext = {
      objectName,
      siteName: 'Traveloka',
      sourceUrl,
      canonicalUrl: source.canonicalUrl || sourceUrl,
      objectId: String(candidate.objectId || ''),
      entityType: String(candidate.entityType || 'HOTEL'),
      detectedBy: 'har-network'
    };
    const datasetMetadata = buildHarDatasetMetadata(candidate, population, coverage, diagnostics, sourceContext);
    return { candidate, population, coverage, diagnostics, sourceContext, datasetMetadata };
  }).sort((a, b) => b.population.unique - a.population.unique || naturalCompare(a.sourceContext.objectName, b.sourceContext.objectName));

  const requested = String(options.sourceSelection || '').trim();
  const selected = summaries.find(item => item.candidate.id === requested || item.candidate.objectId === requested) || summaries[0];
  return { summaries, selected };
}


function queryObjectFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return Object.fromEntries([...parsed.searchParams.entries()]);
  } catch { return {}; }
}

function tiketIdentityFromUrl(value) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { return { sourceUrl: '', objectId: '', entityType: '', objectName: '' }; }
  if (!/(^|\.)tiket\.com$/i.test(parsed.hostname)) return { sourceUrl: '', objectId: '', entityType: '', objectName: '' };
  const query = queryObjectFromUrl(raw);
  let objectId = String(query.inventoryId || query.inventory_id || '').trim();
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!objectId) {
    const segment = [...segments].reverse().find(part => /-\d{12,}$/i.test(String(part || '')));
    if (segment) objectId = String(segment);
  }
  const productType = String(query.productType || query.product_type || '').toUpperCase();
  const entityType = productType === 'TIXHOTEL' || /\/hotel\//i.test(parsed.pathname) ? 'HOTEL' : productType.replace(/^TIX/, '') || '';
  const source = resolveSourceContext({ url: raw });
  let objectName = String(source.objectName || '').trim();
  if (/^Mregency\b/i.test(objectName)) objectName = objectName.replace(/^Mregency\b/i, 'M-Regency');
  return { sourceUrl: raw, objectId, entityType, objectName };
}

function canonicalTiketHotelUrl(value) {
  const raw = String(value || '').trim();
  try {
    const parsed = new URL(raw);
    if (!/(^|\.)tiket\.com$/i.test(parsed.hostname)) return raw;
    parsed.hash = '';
    if (/\/hotel\//i.test(parsed.pathname)) parsed.search = '';
    return parsed.toString();
  } catch { return raw; }
}

function tiketReviewData(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const userReviews = data?.userReviews && typeof data.userReviews === 'object' ? data.userReviews : {};
  return { data, userReviews, reviews: Array.isArray(userReviews.content) ? userReviews.content : [] };
}

function isTiketReview(review) {
  if (!review || typeof review !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(review, 'submitId') && Object.prototype.hasOwnProperty.call(review, 'ratingSummary');
}

function tiketReviewIdentity(review, fallbackIndex = 0) {
  const id = String(review?.submitId ?? '').trim();
  if (id) return `id:${id}`;
  const comment = (Array.isArray(review?.comments) ? review.comments : []).map(item => String(item?.value || '')).join('|');
  const raw = `${review?.reviewDate ?? ''}|${review?.customerName ?? ''}|${review?.ratingSummary ?? ''}|${comment}|${fallbackIndex}`;
  return `fallback:${crypto.createHash('sha1').update(raw).digest('hex')}`;
}

function tiketCommentText(review) {
  const comments = Array.isArray(review?.comments) ? review.comments : [];
  const preferred = comments.filter(item => String(item?.questionCode || '').toLowerCase() === 'comment');
  const source = preferred.length ? preferred : comments;
  return source.map(item => String(item?.value ?? '').trim()).filter(Boolean).join('\n').trim();
}

function tiketMediaUrls(review) {
  const groups = Array.isArray(review?.userImages) ? review.userImages : [];
  return groups.flatMap(group => Array.isArray(group?.value) ? group.value : []).map(String).filter(Boolean);
}

function tiketSubratings(review) {
  const answers = Array.isArray(review?.userReviewAnswers) ? review.userReviewAnswers : [];
  const out = {};
  answers.forEach(answer => {
    if (String(answer?.questionType || '').toUpperCase() !== 'RATING') return;
    const code = String(answer?.questionCode || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (!code) return;
    out[`subrating_${code}`] = answer?.answerInteger == null ? '' : String(answer.answerInteger);
    out[`subrating_${code}_label`] = String(answer?.answerString || '');
  });
  return out;
}

function flattenTiketReview(review, context = {}) {
  const timestamp = epochDateTime(review.reviewDate);
  const start = epochDateTime(review.startJourney);
  const end = epochDateTime(review.endJourney);
  const media = tiketMediaUrls(review);
  const source = review?.reviewSource && typeof review.reviewSource === 'object' ? review.reviewSource : {};
  const scrapedAt = context.capturedAt || context.importedAt || new Date();
  return sanitizeExportRow({
    review_id: String(review.submitId ?? ''),
    review_subject: String(context.objectName || ''),
    review_text: tiketCommentText(review),
    review_date: timestamp.date,
    review_datetime: timestamp.datetime,
    review_datetime_utc: timestamp.utc,
    review_timestamp: String(review.reviewDate ?? ''),
    rating_score: review.ratingSummary == null || !Number.isFinite(Number(review.ratingSummary)) ? '' : Number(review.ratingSummary),
    rating_max: 5,
    reviewer_name: String(review.customerName ?? ''),
    travel_type: String(review.label ?? ''),
    reaction_count: review.totalLike == null ? '' : String(review.totalLike),
    media_count: media.length,
    media_urls: media.join(' | '),
    stay_start_date: start.date,
    stay_end_date: end.date,
    fake_flag: review.fake == null ? '' : String(Boolean(review.fake)),
    reported_flag: review.reported == null ? '' : String(Boolean(review.reported)),
    liked_by_me: review.likedByMe == null ? '' : String(Boolean(review.likedByMe)),
    review_source_name: String(source.name || 'TIKET'),
    review_source_label: String(source.label || ''),
    source_site: 'TIKET',
    product_type: String(context.entityType || 'HOTEL'),
    ...tiketSubratings(review),
    _page: Number(context.page ?? 0) + 1,
    _sourceType: context.sourceType || 'har-network',
    _sourceAdapter: 'tiket-internalReview',
    _sourceFile: context.sourceFile || '',
    _sourceResponseIndex: context.responseIndex || 1,
    ...(context.objectName ? { _objectName: context.objectName } : {}),
    _sourceUrl: context.sourceUrl || '',
    _capturedAt: formatScrapedAt(scrapedAt),
    _scrapedAt: formatScrapedAt(scrapedAt)
  });
}

function tiketConfigFromEntry(entry) {
  const query = queryObjectFromUrl(entry?.request?.url || '');
  const config = { ...query };
  delete config.page;
  // Tiket dapat memanggil halaman awal dengan `topic=` lalu pagination memakai
  // `subTopic=all`. Keduanya merepresentasikan konfigurasi "semua" yang sama;
  // normalisasi ini mencegah halaman 0 muncul sebagai kandidat sumber terpisah.
  if (Object.prototype.hasOwnProperty.call(config, 'topic') && String(config.topic || '').trim() === '') delete config.topic;
  if (!String(config.subTopic || '').trim()) config.subTopic = 'all';
  return config;
}

function tiketConfigSignature(entry) {
  return JSON.stringify(stableComparable(tiketConfigFromEntry(entry)));
}

function tiketSourceUrlsForInventory(loaded, inventoryId, pageMap) {
  const candidates = [];
  const entries = Array.isArray(loaded?.har?.log?.entries) ? loaded.har.log.entries : [];
  const add = (value, priority) => {
    const raw = String(value || '').trim();
    if (!isHttpSourceUrl(raw) || !sourceUrlMatchesSite(raw, 'tiket')) return;
    if (inventoryId && !raw.toLowerCase().includes(String(inventoryId).toLowerCase())) return;
    candidates.push({ raw, priority });
  };
  entries.forEach(entry => {
    const reqUrl = String(entry?.request?.url || '');
    const referer = harHeaderValue(entry?.request?.headers, 'referer');
    add(referer, /\/hotel\//i.test(referer) ? 100 : (/\/review/i.test(referer) ? 40 : 20));
    add(reqUrl, /\/hotel\//i.test(reqUrl) ? 90 : (/\/review/i.test(reqUrl) ? 35 : 10));
    const pageUrl = String(pageMap.get(String(entry?.pageref || '')) || '');
    add(pageUrl, /\/hotel\//i.test(pageUrl) ? 80 : (/\/review/i.test(pageUrl) ? 30 : 5));
  });
  candidates.sort((a, b) => b.priority - a.priority || a.raw.length - b.raw.length);
  const entityUrl = candidates.find(item => /\/hotel\//i.test(item.raw))?.raw || '';
  const reviewUrl = candidates.find(item => /\/review(?:\?|\/|$)/i.test(item.raw))?.raw || '';
  return { preferredUrl: entityUrl || reviewUrl || candidates[0]?.raw || '', entityUrl, reviewUrl };
}
function tiketSourceUrlForInventory(loaded, inventoryId, pageMap) { return tiketSourceUrlsForInventory(loaded, inventoryId, pageMap).preferredUrl; }

function chooseTiketLogicalPages(records = []) {
  const grouped = new Map();
  records.forEach(record => {
    const page = Number(record.page);
    if (!Number.isFinite(page)) return;
    if (!grouped.has(page)) grouped.set(page, []);
    grouped.get(page).push(record);
  });
  const selected = [];
  for (const [page, occurrences] of grouped) {
    occurrences.sort((a, b) => {
      const aCount = tiketReviewData(a.body).reviews.length;
      const bCount = tiketReviewData(b.body).reviews.length;
      if (aCount !== bCount) return bCount - aCount;
      const aLast = tiketReviewData(a.body).userReviews.last === true ? 1 : 0;
      const bLast = tiketReviewData(b.body).userReviews.last === true ? 1 : 0;
      if (aLast !== bLast) return bLast - aLast;
      return b.entryIndex - a.entryIndex;
    });
    selected.push({ ...occurrences[0], occurrenceCount: occurrences.length, page });
  }
  return selected.sort((a, b) => a.page - b.page || a.entryIndex - b.entryIndex);
}

function tiketPopulationStats(records = []) {
  const seen = new Set();
  let raw = 0; let unique = 0; let duplicateIds = 0; let withText = 0; let withoutText = 0;
  records.forEach(record => {
    const reviews = tiketReviewData(record.body).reviews.filter(isTiketReview);
    raw += reviews.length;
    reviews.forEach((review, index) => {
      const key = tiketReviewIdentity(review, index);
      if (seen.has(key)) { duplicateIds += 1; return; }
      seen.add(key); unique += 1;
      if (tiketCommentText(review)) withText += 1; else withoutText += 1;
    });
  });
  return { raw, unique, duplicateIds, withText, withoutText };
}

function tiketCoverage(records = [], rawOccurrenceCount = records.length) {
  if (!records.length) return { available: false, complete: false, firstPage: null, lastPage: null, pageSize: null, totalPages: null, totalElements: null, missingPages: [], duplicatePageOccurrences: null, last: null, requestCount: 0, rawOccurrenceCount };
  const pages = records.map(record => Number(record.page)).filter(Number.isFinite).sort((a, b) => a - b);
  const first = pages[0]; const lastPage = pages[pages.length - 1];
  const terminalReviewData = tiketReviewData(records[records.length - 1].body).userReviews;
  const totals = records.map(record => tiketReviewData(record.body).userReviews).filter(Boolean);
  const totalPages = finiteCount(totals.find(item => finiteCount(item.totalPages) != null)?.totalPages);
  const totalElements = finiteCount(totals.find(item => finiteCount(item.totalElements) != null)?.totalElements);
  const pageSize = finiteCount(totals.find(item => finiteCount(item.size) != null)?.size);
  const expectedLast = totalPages != null ? totalPages - 1 : lastPage;
  const missingPages = [];
  for (let page = Math.max(0, first); page <= expectedLast; page += 1) if (!pages.includes(page)) missingPages.push(page);
  const terminalLast = terminalReviewData?.last === true;
  return {
    available: true,
    complete: first === 0 && missingPages.length === 0 && terminalLast && (totalPages == null || lastPage === totalPages - 1),
    firstPage: first,
    lastPage,
    pageSize,
    totalPages,
    totalElements,
    missingPages,
    duplicatePageOccurrences: Math.max(0, rawOccurrenceCount - records.length),
    last: typeof terminalReviewData?.last === 'boolean' ? terminalReviewData.last : null,
    requestCount: records.length,
    rawOccurrenceCount
  };
}

function buildTiketDatasetMetadata(candidate, records, population, coverage, sourceContext) {
  const firstBody = tiketReviewData(records[0]?.body || {});
  const summary = firstBody.data?.summaryReview && typeof firstBody.data.summaryReview === 'object' ? firstBody.data.summaryReview : {};
  const apiReported = coverage.totalElements ?? finiteCount(summary.totalReview);
  const difference = apiReported == null ? null : Number(apiReported) - Number(population.unique || 0);
  const listingComplete = coverage.complete === true && (difference == null || difference === 0);
  return {
    schemaVersion: 2,
    platform: 'Tiket',
    source_format: 'HAR',
    entity: String(sourceContext.objectName || candidate.objectName || '').trim(),
    entity_type: String(candidate.entityType || 'HOTEL'),
    entity_id: String(candidate.inventoryId || ''),
    page_title: String(candidate.pageTitle || sourceContext.objectName || ''),
    source_url: String(sourceContext.sourceUrl || candidate.sourceUrl || ''),
    source_entity_url: String(sourceContext.sourceEntityUrl || ''),
    source_review_url: String(sourceContext.sourceReviewUrl || ''),
    source_url_canonical: String(sourceContext.canonicalUrl || sourceContext.sourceEntityUrl || sourceContext.sourceUrl || candidate.sourceUrl || ''),
    api_reported_count: apiReported,
    retrieved_records: Number(population.raw || 0),
    unique_records: Number(population.unique || 0),
    text_records: Number(population.withText || 0),
    empty_text_records: Number(population.withoutText || 0),
    source_duplicate_review_ids: Number(population.duplicateIds || 0),
    rating_summary: finiteCount(summary.ratingSummary),
    requested_config: { ...(candidate.requestConfig || {}) },
    format_distribution: {
      requested_format: 'ALL',
      all_unique_records: Number(population.unique || 0),
      with_text: Number(population.withText || 0),
      without_text: Number(population.withoutText || 0)
    },
    pagination: {
      first_page: coverage.firstPage,
      last_page: coverage.lastPage,
      page_size: coverage.pageSize,
      total_pages: coverage.totalPages,
      request_count: coverage.requestCount,
      raw_occurrence_count: coverage.rawOccurrenceCount,
      duplicate_page_occurrences: coverage.duplicatePageOccurrences,
      missing_pages: [...coverage.missingPages],
      missing_pages_count: coverage.missingPages.length,
      last_page_flag: coverage.last,
      complete: coverage.complete === true
    },
    count_discrepancy: {
      reported_vs_retrieved: difference,
      comparison_basis: 'source_unique_ids',
      cause: difference == null ? 'totalElements not captured' : (difference === 0 ? 'no discrepancy observed' : 'not established by public API response')
    },
    coverage_claim: coverage.complete ? 'complete_observed_internalReview_pagination' : 'incomplete_observed_internalReview_pagination',
    listing_population_complete_claim: listingComplete,
    population_complete_claim: false,
    evidence: {
      imported_by_application: 'MyDataset',
      acquisition_source: 'chrome-har',
      endpoint: 'tix-review-core/verticalReview/internalReview',
      logical_page_response_count: coverage.requestCount,
      raw_endpoint_occurrences: coverage.rawOccurrenceCount,
      duplicate_page_occurrences: coverage.duplicatePageOccurrences,
      api_total_elements: apiReported,
      api_total_pages: coverage.totalPages,
      api_last_page: coverage.last,
      har_pagerefs: [...candidate.pagerefs]
    }
  };
}

function inspectTiketHarLoadedFiles(loadedFiles, options = {}) {
  const candidates = new Map();
  for (const loaded of loadedFiles.filter(item => item.sourceFormat === 'har')) {
    const entries = Array.isArray(loaded?.har?.log?.entries) ? loaded.har.log.entries : [];
    const pages = pageMapFromHar(loaded.har);
    entries.forEach((entry, entryIndex) => {
      const requestUrl = String(entry?.request?.url || '');
      if (!/\/tix-review-core\/verticalReview\/internalReview(?:\?|$)/i.test(requestUrl)) return;
      const status = Number(entry?.response?.status || 0);
      if (status && (status < 200 || status >= 300)) return;
      const body = harResponseBody(entry);
      if (!body) return;
      const { reviews, userReviews } = tiketReviewData(body);
      if (!reviews.length && !Number.isFinite(Number(userReviews?.totalElements))) return;
      const query = queryObjectFromUrl(requestUrl);
      const inventoryId = String(query.inventoryId || '').trim();
      if (!inventoryId) return;
      const config = tiketConfigFromEntry(entry);
      const configSignature = JSON.stringify(stableComparable(config));
      const logicalKey = `${inventoryId}|${configSignature}`;
      const id = `tiket_${crypto.createHash('sha1').update(logicalKey).digest('hex').slice(0, 12)}`;
      const pageref = String(entry?.pageref || '');
      const page = Number(query.page);
      if (!candidates.has(id)) {
        const sourceUrls = tiketSourceUrlsForInventory(loaded, inventoryId, pages);
        const sourceUrl = sourceUrls.preferredUrl;
        const identity = tiketIdentityFromUrl(sourceUrl || requestUrl);
        candidates.set(id, {
          id, logicalKey, inventoryId,
          entityType: String(query.productType || '').toUpperCase() === 'TIXHOTEL' ? 'HOTEL' : String(query.productType || '').replace(/^TIX/i, '').toUpperCase(),
          sourceUrl, sourceEntityUrl: sourceUrls.entityUrl, sourceReviewUrl: sourceUrls.reviewUrl, objectName: identity.objectName,
          pageTitle: String(pages.get(pageref) || sourceUrl || ''),
          pagerefs: new Set(), reviewRecords: [], files: new Set(), requestConfig: config
        });
      }
      const candidate = candidates.get(id);
      if (pageref) candidate.pagerefs.add(pageref);
      candidate.reviewRecords.push({ entry, entryIndex, body, loaded, page, size: Number(query.size), inventoryId, requestConfig: config, pageref });
      candidate.files.add(loaded.filePath);
    });
  }
  if (!candidates.size) return { summaries: [], selected: null };
  const summaries = [...candidates.values()].map(candidate => {
    const logicalRecords = chooseTiketLogicalPages(candidate.reviewRecords);
    const population = tiketPopulationStats(logicalRecords);
    const coverage = tiketCoverage(logicalRecords, candidate.reviewRecords.length);
    const rawSourceUrl = candidate.sourceUrl || '';
    const source = resolveSourceContext({ url: rawSourceUrl, preferredObjectName: candidate.objectName || '' });
    let objectName = String(source.objectName || candidate.objectName || '').trim();
    if (/^Mregency\b/i.test(objectName)) objectName = objectName.replace(/^Mregency\b/i, 'M-Regency');
    if (!objectName) objectName = candidate.inventoryId.replace(/-\d{12,}$/i, '').split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    const sourceContext = {
      objectName,
      siteName: 'Tiket',
      sourceUrl: rawSourceUrl,
      sourceEntityUrl: candidate.sourceEntityUrl || (/\/hotel\//i.test(rawSourceUrl) ? rawSourceUrl : ''),
      sourceReviewUrl: candidate.sourceReviewUrl || (/\/review/i.test(rawSourceUrl) ? rawSourceUrl : ''),
      canonicalUrl: canonicalTiketHotelUrl(candidate.sourceEntityUrl || rawSourceUrl),
      objectId: candidate.inventoryId,
      entityType: candidate.entityType || 'HOTEL',
      detectedBy: 'har-network'
    };
    const datasetMetadata = buildTiketDatasetMetadata(candidate, logicalRecords, population, coverage, sourceContext);
    return { platform: 'tiket', adapter: 'tiket-internalReview', candidate: { ...candidate, logicalRecords }, population, coverage, diagnostics: {}, sourceContext, datasetMetadata };
  }).sort((a, b) => b.population.unique - a.population.unique || naturalCompare(a.sourceContext.objectName, b.sourceContext.objectName));
  const requested = String(options.sourceSelection || '').trim();
  const selected = summaries.find(item => item.candidate.id === requested || item.candidate.inventoryId === requested) || summaries[0];
  return { summaries, selected };
}

function harSourcePageUrl(entry, pages, siteProfile = '') {
  const pageUrl = String(pages?.get?.(String(entry?.pageref || '')) || '').trim();
  if (isHttpSourceUrl(pageUrl) && sourceUrlMatchesSite(pageUrl, siteProfile)) return pageUrl;
  const referer = harHeaderValue(entry?.request?.headers, 'referer');
  if (isHttpSourceUrl(referer) && sourceUrlMatchesSite(referer, siteProfile)) return referer;
  return '';
}

function pageRecordsByNumber(records = [], reviewGetter = () => []) {
  const grouped = new Map();
  records.forEach(record => {
    const page = Number(record?.page);
    if (!Number.isFinite(page)) return;
    if (!grouped.has(page)) grouped.set(page, []);
    grouped.get(page).push(record);
  });
  const selected = [];
  for (const [page, occurrences] of grouped) {
    occurrences.sort((a, b) => {
      const ac = reviewGetter(a?.body).length;
      const bc = reviewGetter(b?.body).length;
      if (ac !== bc) return bc - ac;
      return Number(b?.entryIndex || 0) - Number(a?.entryIndex || 0);
    });
    selected.push({ ...occurrences[0], page, occurrenceCount: occurrences.length });
  }
  return selected.sort((a, b) => a.page - b.page || a.entryIndex - b.entryIndex);
}

function sourceLocalDate(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return normalizeDateValue(raw) || '';
}

function monthYearId(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})/);
  if (!match) return '';
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const month = Number(match[2]);
  if (month < 1 || month > 12) return '';
  return `${months[month - 1]} ${match[1]}`;
}

// ---------------- Agoda HAR adapter ----------------
function agodaComments(body) {
  return Array.isArray(body?.comments) ? body.comments.filter(item => item && typeof item === 'object' && item.hotelReviewId != null) : [];
}

function agodaReviewIdentity(review, fallbackIndex = 0) {
  const id = String(review?.hotelReviewId ?? '').trim();
  if (id) return `id:${id}`;
  const raw = `${review?.reviewDate ?? ''}|${review?.reviewerInfo?.displayMemberName ?? ''}|${review?.rating ?? ''}|${review?.originalComment ?? review?.reviewComments ?? ''}|${fallbackIndex}`;
  return `fallback:${crypto.createHash('sha1').update(raw).digest('hex')}`;
}

function agodaProviderName(review = {}) {
  return String(review.reviewProviderText || '').trim();
}

function agodaProviderId(review = {}) {
  return String(review.providerId ?? '').trim();
}

function agodaIsNativeReview(review = {}, nativeProviderId = '332') {
  const providerName = agodaProviderName(review).toLowerCase();
  const providerId = agodaProviderId(review);
  if (providerName) return providerName === 'agoda';
  if (providerId && nativeProviderId) return providerId === String(nativeProviderId);
  return false;
}

function agodaPositiveNegativeText(review = {}) {
  const positive = String(review.reviewPositives || '').trim();
  const negative = String(review.reviewNegatives || '').trim();
  return [positive, negative].filter(Boolean).join('\n\n').trim();
}

function agodaPreferredText(review = {}) {
  const localized = String(review.reviewComments || '').trim();
  const original = String(review.originalComment || '').trim();
  const providerText = agodaPositiveNegativeText(review);
  const source = String(review.translateSource || '').toLowerCase();
  const target = String(review.translateTarget || '').toLowerCase();
  // Fokus ke bahasa Indonesia. Response Agoda pada locale id biasanya meletakkan
  // terjemahan Indonesia di reviewComments dan teks sumber di originalComment.
  if (localized && (target === 'id' || source === 'id')) return localized;
  return localized || original || providerText;
}

function agodaPreferredTitle(review = {}) {
  const localized = String(review.reviewTitle || '').trim();
  const original = String(review.originalTitle || '').trim();
  const source = String(review.translateSource || '').toLowerCase();
  const target = String(review.translateTarget || '').toLowerCase();
  if (localized && (target === 'id' || source === 'id')) return localized;
  return localized || original;
}

function agodaStayDetail(review = {}) {
  const info = review.reviewerInfo && typeof review.reviewerInfo === 'object' ? review.reviewerInfo : {};
  const nights = Number(info.lengthOfStay);
  const monthYear = String(review.checkInDateMonthAndYear || '').trim() || monthYearId(review.checkInDate);
  if (Number.isFinite(nights) && nights > 0 && monthYear) return `Menginap ${nights} malam pada ${monthYear}`;
  if (Number.isFinite(nights) && nights > 0) return `Menginap ${nights} malam`;
  return monthYear ? `Menginap pada ${monthYear}` : '';
}

function flattenAgodaReview(review, context = {}) {
  const info = review.reviewerInfo && typeof review.reviewerInfo === 'object' ? review.reviewerInfo : {};
  const media = Array.isArray(review.ugcImages) ? review.ugcImages : [];
  const scrapedAt = context.capturedAt || context.importedAt || new Date();
  const score = Number(review.rating);
  const originalText = String(review.originalComment || '').trim();
  const chosenText = agodaPreferredText(review);
  const chosenTitle = agodaPreferredTitle(review);
  return sanitizeExportRow({
    review_id: String(review.hotelReviewId ?? ''),
    review_subject: String(context.objectName || ''),
    review_title: chosenTitle,
    review_original_title: String(review.originalTitle || '').trim(),
    review_text: chosenText,
    review_original_text: originalText || (String(review.translateSource || '').toLowerCase() !== 'id' ? String(review.reviewComments || '') : ''),
    review_positive_text: String(review.reviewPositives || '').trim(),
    review_negative_text: String(review.reviewNegatives || '').trim(),
    review_date: sourceLocalDate(review.reviewDate) || normalizeDateValue(review.formattedReviewDate) || '',
    review_datetime: String(review.reviewDate || ''),
    rating_score: Number.isFinite(score) ? score : '',
    rating_max: Number.isFinite(score) ? 10 : '',
    rating_label: String(review.ratingText || ''),
    reviewer_name: String(info.displayMemberName || ''),
    reviewer_country: String(info.countryName || ''),
    travel_type: String(info.reviewGroupName || ''),
    room_type: String(info.roomTypeName || ''),
    stay_detail: agodaStayDetail(review),
    stay_start_date: sourceLocalDate(review.checkInDate),
    stay_end_date: sourceLocalDate(review.checkOutDate),
    reaction_count: review.helpfulVotes == null ? '' : String(review.helpfulVotes),
    media_count: media.length,
    review_language: String(review.translateSource || ''),
    translation_language: String(review.translateTarget || ''),
    translation_status: String(review.translateSource || '').toLowerCase() !== String(review.translateTarget || '').toLowerCase() && review.translateTarget ? 'translated' : '',
    review_provider: String(review.reviewProviderText || 'Agoda'),
    source_site: 'AGODA',
    product_type: String(context.entityType || 'HOTEL'),
    _page: Number(context.page || 1),
    _sourceType: context.sourceType || 'har-network',
    _sourceAdapter: 'agoda-ReviewComments',
    _sourceFile: context.sourceFile || '',
    _sourceResponseIndex: context.responseIndex || 1,
    ...(context.objectName ? { _objectName: context.objectName } : {}),
    _sourceUrl: context.sourceUrl || '',
    _capturedAt: formatScrapedAt(scrapedAt),
    _scrapedAt: formatScrapedAt(scrapedAt)
  });
}

function agodaPopulationStats(records = [], options = {}) {
  const nativeOnly = options.nativeOnly === true;
  const nativeProviderId = String(options.nativeProviderId || '332');
  const seen = new Set();
  let raw = 0; let unique = 0; let duplicateIds = 0; let withText = 0; let withoutText = 0;
  records.forEach(record => {
    const allReviews = agodaComments(record.body);
    const reviews = nativeOnly ? allReviews.filter(review => agodaIsNativeReview(review, nativeProviderId)) : allReviews;
    raw += reviews.length;
    reviews.forEach((review, index) => {
      const key = agodaReviewIdentity(review, index);
      if (seen.has(key)) { duplicateIds += 1; return; }
      seen.add(key); unique += 1;
      if (agodaPreferredText(review)) withText += 1; else withoutText += 1;
    });
  });
  return { raw, unique, duplicateIds, withText, withoutText };
}

function agodaProviderStats(records = []) {
  const providers = new Map();
  for (const record of records) {
    for (const review of agodaComments(record.body)) {
      const name = agodaProviderName(review) || (agodaProviderId(review) ? `provider-${agodaProviderId(review)}` : 'unknown');
      const key = `${name}|${agodaProviderId(review)}`;
      if (!providers.has(key)) providers.set(key, { provider:name, providerId:agodaProviderId(review), records:0, withText:0, withoutText:0, uniqueIds:new Set() });
      const item = providers.get(key);
      item.records += 1;
      const identity = agodaReviewIdentity(review);
      item.uniqueIds.add(identity);
      if (agodaPreferredText(review)) item.withText += 1; else item.withoutText += 1;
    }
  }
  return [...providers.values()].map(item => ({
    provider:item.provider,
    provider_id:item.providerId,
    records:item.records,
    unique_records:item.uniqueIds.size,
    with_text:item.withText,
    without_text:item.withoutText
  })).sort((a,b)=>b.records-a.records || a.provider.localeCompare(b.provider));
}

function agodaNativeProviderId(records = [], candidate = {}) {
  const configured = candidate?.requestConfig?.providerId ?? candidate?.requestConfig?.providerIds?.[0];
  if (configured != null && String(configured).trim()) return String(configured);
  for (const record of records) {
    const list = Array.isArray(record?.body?.providerList) ? record.body.providerList : [];
    const provider = list.find(item => item?.isDefaultProvider === true) || list.find(item => /agoda/i.test(String(item?.name || '')));
    if (provider?.id != null) return String(provider.id);
  }
  return '332';
}

function agodaCoverage(records = [], rawOccurrenceCount = records.length) {
  if (!records.length) return { complete:false, firstPage:null, lastPage:null, pageSize:null, totalPages:null, totalElements:null, missingPages:[], requestCount:0, rawOccurrenceCount };
  const pages = records.map(record => Number(record.page)).filter(Number.isFinite).sort((a,b)=>a-b);
  const first = pages[0]; const lastPage = pages.at(-1);
  const firstBody = records[0]?.body || {};
  const pageSize = finiteCount(firstBody.pageSize) ?? finiteCount(records[0]?.pageSize);
  const providerId = String(records[0]?.providerId ?? '');
  const providerList = Array.isArray(firstBody.providerList) ? firstBody.providerList : [];
  const provider = providerList.find(item => String(item?.id ?? '') === providerId) || providerList.find(item => item?.isDefaultProvider === true) || providerList[0] || {};
  const totalElements = finiteCount(provider.totalIndex);
  const totalPages = totalElements != null && pageSize ? Math.ceil(totalElements / pageSize) : null;
  const expectedLast = totalPages || lastPage;
  const missingPages = [];
  for (let page = 1; page <= expectedLast; page += 1) if (!pages.includes(page)) missingPages.push(page);
  const complete = totalPages != null && first === 1 && lastPage >= totalPages && missingPages.length === 0;
  return { complete, firstPage:first, lastPage, pageSize, totalPages, totalElements, providerId:String(provider?.id ?? providerId ?? ''), missingPages, requestCount:records.length, rawOccurrenceCount, duplicatePageOccurrences:Math.max(0, rawOccurrenceCount-records.length) };
}

function buildAgodaDatasetMetadata(candidate, records, population, coverage, sourceContext, options = {}) {
  const rawPopulation = options.rawPopulation || population;
  const providerDistribution = Array.isArray(options.providerDistribution) ? options.providerDistribution : [];
  const nativeProviderId = String(options.nativeProviderId || coverage.providerId || candidate?.requestConfig?.providerId || '332');
  const partnerRecords = Math.max(0, Number(rawPopulation.unique || 0) - Number(population.unique || 0));
  const difference = coverage.totalElements == null ? null : Number(coverage.totalElements) - Number(population.unique || 0);
  return {
    schemaVersion:3, platform:'Agoda', source_format:'HAR', entity:String(sourceContext.objectName || '').trim(), entity_type:'HOTEL', entity_id:String(candidate.hotelId || ''),
    page_title:String(candidate.pageTitle || sourceContext.objectName || ''), source_url:String(sourceContext.sourceUrl || candidate.sourceUrl || ''), source_url_canonical:String(sourceContext.canonicalUrl || sourceContext.sourceUrl || candidate.sourceUrl || ''),
    provider_policy:'native-only-canonical',
    native_provider:'Agoda',
    native_provider_id:nativeProviderId,
    provider_distribution:providerDistribution,
    captured_records_all_providers:Number(rawPopulation.raw || 0),
    captured_unique_all_providers:Number(rawPopulation.unique || 0),
    partner_records_excluded_from_canonical:partnerRecords,
    api_reported_count:coverage.totalElements,
    retrieved_records:Number(population.unique || 0),
    unique_records:Number(population.unique || 0),
    text_records:Number(population.withText || 0),
    empty_text_records:Number(population.withoutText || 0),
    source_duplicate_review_ids:Number(population.duplicateIds || 0),
    requested_config:{ ...(candidate.requestConfig || {}) },
    format_distribution:{ requested_format:'NATIVE_AGODA', all_unique_records:Number(population.unique || 0), with_text:Number(population.withText || 0), without_text:Number(population.withoutText || 0) },
    pagination:{ first_page:coverage.firstPage, last_page:coverage.lastPage, page_size:coverage.pageSize, total_pages:coverage.totalPages, request_count:coverage.requestCount, raw_occurrence_count:coverage.rawOccurrenceCount, duplicate_page_occurrences:coverage.duplicatePageOccurrences, missing_pages:[...coverage.missingPages], missing_pages_count:coverage.missingPages.length, complete:coverage.complete === true },
    count_discrepancy:{ reported_vs_retrieved:difference, comparison_basis:'native_agoda_unique_ids', cause:difference == null ? 'native Agoda provider totalIndex not captured' : (difference === 0 ? 'no discrepancy observed' : 'HAR captures only observed native Agoda ReviewComments pages') },
    coverage_claim:coverage.complete ? 'complete_observed_native_Agoda_ReviewComments_pagination' : 'incomplete_observed_native_Agoda_ReviewComments_pagination',
    listing_population_complete_claim:coverage.complete === true && difference === 0,
    population_complete_claim:false,
    evidence:{ imported_by_application:'MyDataset', acquisition_source:'chrome-har', endpoint:'api/cronos/property/review/ReviewComments', logical_page_response_count:coverage.requestCount, raw_endpoint_occurrences:coverage.rawOccurrenceCount, api_total_elements:coverage.totalElements, api_total_pages:coverage.totalPages, native_provider_id:nativeProviderId, partner_records_retained_in_raw_provenance:partnerRecords, har_pagerefs:[...candidate.pagerefs] }
  };
}

function inspectAgodaHarLoadedFiles(loadedFiles, options = {}) {
  const candidates = new Map();
  for (const loaded of loadedFiles.filter(item => item.sourceFormat === 'har')) {
    const entries = Array.isArray(loaded?.har?.log?.entries) ? loaded.har.log.entries : [];
    const pages = pageMapFromHar(loaded.har);
    entries.forEach((entry, entryIndex) => {
      const requestUrl = String(entry?.request?.url || '');
      if (!/\/api\/cronos\/property\/review\/ReviewComments(?:\?|$)/i.test(requestUrl)) return;
      const body = harResponseBody(entry); if (!body) return;
      const requestData = harRequestData(entry);
      const hotelId = String(requestData.hotelId ?? body.hotelID ?? '').trim(); if (!hotelId) return;
      const page = Number(requestData.page ?? body.currentPage); const pageSize = Number(requestData.pageSize ?? body.pageSize);
      const config = { providerId:requestData.providerId ?? null, providerIds:Array.isArray(requestData.providerIds)?requestData.providerIds:[], demographicId:requestData.demographicId ?? null, sorting:requestData.sorting ?? null, filters:requestData.filters || {}, searchKeyword:requestData.searchKeyword || '', searchFilters:requestData.searchFilters || [] };
      const logicalKey = `${hotelId}|${JSON.stringify(stableComparable(config))}`;
      const id = `agoda_${crypto.createHash('sha1').update(logicalKey).digest('hex').slice(0,12)}`;
      const pageref = String(entry?.pageref || '');
      if (!candidates.has(id)) {
        const sourceUrl = harSourcePageUrl(entry, pages, 'agoda');
        const resolved = resolveSourceContext({ url:sourceUrl });
        candidates.set(id,{ id, logicalKey, hotelId, entityType:'HOTEL', sourceUrl, objectName:resolved.objectName, pageTitle:String(pages.get(pageref) || sourceUrl || ''), pagerefs:new Set(), reviewRecords:[], files:new Set(), requestConfig:config });
      }
      const candidate = candidates.get(id); if (pageref) candidate.pagerefs.add(pageref);
      candidate.reviewRecords.push({ entry, entryIndex, body, loaded, page, pageSize, providerId:requestData.providerId, pageref }); candidate.files.add(loaded.filePath);
    });
  }
  if (!candidates.size) return { summaries:[], selected:null };
  const summaries = [...candidates.values()].map(candidate => {
    const logicalRecords = pageRecordsByNumber(candidate.reviewRecords, agodaComments);
    const nativeProviderId = agodaNativeProviderId(logicalRecords, candidate);
    const rawPopulation = agodaPopulationStats(logicalRecords);
    const population = agodaPopulationStats(logicalRecords, { nativeOnly:true, nativeProviderId });
    const providerDistribution = agodaProviderStats(logicalRecords);
    const coverage = agodaCoverage(logicalRecords, candidate.reviewRecords.length);
    const resolved = resolveSourceContext({ url:candidate.sourceUrl, preferredObjectName:candidate.objectName || '' });
    const objectName = String(resolved.objectName || candidate.objectName || `Agoda Hotel ${candidate.hotelId}`).trim();
    const sourceContext = { objectName, siteName:'Agoda', sourceUrl:candidate.sourceUrl, canonicalUrl:resolved.canonicalUrl || candidate.sourceUrl, objectId:candidate.hotelId, entityType:'HOTEL', detectedBy:'har-network' };
    const datasetMetadata = buildAgodaDatasetMetadata(candidate, logicalRecords, population, coverage, sourceContext, { rawPopulation, providerDistribution, nativeProviderId });
    return { platform:'agoda', adapter:'agoda-ReviewComments', candidate:{...candidate,logicalRecords,nativeProviderId}, population, rawPopulation, providerDistribution, coverage, diagnostics:{ partnerRecordsExcluded:Math.max(0,rawPopulation.unique-population.unique) }, sourceContext, datasetMetadata };
  }).sort((a,b)=>b.population.unique-a.population.unique || naturalCompare(a.sourceContext.objectName,b.sourceContext.objectName));
  const requested=String(options.sourceSelection||'').trim(); const selected=summaries.find(item=>item.candidate.id===requested||item.candidate.hotelId===requested)||summaries[0];
  return { summaries, selected };
}


// ---------------- Booking HAR adapter ----------------
function bookingReviewFrontend(body) {
  const frontend = body?.data?.reviewListFrontend;
  return frontend && typeof frontend === 'object' && !Array.isArray(frontend) ? frontend : null;
}

function bookingReviews(body) {
  const frontend = bookingReviewFrontend(body);
  return Array.isArray(frontend?.reviewCard)
    ? frontend.reviewCard.filter(item => item && typeof item === 'object' && (item.reviewUrl != null || item.reviewScore != null))
    : [];
}

function bookingReviewIdentity(review, fallbackIndex = 0) {
  const id = String(review?.reviewUrl ?? '').trim();
  if (id) return `id:${id}`;
  const details = review?.textDetails && typeof review.textDetails === 'object' ? review.textDetails : {};
  const guest = review?.guestDetails && typeof review.guestDetails === 'object' ? review.guestDetails : {};
  const raw = `${review?.reviewedDate ?? ''}|${guest.username ?? ''}|${review?.reviewScore ?? ''}|${details.positiveText ?? ''}|${details.negativeText ?? ''}|${fallbackIndex}`;
  return `fallback:${crypto.createHash('sha1').update(raw).digest('hex')}`;
}

function bookingPreferredText(review = {}) {
  const details = review.textDetails && typeof review.textDetails === 'object' ? review.textDetails : {};
  const positive = String(details.positiveText || '').trim();
  const negative = String(details.negativeText || '').trim();
  return [positive, negative].filter(Boolean).join('\n\n').trim();
}

function bookingStayDetail(review = {}) {
  const booking = review.bookingDetails && typeof review.bookingDetails === 'object' ? review.bookingDetails : {};
  const nights = Number(booking.numNights);
  const monthYear = monthYearId(booking.checkinDate);
  if (Number.isFinite(nights) && nights > 0 && monthYear) return `Menginap ${nights} malam pada ${monthYear}`;
  if (Number.isFinite(nights) && nights > 0) return `Menginap ${nights} malam`;
  return monthYear ? `Menginap pada ${monthYear}` : '';
}

function bookingMediaUrls(review = {}) {
  const photos = Array.isArray(review.photos) ? review.photos : [];
  return photos.map(photo => {
    const urls = Array.isArray(photo?.urls) ? photo.urls : [];
    const preferred = [...urls].sort((a, b) => Number(b?.size || 0) - Number(a?.size || 0))[0] || urls[0] || {};
    return String(preferred?.url || '').trim();
  }).filter(Boolean);
}

function flattenBookingReview(review, context = {}) {
  const guest = review.guestDetails && typeof review.guestDetails === 'object' ? review.guestDetails : {};
  const booking = review.bookingDetails && typeof review.bookingDetails === 'object' ? review.bookingDetails : {};
  const roomType = booking.roomType && typeof booking.roomType === 'object' ? booking.roomType : {};
  const details = review.textDetails && typeof review.textDetails === 'object' ? review.textDetails : {};
  const reply = review.partnerReply && typeof review.partnerReply === 'object' ? review.partnerReply : {};
  const mediaUrls = bookingMediaUrls(review);
  const reviewed = epochDateTime(review.reviewedDate);
  const score = Number(review.reviewScore);
  const text = bookingPreferredText(review);
  const language = String(details.lang || '').toLowerCase();
  const scrapedAt = context.capturedAt || context.importedAt || new Date();
  return sanitizeExportRow({
    review_id: String(review.reviewUrl ?? ''),
    review_subject: String(context.objectName || ''),
    review_title: String(details.title || '').trim(),
    review_text: text,
    review_original_text: text,
    review_positive_text: String(details.positiveText || '').trim(),
    review_negative_text: String(details.negativeText || '').trim(),
    review_date: reviewed.date || '',
    review_datetime: reviewed.datetime || '',
    review_datetime_utc: reviewed.utc || '',
    review_timestamp: String(review.reviewedDate ?? ''),
    rating_score: Number.isFinite(score) ? score : '',
    rating_max: Number.isFinite(score) ? 10 : '',
    rating_label: '',
    reviewer_name: String(guest.username || ''),
    reviewer_country: String(guest.countryName || ''),
    travel_type: String(guest.guestTypeTranslation || booking.customerType || ''),
    room_type: String(roomType.name || ''),
    stay_detail: bookingStayDetail(review),
    stay_start_date: String(booking.checkinDate || ''),
    stay_end_date: String(booking.checkoutDate || ''),
    reaction_count: review.helpfulVotesCount == null ? '' : String(review.helpfulVotesCount),
    reply_text: String(reply.reply || '').trim(),
    media_count: mediaUrls.length,
    media_urls: mediaUrls.join(' | '),
    review_language: language,
    translation_language: '',
    translation_status: language === 'id' ? 'source-indonesian' : '',
    review_provider: 'Booking',
    source_site: 'BOOKING',
    product_type: String(context.entityType || 'HOTEL'),
    _page: Number(context.page || 1),
    _sourceType: context.sourceType || 'har-network',
    _sourceAdapter: 'booking-ReviewList',
    _sourceFile: context.sourceFile || '',
    _sourceResponseIndex: context.responseIndex || 1,
    ...(context.objectName ? { _objectName: context.objectName } : {}),
    _sourceUrl: context.sourceUrl || '',
    _capturedAt: formatScrapedAt(scrapedAt),
    _scrapedAt: formatScrapedAt(scrapedAt)
  });
}

function bookingPopulationStats(records = []) {
  const seen = new Set();
  let raw = 0; let unique = 0; let duplicateIds = 0; let withText = 0; let withoutText = 0;
  records.forEach(record => {
    const reviews = bookingReviews(record.body);
    raw += reviews.length;
    reviews.forEach((review, index) => {
      const key = bookingReviewIdentity(review, index);
      if (seen.has(key)) { duplicateIds += 1; return; }
      seen.add(key); unique += 1;
      if (bookingPreferredText(review)) withText += 1; else withoutText += 1;
    });
  });
  return { raw, unique, duplicateIds, withText, withoutText };
}

function bookingRecordsBySkip(records = []) {
  const grouped = new Map();
  records.forEach(record => {
    const skip = Number(record?.skip);
    if (!Number.isFinite(skip) || skip < 0) return;
    if (!grouped.has(skip)) grouped.set(skip, []);
    grouped.get(skip).push(record);
  });
  const selected = [];
  for (const [skip, occurrences] of grouped) {
    occurrences.sort((a, b) => {
      const ac = bookingReviews(a?.body).length;
      const bc = bookingReviews(b?.body).length;
      if (ac !== bc) return bc - ac;
      return Number(b?.entryIndex || 0) - Number(a?.entryIndex || 0);
    });
    selected.push({ ...occurrences[0], skip, occurrenceCount: occurrences.length });
  }
  return selected.sort((a, b) => a.skip - b.skip || a.entryIndex - b.entryIndex);
}

function bookingCoverage(records = [], rawOccurrenceCount = records.length) {
  if (!records.length) return { complete:false, firstSkip:null, lastSkip:null, limit:null, totalPages:null, totalElements:null, missingSkips:[], requestCount:0, rawOccurrenceCount };
  const skips = records.map(record => Number(record.skip)).filter(Number.isFinite).sort((a,b)=>a-b);
  const firstSkip = skips[0]; const lastSkip = skips.at(-1);
  const limit = finiteCount(records[0]?.limit);
  const totals = records.map(record => finiteCount(bookingReviewFrontend(record.body)?.reviewsCount)).filter(value => value != null);
  const totalElements = totals.length ? Math.max(...totals) : null;
  const totalPages = totalElements != null && limit ? Math.ceil(totalElements / limit) : null;
  const expectedLastSkip = totalElements != null && limit && totalElements > 0 ? Math.floor((totalElements - 1) / limit) * limit : lastSkip;
  const missingSkips = [];
  if (limit) for (let skip = 0; skip <= expectedLastSkip; skip += limit) if (!skips.includes(skip)) missingSkips.push(skip);
  const complete = totalElements != null && limit != null && firstSkip === 0 && lastSkip >= expectedLastSkip && missingSkips.length === 0;
  return {
    complete, firstSkip, lastSkip, limit, totalPages, totalElements, missingSkips,
    firstPage: limit ? Math.floor(firstSkip / limit) + 1 : null,
    lastPage: limit ? Math.floor(lastSkip / limit) + 1 : null,
    requestCount: records.length,
    rawOccurrenceCount,
    duplicateOffsetOccurrences: Math.max(0, rawOccurrenceCount - records.length)
  };
}

function buildBookingDatasetMetadata(candidate, records, population, coverage, sourceContext) {
  const difference = coverage.totalElements == null ? null : Number(coverage.totalElements) - Number(population.unique || 0);
  return {
    schemaVersion:2,
    platform:'Booking',
    source_format:'HAR',
    entity:String(sourceContext.objectName || '').trim(),
    entity_type:'HOTEL',
    entity_id:String(candidate.hotelId || ''),
    page_title:String(candidate.pageTitle || sourceContext.objectName || ''),
    source_url:String(sourceContext.sourceUrl || candidate.sourceUrl || ''),
    source_url_canonical:String(sourceContext.canonicalUrl || sourceContext.sourceUrl || candidate.sourceUrl || ''),
    api_reported_count:coverage.totalElements,
    retrieved_records:Number(population.raw || 0),
    unique_records:Number(population.unique || 0),
    text_records:Number(population.withText || 0),
    empty_text_records:Number(population.withoutText || 0),
    source_duplicate_review_ids:Number(population.duplicateIds || 0),
    requested_config:{ ...(candidate.requestConfig || {}) },
    format_distribution:{ requested_format:'ALL', all_unique_records:Number(population.unique || 0), with_text:Number(population.withText || 0), without_text:Number(population.withoutText || 0) },
    pagination:{
      first_skip:coverage.firstSkip, last_skip:coverage.lastSkip, limit:coverage.limit,
      first_page:coverage.firstPage, last_page:coverage.lastPage, total_pages:coverage.totalPages,
      request_count:coverage.requestCount, raw_occurrence_count:coverage.rawOccurrenceCount,
      duplicate_offset_occurrences:coverage.duplicateOffsetOccurrences,
      missing_offsets:coverage.missingSkips.length, missing_skip_values:[...coverage.missingSkips],
      complete:coverage.complete === true
    },
    count_discrepancy:{ reported_vs_retrieved:difference, comparison_basis:'source_unique_ids', cause:difference == null ? 'reviewsCount not captured' : (difference === 0 ? 'no discrepancy observed' : 'HAR captures only observed ReviewList offsets') },
    coverage_claim:coverage.complete ? 'complete_observed_ReviewList_pagination' : 'incomplete_observed_ReviewList_pagination',
    listing_population_complete_claim:coverage.complete === true && difference === 0,
    population_complete_claim:false,
    evidence:{ imported_by_application:'MyDataset', acquisition_source:'chrome-har', endpoint:'dml/graphql ReviewList', logical_page_response_count:coverage.requestCount, raw_endpoint_occurrences:coverage.rawOccurrenceCount, api_total_elements:coverage.totalElements, api_total_pages:coverage.totalPages, har_pagerefs:[...candidate.pagerefs] }
  };
}

function inspectBookingHarLoadedFiles(loadedFiles, options = {}) {
  const candidates = new Map();
  for (const loaded of loadedFiles.filter(item => item.sourceFormat === 'har')) {
    const entries = Array.isArray(loaded?.har?.log?.entries) ? loaded.har.log.entries : [];
    const pages = pageMapFromHar(loaded.har);
    entries.forEach((entry, entryIndex) => {
      const requestUrl = String(entry?.request?.url || '');
      if (!/\/dml\/graphql(?:\?|$)/i.test(requestUrl)) return;
      const requestBody = parseJsonBody(entry?.request?.postData?.text || '');
      if (!requestBody || String(requestBody.operationName || '') !== 'ReviewList') return;
      const body = harResponseBody(entry); if (!bookingReviewFrontend(body)) return;
      const variables = requestBody.variables && typeof requestBody.variables === 'object' ? requestBody.variables : {};
      const input = variables.input && typeof variables.input === 'object' ? variables.input : {};
      const hotelId = String(input.hotelId ?? '').trim(); if (!hotelId) return;
      const skip = Number(input.skip); const limit = Number(input.limit);
      const config = {
        ufi: input.ufi ?? null,
        hotelCountryCode: input.hotelCountryCode || '',
        sorter: input.sorter || '',
        filters: input.filters && typeof input.filters === 'object' ? input.filters : {},
        limit: Number.isFinite(limit) ? limit : null,
        hotelScore: input.hotelScore ?? null,
        searchFeatures: input.searchFeatures && typeof input.searchFeatures === 'object' ? input.searchFeatures : {}
      };
      const logicalKey = `${hotelId}|${JSON.stringify(stableComparable(config))}`;
      const id = `booking_${crypto.createHash('sha1').update(logicalKey).digest('hex').slice(0,12)}`;
      const pageref = String(entry?.pageref || '');
      if (!candidates.has(id)) {
        const sourceUrl = harSourcePageUrl(entry, pages, 'booking');
        const resolved = resolveSourceContext({ url:sourceUrl });
        const normalizedSourceUrl = resolved.sourceUrl || sourceUrl;
        candidates.set(id, { id, logicalKey, hotelId, entityType:'HOTEL', sourceUrl:normalizedSourceUrl, objectName:resolved.objectName, pageTitle:String(resolved.objectName || normalizedSourceUrl || ''), pagerefs:new Set(), reviewRecords:[], files:new Set(), requestConfig:config });
      }
      const candidate = candidates.get(id); if (pageref) candidate.pagerefs.add(pageref);
      candidate.reviewRecords.push({ entry, entryIndex, body, loaded, skip, limit, page:Number.isFinite(skip) && Number.isFinite(limit) && limit > 0 ? Math.floor(skip / limit) + 1 : null, pageref });
      candidate.files.add(loaded.filePath);
    });
  }
  if (!candidates.size) return { summaries:[], selected:null };
  const summaries = [...candidates.values()].map(candidate => {
    const logicalRecords = bookingRecordsBySkip(candidate.reviewRecords);
    const population = bookingPopulationStats(logicalRecords);
    const coverage = bookingCoverage(logicalRecords, candidate.reviewRecords.length);
    const resolved = resolveSourceContext({ url:candidate.sourceUrl, preferredObjectName:candidate.objectName || '' });
    const objectName = String(resolved.objectName || candidate.objectName || `Booking Hotel ${candidate.hotelId}`).trim();
    const sourceContext = { objectName, siteName:'Booking', sourceUrl:candidate.sourceUrl, canonicalUrl:resolved.canonicalUrl || candidate.sourceUrl, objectId:candidate.hotelId, entityType:'HOTEL', detectedBy:'har-network' };
    const datasetMetadata = buildBookingDatasetMetadata(candidate, logicalRecords, population, coverage, sourceContext);
    return { platform:'booking', adapter:'booking-ReviewList', candidate:{...candidate,logicalRecords}, population, coverage, diagnostics:{}, sourceContext, datasetMetadata };
  }).sort((a,b)=>b.population.unique-a.population.unique || naturalCompare(a.sourceContext.objectName,b.sourceContext.objectName));
  const requested = String(options.sourceSelection || '').trim();
  const selected = summaries.find(item => item.candidate.id === requested || item.candidate.hotelId === requested) || summaries[0];
  return { summaries, selected };
}

// ---------------- Trip HAR adapter ----------------
function tripComments(body) {
  const groups = Array.isArray(body?.data?.groupList) ? body.data.groupList : [];
  const preferred = groups.filter(group => Number(group?.dataType) === 7 && Array.isArray(group?.commentList));
  const source = preferred.length ? preferred : groups.filter(group => Array.isArray(group?.commentList));
  const seen = new Set(); const out = [];
  source.flatMap(group => group.commentList).forEach((review,index)=>{
    if (!review || typeof review !== 'object') return;
    const key = String(review.id ?? '') || `fallback:${index}:${review.createDate || ''}:${review.content || ''}`;
    if (seen.has(key)) return; seen.add(key); out.push(review);
  });
  return out;
}

function tripReviewIdentity(review, fallbackIndex = 0) {
  const id = String(review?.id ?? '').trim(); if (id) return `id:${id}`;
  const raw = `${review?.createDate ?? ''}|${review?.userInfo?.nickName ?? ''}|${review?.rating ?? ''}|${review?.content ?? ''}|${fallbackIndex}`;
  return `fallback:${crypto.createHash('sha1').update(raw).digest('hex')}`;
}

function tripPreferredText(review = {}) {
  const original = String(review.content || '').trim();
  const translated = String(review.translatedContent || '').trim();
  const originalLanguage = String(review.language || '').toLowerCase();
  const translatedLanguage = String(review.translatedLanguage || '').toLowerCase();
  if (translated && translatedLanguage === 'id') return translated;
  if (original && originalLanguage === 'id') return original;
  return translated || original;
}

function tripStayDetail(review = {}) {
  const monthYear = monthYearId(review.checkinDate);
  return monthYear ? `Menginap pada ${monthYear}` : '';
}

function flattenTripReview(review, context = {}) {
  const user = review.userInfo && typeof review.userInfo === 'object' ? review.userInfo : {};
  const grade = user.grade && typeof user.grade === 'object' ? user.grade : {};
  const ratingInfo = review.ratingInfo && typeof review.ratingInfo === 'object' ? review.ratingInfo : {};
  const score = Number(review.rating); const max = Number(ratingInfo.fullRating);
  const media = Array.isArray(review.imageList) ? review.imageList : [];
  const scrapedAt = context.capturedAt || context.importedAt || new Date();
  const selectedText = tripPreferredText(review); const originalText = String(review.content || '').trim();
  return sanitizeExportRow({
    review_id:String(review.id ?? ''), review_subject:String(context.objectName || ''), review_title:'', review_text:selectedText, review_original_text:originalText,
    review_date:sourceLocalDate(review.createDate), review_datetime:String(review.createDate || ''), rating_score:Number.isFinite(score)?score:'', rating_max:Number.isFinite(max)?max:(Number.isFinite(score)?10:''), rating_label:String(ratingInfo.commentLevel || ''),
    reviewer_name:String(user.nickName || ''), reviewer_country:String(user.regionName || ''), reviewer_status:String(grade.title || ''), travel_type:String(review.travelTypeText || ''), room_type:String(review.roomName || ''), stay_detail:tripStayDetail(review), stay_start_date:sourceLocalDate(review.checkinDate),
    reaction_count:review.usefulCount == null ? '' : String(review.usefulCount), media_count:media.length, media_urls:media.map(String).filter(Boolean).join(' | '), review_language:String(review.language || ''), translation_language:String(review.translatedLanguage || ''), translation_status:String(review.translatedSourceText || (review.translatedContent ? 'translated' : '')),
    review_source_name:String(review.sourceName || 'Trip'), source_site:'TRIP', product_type:String(context.entityType || 'HOTEL'),
    _page:Number(context.page || 1), _sourceType:context.sourceType || 'har-network', _sourceAdapter:'trip-getHotelCommentInfo', _sourceFile:context.sourceFile || '', _sourceResponseIndex:context.responseIndex || 1,
    ...(context.objectName ? { _objectName:context.objectName } : {}), _sourceUrl:context.sourceUrl || '', _capturedAt:formatScrapedAt(scrapedAt), _scrapedAt:formatScrapedAt(scrapedAt)
  });
}

function tripPopulationStats(records = []) {
  const seen=new Set(); let raw=0,unique=0,duplicateIds=0,withText=0,withoutText=0;
  records.forEach(record=>{ const reviews=tripComments(record.body); raw+=reviews.length; reviews.forEach((review,index)=>{ const key=tripReviewIdentity(review,index); if(seen.has(key)){duplicateIds+=1;return;} seen.add(key);unique+=1;if(tripPreferredText(review))withText+=1;else withoutText+=1; }); });
  return {raw,unique,duplicateIds,withText,withoutText};
}

function tripCoverage(records = [], rawOccurrenceCount = records.length) {
  if(!records.length)return{complete:false,firstPage:null,lastPage:null,pageSize:null,totalPages:null,totalElements:null,missingPages:[],requestCount:0,rawOccurrenceCount};
  const pages=records.map(record=>Number(record.page)).filter(Number.isFinite).sort((a,b)=>a-b); const first=pages[0],lastPage=pages.at(-1);
  const firstData=records[0]?.body?.data || {}; const totalElements=finiteCount(firstData.totalCountForPage); const pageSize=finiteCount(records[0]?.pageSize); const totalPages=totalElements!=null&&pageSize?Math.ceil(totalElements/pageSize):null;
  const missingPages=[]; const expectedLast=totalPages||lastPage; for(let page=Math.max(1,first);page<=expectedLast;page+=1)if(!pages.includes(page))missingPages.push(page);
  const complete=totalPages!=null&&first<=1&&lastPage>=totalPages&&missingPages.length===0;
  return{complete,firstPage:first,lastPage,pageSize,totalPages,totalElements,missingPages,requestCount:records.length,rawOccurrenceCount,duplicatePageOccurrences:Math.max(0,rawOccurrenceCount-records.length),totalCount:finiteCount(firstData.totalCount),repeatCommentCount:finiteCount(firstData.repeatCommentCount)};
}

function buildTripDatasetMetadata(candidate, records, population, coverage, sourceContext) {
  const difference=coverage.totalElements==null?null:Number(coverage.totalElements)-Number(population.unique||0);
  const repeatDerivation = coverage.totalCount == null || coverage.repeatCommentCount == null || coverage.totalElements == null
    ? null
    : Number(coverage.totalCount) - Number(coverage.repeatCommentCount) === Number(coverage.totalElements);
  return{schemaVersion:2,platform:'Trip',source_format:'HAR',entity:String(sourceContext.objectName||'').trim(),entity_type:'HOTEL',entity_id:String(candidate.hotelId||''),page_title:String(candidate.pageTitle||sourceContext.objectName||''),source_url:String(sourceContext.sourceUrl||candidate.sourceUrl||''),source_url_canonical:String(sourceContext.canonicalUrl||sourceContext.sourceUrl||candidate.sourceUrl||''),api_reported_count:coverage.totalElements,api_reported_total_count:coverage.totalCount,api_repeat_comment_count:coverage.repeatCommentCount,listing_count_derivation_verified:repeatDerivation,retrieved_records:Number(population.raw||0),unique_records:Number(population.unique||0),text_records:Number(population.withText||0),empty_text_records:Number(population.withoutText||0),source_duplicate_review_ids:Number(population.duplicateIds||0),requested_config:{...(candidate.requestConfig||{})},format_distribution:{requested_format:'ALL',all_unique_records:Number(population.unique||0),with_text:Number(population.withText||0),without_text:Number(population.withoutText||0)},pagination:{first_page:coverage.firstPage,last_page:coverage.lastPage,page_size:coverage.pageSize,total_pages:coverage.totalPages,request_count:coverage.requestCount,raw_occurrence_count:coverage.rawOccurrenceCount,duplicate_page_occurrences:coverage.duplicatePageOccurrences,missing_pages:[...coverage.missingPages],missing_pages_count:coverage.missingPages.length,complete:coverage.complete===true},count_discrepancy:{reported_vs_retrieved:difference,comparison_basis:'source_unique_ids',cause:difference==null?'totalCountForPage not captured':(difference===0?'no discrepancy observed':'HAR captures only observed getHotelCommentInfo pages')},coverage_claim:coverage.complete?'complete_observed_getHotelCommentInfo_pagination':'incomplete_observed_getHotelCommentInfo_pagination',listing_population_complete_claim:coverage.complete===true&&difference===0,population_complete_claim:false,recommended_role:'primary-trip-multipage',evidence:{imported_by_application:'MyDataset',acquisition_source:'chrome-har',endpoint:'restapi/soa2/34308/getHotelCommentInfo',logical_page_response_count:coverage.requestCount,raw_endpoint_occurrences:coverage.rawOccurrenceCount,api_total_elements:coverage.totalElements,api_total_count:coverage.totalCount,api_repeat_comment_count:coverage.repeatCommentCount,api_total_pages:coverage.totalPages,har_pagerefs:[...candidate.pagerefs]}};
}

function inspectTripHarLoadedFiles(loadedFiles, options = {}) {
  const candidates=new Map();
  for(const loaded of loadedFiles.filter(item=>item.sourceFormat==='har')){
    const entries=Array.isArray(loaded?.har?.log?.entries)?loaded.har.log.entries:[]; const pages=pageMapFromHar(loaded.har);
    entries.forEach((entry,entryIndex)=>{ const requestUrl=String(entry?.request?.url||''); if(!/\/restapi\/soa2\/34308\/getHotelCommentInfo(?:\?|$)/i.test(requestUrl))return; const body=harResponseBody(entry); if(!body)return; const requestData=harRequestData(entry); const hotelId=String(requestData.hotelId??'').trim(); if(!hotelId)return; const opts=requestData.commentFilterOptions&&typeof requestData.commentFilterOptions==='object'?requestData.commentFilterOptions:{}; const page=Number(opts.pageIndex); const pageSize=Number(opts.pageSize); const config={commentFilterOptions:{...opts,pageIndex:undefined},sceneTypes:Array.isArray(requestData.sceneTypes)?requestData.sceneTypes:[]}; delete config.commentFilterOptions.pageIndex; const logicalKey=`${hotelId}|${JSON.stringify(stableComparable(config))}`; const id=`trip_${crypto.createHash('sha1').update(logicalKey).digest('hex').slice(0,12)}`; const pageref=String(entry?.pageref||'');
      if(!candidates.has(id)){const sourceUrl=harSourcePageUrl(entry,pages,'trip');const resolved=resolveSourceContext({url:sourceUrl});candidates.set(id,{id,logicalKey,hotelId,entityType:'HOTEL',sourceUrl,objectName:resolved.objectName,pageTitle:String(pages.get(pageref)||sourceUrl||''),pagerefs:new Set(),reviewRecords:[],files:new Set(),requestConfig:config});}
      const candidate=candidates.get(id);if(pageref)candidate.pagerefs.add(pageref);candidate.reviewRecords.push({entry,entryIndex,body,loaded,page,pageSize,pageref});candidate.files.add(loaded.filePath);
    });
  }
  if(!candidates.size)return{summaries:[],selected:null};
  const summaries=[...candidates.values()].map(candidate=>{const logicalRecords=pageRecordsByNumber(candidate.reviewRecords,tripComments);const population=tripPopulationStats(logicalRecords);const coverage=tripCoverage(logicalRecords,candidate.reviewRecords.length);const resolved=resolveSourceContext({url:candidate.sourceUrl,preferredObjectName:candidate.objectName||''});const objectName=String(resolved.objectName||candidate.objectName||`Trip Hotel ${candidate.hotelId}`).trim();const sourceContext={objectName,siteName:'Trip',sourceUrl:candidate.sourceUrl,canonicalUrl:resolved.canonicalUrl||candidate.sourceUrl,objectId:candidate.hotelId,entityType:'HOTEL',detectedBy:'har-network'};const datasetMetadata=buildTripDatasetMetadata(candidate,logicalRecords,population,coverage,sourceContext);return{platform:'trip',adapter:'trip-getHotelCommentInfo',candidate:{...candidate,logicalRecords},population,coverage,diagnostics:{},sourceContext,datasetMetadata};}).sort((a,b)=>b.population.unique-a.population.unique||naturalCompare(a.sourceContext.objectName,b.sourceContext.objectName));
  const requested=String(options.sourceSelection||'').trim();const selected=summaries.find(item=>item.candidate.id===requested||item.candidate.hotelId===requested)||summaries[0];return{summaries,selected};
}


function inspectHarLoadedFiles(loadedFiles, options = {}) {
  const entryLists = loadedFiles.map(loaded => Array.isArray(loaded?.har?.log?.entries) ? loaded.har.log.entries : []);
  const hasTraveloka = entryLists.some(entries => entries.some(entry => endpointLeaf(entry?.request?.url || '') === 'getReviews' && sourceUrlMatchesSite(entry?.request?.url || '', 'traveloka')));
  const hasTiket = entryLists.some(entries => entries.some(entry => /\/tix-review-core\/verticalReview\/internalReview(?:\?|$)/i.test(String(entry?.request?.url || ''))));
  const hasAgoda = entryLists.some(entries => entries.some(entry => /\/api\/cronos\/property\/review\/ReviewComments(?:\?|$)/i.test(String(entry?.request?.url || ''))));
  const hasTrip = entryLists.some(entries => entries.some(entry => /\/restapi\/soa2\/34308\/getHotelCommentInfo(?:\?|$)/i.test(String(entry?.request?.url || ''))));
  const hasBooking = entryLists.some(entries => entries.some(entry => {
    if (!/\/dml\/graphql(?:\?|$)/i.test(String(entry?.request?.url || ''))) return false;
    const body = parseJsonBody(entry?.request?.postData?.text || '');
    return String(body?.operationName || '') === 'ReviewList';
  }));
  const summaries = [];
  if (hasTraveloka) summaries.push(...inspectTravelokaHarLoadedFiles(loadedFiles, options).summaries.map(item => ({ platform:'traveloka', adapter:'traveloka-getReviews', ...item })));
  if (hasTiket) summaries.push(...inspectTiketHarLoadedFiles(loadedFiles, options).summaries);
  if (hasAgoda) summaries.push(...inspectAgodaHarLoadedFiles(loadedFiles, options).summaries);
  if (hasTrip) summaries.push(...inspectTripHarLoadedFiles(loadedFiles, options).summaries);
  if (hasBooking) summaries.push(...inspectBookingHarLoadedFiles(loadedFiles, options).summaries);
  if (!summaries.length) throw new Error('HAR tidak berisi endpoint review yang didukung. HAR / Network mendukung Traveloka, Tiket, Agoda, Trip, dan Booking. Pastikan HAR disimpan dengan response content.');
  const requested = String(options.sourceSelection || '').trim();
  const requestedSite = String(options.project?.siteProfile || '').toLowerCase();
  const supportedSites = ['traveloka','tiket','agoda','trip','booking'];
  const pool = supportedSites.includes(requestedSite) ? summaries.filter(item => item.platform === requestedSite) : summaries;
  const ranked = (pool.length ? pool : summaries).sort((a,b)=>b.population.unique-a.population.unique || naturalCompare(a.sourceContext.objectName,b.sourceContext.objectName));
  const selected = summaries.find(item => item.candidate.id === requested || String(item.sourceContext.objectId || '') === requested) || ranked[0];
  return { summaries, selected };
}

function finalDatasetMetadata(importInfo = {}, context = {}) {
  const capture = importInfo.captureMetadata || null;
  const suppliedMeta = importInfo.datasetMetadata && typeof importInfo.datasetMetadata === 'object' ? importInfo.datasetMetadata : null;
  const sourceMeta = suppliedMeta ? JSON.parse(JSON.stringify(suppliedMeta)) : (capture?.datasetMetadata && typeof capture.datasetMetadata === 'object' ? JSON.parse(JSON.stringify(capture.datasetMetadata)) : {});
  const sourceContext = importInfo.sourceContext || {};
  const adapterPlatform = importInfo.adapter === 'tiket-internalReview' ? 'Tiket' : importInfo.adapter === 'agoda-ReviewComments' ? 'Agoda' : importInfo.adapter === 'trip-getHotelCommentInfo' ? 'Trip' : importInfo.adapter === 'booking-ReviewList' ? 'Booking' : 'Traveloka';
  const platform = String(sourceMeta.platform || sourceContext.siteName || adapterPlatform);
  const isTiket = /tiket/i.test(platform) || importInfo.adapter === 'tiket-internalReview';
  const isAgoda = /agoda/i.test(platform) || importInfo.adapter === 'agoda-ReviewComments';
  const isTrip = /^trip$/i.test(platform) || importInfo.adapter === 'trip-getHotelCommentInfo';
  const isBooking = /booking/i.test(platform) || importInfo.adapter === 'booking-ReviewList';
  const isTraveloka = /traveloka/i.test(platform) || importInfo.adapter === 'traveloka-getReviews';
  const rawRecords = Number(context.rawRecords ?? importInfo.totalReviews ?? sourceMeta.source_records ?? sourceMeta.retrieved_records ?? 0);
  const sourceUniqueRecords = Number(context.sourceUniqueRecords ?? importInfo.uniqueSourceReviews ?? sourceMeta.source_unique_ids ?? sourceMeta.unique_records ?? rawRecords);
  const cleanRecords = Number(context.cleanRecords ?? sourceMeta.clean_records ?? sourceUniqueRecords);
  const reported = sourceMeta.api_reported_count != null ? Number(sourceMeta.api_reported_count)
    : (sourceMeta.api_reported_text_count != null ? Number(sourceMeta.api_reported_text_count)
      : (capture?.apiReportedReviewCount != null ? Number(capture.apiReportedReviewCount) : null));
  const lastHasNext = typeof importInfo.lastHasNext === 'boolean' ? importInfo.lastHasNext
    : (typeof sourceMeta?.pagination?.last_has_next === 'boolean' ? sourceMeta.pagination.last_has_next : null);
  const sourcePaginationComplete = typeof sourceMeta?.pagination?.complete === 'boolean' ? sourceMeta.pagination.complete : null;
  const skipCoverage = typeof capture?.skipCoverageComplete === 'boolean' ? capture.skipCoverageComplete : sourcePaginationComplete;
  const observedComplete = isTraveloka ? (lastHasNext === false && skipCoverage !== false) : sourcePaginationComplete === true;
  const difference = reported == null ? null : reported - sourceUniqueRecords;
  const aggregateTraveloka = sourceMeta.aggregate_traveloka != null ? Number(sourceMeta.aggregate_traveloka) : (capture?.aggregateTraveloka != null ? Number(capture.aggregateTraveloka) : null);
  const aggregateOther = sourceMeta.aggregate_other != null ? Number(sourceMeta.aggregate_other) : (capture?.aggregateOther != null ? Number(capture.aggregateOther) : null);
  const aggregateTotal = sourceMeta.aggregate_total != null ? Number(sourceMeta.aggregate_total)
    : (capture?.aggregateTotal != null ? Number(capture.aggregateTotal) : (aggregateTraveloka != null && aggregateOther != null ? aggregateTraveloka + aggregateOther : null));
  const textRecords = Number(sourceMeta.text_records ?? importInfo.textReviewCount ?? 0);
  const emptyTextRecords = Number(sourceMeta.empty_text_records ?? importInfo.emptyTextReviewCount ?? Math.max(0, rawRecords - textRecords));
  const originalPagination = sourceMeta.pagination && typeof sourceMeta.pagination === 'object' ? sourceMeta.pagination : {};
  const pagination = isTraveloka ? {
    ...originalPagination,
    first_skip: originalPagination.first_skip ?? null,
    last_skip: originalPagination.last_skip ?? null,
    limit: originalPagination.limit ?? null,
    request_count: originalPagination.request_count ?? Number(importInfo.responseCount || 0),
    missing_offsets: originalPagination.missing_offsets ?? (capture?.skipCoverageComplete === true ? 0 : null),
    missing_skip_values: Array.isArray(originalPagination.missing_skip_values) ? [...originalPagination.missing_skip_values] : [],
    duplicate_offsets: originalPagination.duplicate_offsets ?? null,
    last_has_next: lastHasNext,
    complete: observedComplete
  } : {
    ...originalPagination,
    request_count: originalPagination.request_count ?? Number(importInfo.responseCount || 0),
    complete: observedComplete
  };
  const sourceCause = String(sourceMeta?.count_discrepancy?.cause || '');
  const discrepancyCause = difference == null
    ? (sourceCause || (isTiket ? 'totalElements not captured' : isAgoda ? 'provider totalIndex not captured' : isTrip ? 'totalCountForPage not captured' : isBooking ? 'reviewsCount not captured' : 'getReviewCount not captured'))
    : (difference === 0 ? 'no discrepancy observed' : (sourceCause || 'not established by public API response'));
  const coverageClaim = String(sourceMeta.coverage_claim || (isTiket
    ? (observedComplete ? 'complete_observed_internalReview_pagination' : 'incomplete_observed_internalReview_pagination')
    : isAgoda ? (observedComplete ? 'complete_observed_ReviewComments_pagination' : 'incomplete_observed_ReviewComments_pagination')
    : isTrip ? (observedComplete ? 'complete_observed_getHotelCommentInfo_pagination' : 'incomplete_observed_getHotelCommentInfo_pagination')
    : isBooking ? (observedComplete ? 'complete_observed_ReviewList_pagination' : 'incomplete_observed_ReviewList_pagination')
    : (observedComplete ? 'complete_observed_getReviews_pagination' : (lastHasNext === true ? 'incomplete_observed_getReviews_pagination' : 'terminal_state_not_fully_verified'))));

  return {
    ...sourceMeta,
    schemaVersion: Math.max(2, Number(sourceMeta.schemaVersion || 0)),
    platform,
    source_format: String(sourceMeta.source_format || importInfo.sourceType || (capture ? 'MyDataset Capture JSON' : 'Network JSON')),
    entity: String(context.entity || sourceMeta.entity || sourceContext.objectName || '').trim(),
    entity_type: String(sourceMeta.entity_type || sourceContext.entityType || ''),
    entity_id: String(sourceMeta.entity_id || sourceContext.objectId || ''),
    page_title: String(sourceMeta.page_title || capture?.pageTitle || sourceContext.objectName || ''),
    source_url: String(context.sourceUrl || sourceMeta.source_url || sourceContext.sourceUrl || capture?.sourceUrl || ''),
    source_entity_url: String(sourceMeta.source_entity_url || sourceContext.sourceEntityUrl || ''),
    source_review_url: String(sourceMeta.source_review_url || sourceContext.sourceReviewUrl || ''),
    source_url_canonical: String(sourceMeta.source_url_canonical || sourceContext.canonicalUrl || sourceContext.sourceEntityUrl || context.sourceUrl || sourceContext.sourceUrl || ''),
    aggregate_total: aggregateTotal,
    aggregate_traveloka: aggregateTraveloka,
    aggregate_other: aggregateOther,
    aggregate_other_provider: String(sourceMeta.aggregate_other_provider || ''),
    aggregate_consistent: typeof sourceMeta.aggregate_consistent === 'boolean' ? sourceMeta.aggregate_consistent : null,
    filter: sourceMeta.filter && typeof sourceMeta.filter === 'object' ? { ...sourceMeta.filter } : {},
    listing_origin: sourceMeta.listing_origin ?? null,
    count_request_origin: sourceMeta.count_request_origin ?? null,
    api_reported_count: reported,
    api_reported_text_count: sourceMeta.api_reported_text_count ?? null,
    source_records: rawRecords,
    raw_captured_records: rawRecords,
    source_unique_ids: sourceUniqueRecords,
    clean_records: cleanRecords,
    duplicate_exact: Number(context.exactDuplicates || 0),
    duplicate_candidates: Number(context.possibleDuplicates || 0),
    retrieved_records: sourceUniqueRecords,
    unique_records: sourceUniqueRecords,
    text_records: textRecords,
    empty_text_records: emptyTextRecords,
    format_distribution: {
      ...(sourceMeta.format_distribution && typeof sourceMeta.format_distribution === 'object' ? sourceMeta.format_distribution : {}),
      requested_format: String(sourceMeta?.format_distribution?.requested_format || sourceMeta?.filter?.format || (!isTraveloka ? 'ALL' : '')),
      all_unique_records: sourceUniqueRecords,
      with_text: textRecords,
      without_text: emptyTextRecords
    },
    pagination,
    count_discrepancy: {
      ...(sourceMeta.count_discrepancy && typeof sourceMeta.count_discrepancy === 'object' ? sourceMeta.count_discrepancy : {}),
      reported_vs_retrieved: difference,
      comparison_basis: String(sourceMeta?.count_discrepancy?.comparison_basis || 'source_unique_ids'),
      cause: discrepancyCause
    },
    coverage_claim: coverageClaim,
    listing_population_complete_claim: sourceMeta.listing_population_complete_claim === true,
    population_complete_claim: false,
    evidence: {
      ...(sourceMeta.evidence && typeof sourceMeta.evidence === 'object' ? sourceMeta.evidence : {}),
      imported_by_application: 'MyDataset',
      capture_extension_version: String(capture?.extensionVersion || sourceMeta?.evidence?.capture_extension_version || ''),
      source_file_count: Array.isArray(importInfo.files) ? importInfo.files.length : 0,
      response_count: Number(importInfo.responseCount || 0),
      application_exact_duplicates: Number(context.exactDuplicates || 0),
      application_possible_duplicates: Number(context.possibleDuplicates || 0)
    },
    capture_observed: capture ? {
      raw_records: Number(capture.rawReviewCount || 0),
      unique_records: Number(capture.uniqueReviewCount || capture.reviewCount || 0),
      duplicate_records: Number(capture.duplicateReviewCount || 0),
      endpoint_pagination_complete: capture.endpointPaginationComplete,
      skip_coverage_complete: capture.skipCoverageComplete
    } : null
  };
}

function isTravelokaReview(review) {
  if (!review || typeof review !== 'object') return false;
  const provider = String(review.reviewProvider || review.reviewOrigin || '').toUpperCase();
  return provider === 'TRAVELOKA' || (
    Object.prototype.hasOwnProperty.call(review, 'reviewTimestamp') &&
    Object.prototype.hasOwnProperty.call(review, 'reviewScore') &&
    Object.prototype.hasOwnProperty.call(review, 'reviewContentText') &&
    review.reviewer && typeof review.reviewer === 'object'
  );
}

function dateFromParts(parts) {
  if (!parts || typeof parts !== 'object') return '';
  const y = Number(parts.year); const m = Number(parts.month); const d = Number(parts.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function epochDateTime(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{10,13}$/.test(raw)) return { date: normalizeDateValue(raw) || raw, datetime: '', utc: '' };
  const ms = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return { date: raw, datetime: '', utc: '' };
  return { date: normalizeDateValue(raw), datetime: formatScrapedAt(date), utc: date.toISOString() };
}

function additionalLabel(review) {
  const info = review?.reviewAdditionalInformation;
  if (!info || typeof info !== 'object') return '';
  return String(info?.topSection?.additionalInformationLabel || info?.bottomSection?.additionalInformationLabel || '').trim();
}

function flattenTravelokaReview(review, context = {}) {
  const timestamp = epochDateTime(review.reviewTimestamp);
  const reviewer = review.reviewer && typeof review.reviewer === 'object' ? review.reviewer : {};
  const reply = review.reviewReply && typeof review.reviewReply === 'object' ? review.reviewReply : {};
  const media = Array.isArray(review.reviewMedia) ? review.reviewMedia : [];
  const reaction = review.reactionSummary && typeof review.reactionSummary === 'object' ? review.reactionSummary : {};
  const scrapedAt = context.capturedAt || context.importedAt || new Date();
  return sanitizeExportRow({
    review_id: String(review.reviewId ?? ''),
    review_subject: String(context.objectName || ''),
    reviewer_id: reviewer.reviewerId == null ? '' : String(reviewer.reviewerId),
    reviewer_name: String(reviewer.reviewerName ?? ''),
    reviewer_status: String(reviewer.reviewerStatus ?? ''),
    review_date: timestamp.date,
    review_datetime: timestamp.datetime,
    review_datetime_utc: timestamp.utc,
    review_timestamp: String(review.reviewTimestamp ?? ''),
    rating_score: review.reviewScore == null || !Number.isFinite(Number(review.reviewScore)) ? '' : Number(review.reviewScore),
    rating_max: review.reviewMaxScore == null || !Number.isFinite(Number(review.reviewMaxScore)) ? '' : Number(review.reviewMaxScore),
    review_text: String(review.reviewContentText ?? ''),
    review_original_text: String(review.reviewOriginalText ?? ''),
    translation_status: String(review.translationStatus ?? ''),
    travel_type: additionalLabel(review),
    reaction_count: reaction.reactionCount == null ? '' : String(reaction.reactionCount),
    review_reply_name: String(reply.replierName ?? ''),
    review_reply_text: String(reply.reviewReplyText ?? ''),
    review_reply_original_text: String(reply.reviewReplyOriginalText ?? ''),
    review_reply_date: dateFromParts(reply.reviewReplySubmissionTime),
    review_reply_translation_status: String(reply.reviewReplyTranslationStatus ?? ''),
    media_count: media.length,
    media_urls: media.map(item => item?.reviewMediaUrl).filter(Boolean).join(' | '),
    media_types: [...new Set(media.map(item => String(item?.reviewMediaType || '').trim()).filter(Boolean))].join(' | '),
    media_categories: [...new Set(media.map(item => String(item?.reviewMediaCategory || '').trim()).filter(Boolean))].join(' | '),
    product_type: String(review.productType ?? ''),
    review_origin: String(review.reviewOrigin ?? ''),
    review_provider: String(review.reviewProvider ?? ''),
    _page: context.page || 1,
    _sourceType: context.sourceType || 'xhr-json',
    _sourceAdapter: 'traveloka-getReviews',
    _sourceFile: context.sourceFile || '',
    _sourceResponseIndex: context.responseIndex || 1,
    ...(context.objectName ? { _objectName: context.objectName } : {}),
    _sourceUrl: context.sourceUrl || '',
    _capturedAt: formatScrapedAt(scrapedAt),
    _scrapedAt: formatScrapedAt(scrapedAt)
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isGenericIdentity(value = '') {
  return /^(?:proyek baru|new project|proyek|project|impor xhr json|impor har)$/i.test(String(value || '').trim());
}

function inspectNetworkFiles(filePaths, options = {}) {
  const sorted = [...new Set((filePaths || []).map(value => path.resolve(String(value))))].sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  if (!sorted.length) throw new Error('Pilih minimal satu file HAR/JSON/TXT response Network.');

  const loadedFiles = sorted.map(filePath => {
    if (!fs.existsSync(filePath)) throw new Error(`File tidak ditemukan: ${path.basename(filePath)}`);
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const text = fs.readFileSync(filePath, 'utf8');
    if (ext === '.har') {
      let parsed;
      try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (error) { throw new Error(`${path.basename(filePath)} bukan HAR JSON yang valid: ${error.message}`); }
      const har = harObject(parsed);
      if (!har) throw new Error(`${path.basename(filePath)} tidak memiliki struktur HAR log.entries.`);
      return { filePath, stat, sourceFormat: 'har', har, parsedValues: [], capture: null };
    }
    const parsedValues = parseJsonStream(text);
    return { filePath, stat, sourceFormat: 'json', har: null, parsedValues, capture: parsedValues.map(captureMetadata).find(Boolean) || null };
  });

  const harFiles = loadedFiles.filter(item => item.sourceFormat === 'har');
  const jsonFiles = loadedFiles.filter(item => item.sourceFormat === 'json');
  if (harFiles.length && jsonFiles.length) throw new Error('Jangan campur HAR dan JSON dalam satu impor. Pilih salah satu jenis sumber agar provenance tetap jelas.');

  const projectSite = String(options.project?.siteProfile || 'traveloka');
  const importedAt = new Date();
  if (harFiles.length) {
    const inspected = inspectHarLoadedFiles(harFiles, options);
    const selected = inspected.selected;
    if (!selected) throw new Error('HAR tidak memiliki kandidat sumber review yang dapat diproses.');
    const { candidate, population, coverage } = selected;
    const siteProfile = ['traveloka','tiket','agoda','trip','booking'].includes(String(selected.platform || '').toLowerCase()) ? String(selected.platform).toLowerCase() : 'traveloka';
    let sourceContext = { ...selected.sourceContext };
    let datasetMetadata = JSON.parse(JSON.stringify(selected.datasetMetadata || {}));
    const manualUrl = String(options.sourceUrl || '').trim();
    if (options.allowSourceUrlOverride === true && isHttpSourceUrl(manualUrl) && sourceUrlMatchesSite(manualUrl, siteProfile)) {
      const corrected = resolveSourceContext({ url: manualUrl, preferredObjectName: sourceContext.objectName || '' });
      sourceContext = {
        ...sourceContext,
        sourceUrl: manualUrl,
        canonicalUrl: siteProfile === 'tiket' ? canonicalTiketHotelUrl(manualUrl) : (corrected.canonicalUrl || manualUrl),
        detectedBy: 'har-network+manual-url'
      };
      datasetMetadata.source_url = manualUrl;
      datasetMetadata.source_url_canonical = sourceContext.canonicalUrl;
    }

    let records = [];
    const rows = [];
    const rawRows = [];
    let lastHasNext = null;
    if (selected.adapter === 'tiket-internalReview') {
      records = [...(candidate.logicalRecords || chooseTiketLogicalPages(candidate.reviewRecords || []))].sort((a,b)=>Number(a.page)-Number(b.page)||a.entryIndex-b.entryIndex);
      records.forEach((record,index)=>{ const capturedAt=new Date(record?.entry?.startedDateTime||record.loaded.stat.mtime); tiketReviewData(record.body).reviews.filter(isTiketReview).forEach(review=>rows.push(flattenTiketReview(review,{ page:Number(record.page),responseIndex:index+1,sourceFile:path.basename(record.loaded.filePath),sourceUrl:sourceContext.sourceUrl,objectName:sourceContext.objectName,entityType:sourceContext.entityType,sourceType:'har-network',capturedAt:Number.isNaN(capturedAt.getTime())?record.loaded.stat.mtime:capturedAt,importedAt }))); });
    } else if (selected.adapter === 'agoda-ReviewComments') {
      records = [...(candidate.logicalRecords || pageRecordsByNumber(candidate.reviewRecords || [], agodaComments))].sort((a,b)=>Number(a.page)-Number(b.page)||a.entryIndex-b.entryIndex);
      const nativeProviderId = String(candidate.nativeProviderId || datasetMetadata.native_provider_id || '332');
      records.forEach((record,index)=>{
        const capturedAt=new Date(record?.entry?.startedDateTime||record.loaded.stat.mtime);
        const context={ page:Number(record.page),responseIndex:index+1,sourceFile:path.basename(record.loaded.filePath),sourceUrl:sourceContext.sourceUrl,objectName:sourceContext.objectName,entityType:sourceContext.entityType,sourceType:'har-network',capturedAt:Number.isNaN(capturedAt.getTime())?record.loaded.stat.mtime:capturedAt,importedAt };
        agodaComments(record.body).forEach(review=>{
          const flattened=flattenAgodaReview(review,context);
          rawRows.push(flattened);
          if(agodaIsNativeReview(review,nativeProviderId)) rows.push(flattened);
        });
      });
    } else if (selected.adapter === 'trip-getHotelCommentInfo') {
      records = [...(candidate.logicalRecords || pageRecordsByNumber(candidate.reviewRecords || [], tripComments))].sort((a,b)=>Number(a.page)-Number(b.page)||a.entryIndex-b.entryIndex);
      records.forEach((record,index)=>{ const capturedAt=new Date(record?.entry?.startedDateTime||record.loaded.stat.mtime); tripComments(record.body).forEach(review=>rows.push(flattenTripReview(review,{ page:Number(record.page),responseIndex:index+1,sourceFile:path.basename(record.loaded.filePath),sourceUrl:sourceContext.sourceUrl,objectName:sourceContext.objectName,entityType:sourceContext.entityType,sourceType:'har-network',capturedAt:Number.isNaN(capturedAt.getTime())?record.loaded.stat.mtime:capturedAt,importedAt }))); });
    } else if (selected.adapter === 'booking-ReviewList') {
      records = [...(candidate.logicalRecords || bookingRecordsBySkip(candidate.reviewRecords || []))].sort((a,b)=>Number(a.skip)-Number(b.skip)||a.entryIndex-b.entryIndex);
      records.forEach((record,index)=>{ const capturedAt=new Date(record?.entry?.startedDateTime||record.loaded.stat.mtime); bookingReviews(record.body).forEach(review=>rows.push(flattenBookingReview(review,{ page:Number(record.page || (record.limit ? Math.floor(Number(record.skip)/Number(record.limit))+1 : index+1)),responseIndex:index+1,sourceFile:path.basename(record.loaded.filePath),sourceUrl:sourceContext.sourceUrl,objectName:sourceContext.objectName,entityType:sourceContext.entityType,sourceType:'har-network',capturedAt:Number.isNaN(capturedAt.getTime())?record.loaded.stat.mtime:capturedAt,importedAt }))); });
    } else {
      records = [...candidate.reviewRecords].sort((a,b)=>{ const aSkip=Number(a.requestData?.skip),bSkip=Number(b.requestData?.skip); if(Number.isFinite(aSkip)&&Number.isFinite(bSkip)&&aSkip!==bSkip)return aSkip-bSkip; return a.entryIndex-b.entryIndex; });
      records.forEach((record,index)=>{ const reviews=Array.isArray(record?.body?.data?.reviews)?record.body.data.reviews.filter(isTravelokaReview):[]; if(typeof record?.body?.data?.hasNext==='boolean')lastHasNext=record.body.data.hasNext; const capturedAt=new Date(record?.entry?.startedDateTime||record.loaded.stat.mtime); reviews.forEach(review=>rows.push(flattenTravelokaReview(review,{ page:index+1,responseIndex:index+1,sourceFile:path.basename(record.loaded.filePath),sourceUrl:sourceContext.sourceUrl,objectName:sourceContext.objectName,sourceType:'har-network',capturedAt:Number.isNaN(capturedAt.getTime())?record.loaded.stat.mtime:capturedAt,importedAt }))); });
    }

    const files = harFiles.map(loaded => {
      const fileRecords = records.filter(record => record.loaded.filePath === loaded.filePath);
      const reviewCount = fileRecords.reduce((sum,record)=>{
        if(selected.adapter==='tiket-internalReview')return sum+tiketReviewData(record.body).reviews.filter(isTiketReview).length;
        if(selected.adapter==='agoda-ReviewComments')return sum+agodaComments(record.body).length;
        if(selected.adapter==='trip-getHotelCommentInfo')return sum+tripComments(record.body).length;
        if(selected.adapter==='booking-ReviewList')return sum+bookingReviews(record.body).length;
        return sum+(Array.isArray(record?.body?.data?.reviews)?record.body.data.reviews.filter(isTravelokaReview).length:0);
      },0);
      return {
        name: path.basename(loaded.filePath), path: loaded.filePath, size: loaded.stat.size, modifiedAt: loaded.stat.mtime.toISOString(), sha256: sha256File(loaded.filePath),
        responses: fileRecords.length, reviews: reviewCount, sourceFormat: 'har', rawHarStored: false
      };
    });
    const sourceCandidates = inspected.summaries.map(item => {
      const isTiketCandidate = item.adapter === 'tiket-internalReview';
      const isAgodaCandidate = item.adapter === 'agoda-ReviewComments';
      const isTripCandidate = item.adapter === 'trip-getHotelCommentInfo';
      const isBookingCandidate = item.adapter === 'booking-ReviewList';
      const logicalRecords = isTiketCandidate ? (item.candidate.logicalRecords || chooseTiketLogicalPages(item.candidate.reviewRecords || []))
        : isAgodaCandidate ? (item.candidate.logicalRecords || pageRecordsByNumber(item.candidate.reviewRecords || [], agodaComments))
        : isTripCandidate ? (item.candidate.logicalRecords || pageRecordsByNumber(item.candidate.reviewRecords || [], tripComments))
        : isBookingCandidate ? (item.candidate.logicalRecords || bookingRecordsBySkip(item.candidate.reviewRecords || []))
        : item.candidate.reviewRecords;
      return {
        id: item.candidate.id,
        adapter: item.adapter,
        siteProfile: item.platform,
        objectId: item.sourceContext.objectId,
        entityType: item.sourceContext.entityType,
        objectName: item.sourceContext.objectName,
        siteName: item.sourceContext.siteName || (isTiketCandidate ? 'Tiket' : isAgodaCandidate ? 'Agoda' : isTripCandidate ? 'Trip' : isBookingCandidate ? 'Booking' : 'Traveloka'),
        sourceUrl: item.sourceContext.sourceUrl,
        sourceEntityUrl: item.sourceContext.sourceEntityUrl || '',
        sourceReviewUrl: item.sourceContext.sourceReviewUrl || '',
        canonicalUrl: item.sourceContext.canonicalUrl,
        responseCount: logicalRecords.length,
        rawResponseOccurrences: Array.isArray(item.candidate.reviewRecords) ? item.candidate.reviewRecords.length : logicalRecords.length,
        totalReviews: item.population.raw,
        rawCapturedReviews: Number(item.rawPopulation?.raw ?? item.population.raw),
        uniqueReviews: item.population.unique,
        textReviews: item.population.withText,
        emptyTextReviews: item.population.withoutText,
        filter: (isTiketCandidate || isAgodaCandidate || isTripCandidate || isBookingCandidate) ? (item.candidate.requestConfig || {}) : (item.coverage.filter || {}),
        requestConfig: item.candidate.requestConfig || {},
        lastHasNext: (isTiketCandidate || isAgodaCandidate || isTripCandidate || isBookingCandidate) ? null : item.coverage.lastHasNext,
        lastPage: item.coverage.lastPage ?? item.coverage.last ?? null,
        paginationComplete: item.datasetMetadata?.pagination?.complete === true,
        apiReportedCount: item.datasetMetadata?.api_reported_count ?? null,
        datasetMetadata: item.datasetMetadata
      };
    });
    const effectiveRawRows = selected.adapter === 'agoda-ReviewComments' ? rawRows : rows;
    return {
      adapter: selected.adapter, platform: siteProfile, sourceType: 'har', rows, rawRows: effectiveRawRows, files,
      responseCount: records.length, rawResponseOccurrences: Array.isArray(candidate.reviewRecords) ? candidate.reviewRecords.length : records.length,
      totalReviews: effectiveRawRows.length, canonicalSourceReviews: rows.length, uniqueSourceReviews: population.unique,
      textReviewCount: population.withText, emptyTextReviewCount: population.withoutText, sourceDuplicateReviewIds: population.duplicateIds,
      lastHasNext: selected.adapter === 'traveloka-getReviews' ? (coverage.lastHasNext ?? lastHasNext) : null,
      captureMetadata: null, datasetMetadata,
      sourceCandidates, selectedSourceId: candidate.id, sourceContext, importedAt: importedAt.toISOString()
    };
  }

  const explicitUrl = String(options.sourceUrl || '').trim();
  const savedUrl = String(options.project?.source?.sourceUrl || options.project?.startUrl || '').trim();
  const capture = loadedFiles.map(item => item.capture).find(Boolean) || null;
  const capturedUrl = String(capture?.sourceUrl || '').trim();
  const candidateUrl = isHttpSourceUrl(explicitUrl) && sourceUrlMatchesSite(explicitUrl, projectSite) ? explicitUrl
    : (isHttpSourceUrl(savedUrl) && sourceUrlMatchesSite(savedUrl, projectSite) ? savedUrl
      : (isHttpSourceUrl(capturedUrl) && sourceUrlMatchesSite(capturedUrl, projectSite) ? capturedUrl : ''));
  const sourceResolved = resolveSourceContext({ url: candidateUrl, title: capture?.pageTitle || '', preferredObjectName: options.project?.source?.objectName || options.project?.reviewSubject || '' });
  const requestedIdentity = String(options.project?.reviewSubject || options.project?.source?.objectName || '').trim();
  const objectName = (!requestedIdentity || isGenericIdentity(requestedIdentity)) ? (sourceResolved.objectName || '') : requestedIdentity;
  const sourceUrl = isHttpSourceUrl(sourceResolved.sourceUrl) && sourceUrlMatchesSite(sourceResolved.sourceUrl, projectSite) ? sourceResolved.sourceUrl : candidateUrl;

  const jsonResponses = loadedFiles.flatMap(item => item.parsedValues.flatMap(responseCandidates));
  const capturePlatform = String(capture?.platform || capture?.datasetMetadata?.platform || '').toLowerCase();
  const looksLikeTiketJson = capturePlatform === 'tiket' || /tiket\.com/i.test(sourceUrl) || jsonResponses.some(body => tiketReviewData(body).reviews.some(isTiketReview));
  if (looksLikeTiketJson) {
    const logical = new Map();
    for (const body of jsonResponses) {
      const info = tiketReviewData(body);
      if (!info.reviews.some(isTiketReview)) continue;
      const page = Number(info.userReviews.number);
      const key = Number.isFinite(page) ? page : logical.size;
      const previous = logical.get(key);
      if (!previous || info.reviews.length > tiketReviewData(previous).reviews.length || info.userReviews.last === true) logical.set(key, body);
    }
    const orderedBodies = [...logical.entries()].sort((a,b)=>a[0]-b[0]);
    if (!orderedBodies.length) throw new Error('JSON Capture Tiket tidak berisi response internalReview yang dikenali.');
    const tiketIdentity = tiketIdentityFromUrl(sourceUrl);
    const rows = [];
    for (const [page, body] of orderedBodies) {
      const info = tiketReviewData(body);
      info.reviews.filter(isTiketReview).forEach((review, index) => rows.push(flattenTiketReview(review, {
        page, responseIndex:index + 1, sourceFile:loadedFiles[0]?.filePath ? path.basename(loadedFiles[0].filePath) : '',
        sourceUrl, objectName, entityType:'HOTEL', sourceType:capture ? 'mydataset-capture-json' : 'network-json',
        capturedAt:capture?.capturedAt ? new Date(capture.capturedAt) : importedAt, importedAt
      })));
    }
    const records = orderedBodies.map(([page, body]) => ({ page, body }));
    const population = tiketPopulationStats(records);
    const firstInfo = tiketReviewData(orderedBodies[0][1]).userReviews;
    const lastInfo = tiketReviewData(orderedBodies[orderedBodies.length - 1][1]).userReviews;
    const totalPages = Number(firstInfo.totalPages ?? lastInfo.totalPages);
    const totalElements = Number(firstInfo.totalElements ?? lastInfo.totalElements);
    const pages = orderedBodies.map(([page])=>page).filter(Number.isFinite);
    const missingPages = [];
    if (Number.isFinite(totalPages) && totalPages > 0) for (let page=0; page<totalPages; page+=1) if (!logical.has(page)) missingPages.push(page);
    const complete = Number.isFinite(totalPages) && totalPages > 0 && missingPages.length === 0 && lastInfo.last === true;
    const files = loadedFiles.map(loaded => ({
      name:path.basename(loaded.filePath), path:loaded.filePath, size:loaded.stat.size, modifiedAt:loaded.stat.mtime.toISOString(), sha256:sha256File(loaded.filePath),
      responses:orderedBodies.length, reviews:rows.length, sourceFormat:loaded.capture ? 'capture-json' : 'json', capture:loaded.capture || undefined
    }));
    const sourceContext = {
      objectName, siteName:'Tiket', sourceUrl, canonicalUrl:canonicalTiketHotelUrl(sourceUrl),
      objectId:tiketIdentity.inventoryId || '', entityType:'HOTEL', detectedBy:capture ? 'mydataset-capture' : 'network-json'
    };
    const datasetMetadata = {
      ...(capture?.datasetMetadata && typeof capture.datasetMetadata === 'object' ? JSON.parse(JSON.stringify(capture.datasetMetadata)) : {}),
      platform:'Tiket', source_format:capture ? 'MyDataset Capture JSON' : 'Network JSON', entity:objectName,
      entity_type:'HOTEL', entity_id:sourceContext.objectId, source_url:sourceUrl,
      api_reported_count:Number.isFinite(totalElements) ? totalElements : null,
      retrieved_records:rows.length, unique_records:population.unique, text_records:population.withText, empty_text_records:population.withoutText,
      pagination:{ first_page:pages[0] ?? null, last_page:pages.at(-1) ?? null, total_pages:Number.isFinite(totalPages)?totalPages:null, request_count:orderedBodies.length, missing_pages:missingPages.length, missing_page_values:missingPages, last:lastInfo.last ?? null, complete }
    };
    return {
      adapter:'tiket-internalReview', platform:'tiket', sourceType:capture ? 'capture-json' : 'json', rows, files,
      responseCount:orderedBodies.length, rawResponseOccurrences:jsonResponses.length, totalReviews:rows.length, uniqueSourceReviews:population.unique,
      textReviewCount:population.withText, emptyTextReviewCount:population.withoutText, sourceDuplicateReviewIds:population.duplicateIds,
      lastHasNext:null, captureMetadata:capture, datasetMetadata,
      sourceCandidates:[{ id:'json_tiket_source', objectId:sourceContext.objectId, entityType:'HOTEL', objectName, siteName:'Tiket', sourceUrl, canonicalUrl:sourceContext.canonicalUrl, responseCount:orderedBodies.length, totalReviews:rows.length, uniqueReviews:population.unique, textReviews:population.withText, emptyTextReviews:population.withoutText, paginationComplete:complete }],
      selectedSourceId:'json_tiket_source', sourceContext, importedAt:importedAt.toISOString()
    };
  }

  const identity = travelokaIdentityFromUrl(sourceUrl);
  const rows = []; const files = [];
  let globalPage = 0; let responseCount = 0; let lastHasNext = null;
  for (const loaded of loadedFiles) {
    const { filePath, stat, parsedValues } = loaded;
    const responses = parsedValues.flatMap(responseCandidates);
    if (!responses.length) throw new Error(`${path.basename(filePath)} tidak berisi struktur response review yang dikenali.`);
    let fileReviews = 0; let fileTraveloka = 0; let fileResponseCount = 0;
    for (const response of responses) {
      const reviews = Array.isArray(response?.data?.reviews) ? response.data.reviews : [];
      const recognized = reviews.filter(isTravelokaReview);
      if (!recognized.length && reviews.length) continue;
      if (!reviews.length) continue;
      globalPage += 1; responseCount += 1; fileResponseCount += 1; fileReviews += recognized.length; fileTraveloka += recognized.length;
      lastHasNext = typeof response?.data?.hasNext === 'boolean' ? response.data.hasNext : lastHasNext;
      const capturedAt = loaded.capture?.capturedAt ? new Date(loaded.capture.capturedAt) : stat.mtime;
      for (const review of recognized) rows.push(flattenTravelokaReview(review, {
        page: globalPage, responseIndex: fileResponseCount, sourceFile: path.basename(filePath), sourceUrl, objectName,
        sourceType: loaded.capture ? 'mydataset-capture-json' : 'network-json',
        capturedAt: Number.isNaN(capturedAt.getTime()) ? stat.mtime : capturedAt, importedAt
      }));
    }
    if (!fileTraveloka) throw new Error(`${path.basename(filePath)} memiliki response, tetapi bukan struktur Traveloka getReviews yang didukung.`);
    files.push({ name: path.basename(filePath), path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: sha256File(filePath), responses: fileResponseCount, reviews: fileReviews, sourceFormat: loaded.capture ? 'capture-json' : 'json', capture: loaded.capture || undefined });
  }
  const responses = loadedFiles.flatMap(item => item.parsedValues.flatMap(responseCandidates));
  const population = reviewPopulationStats(responses);
  const sourceContext = { objectName, siteName: sourceResolved.siteName || 'Traveloka', sourceUrl, canonicalUrl: sourceResolved.canonicalUrl || sourceUrl, objectId: identity.objectId, entityType: identity.entityType || 'HOTEL', detectedBy: capture ? 'mydataset-capture' : 'network-json' };
  const baseMeta = capture?.datasetMetadata && typeof capture.datasetMetadata === 'object' ? JSON.parse(JSON.stringify(capture.datasetMetadata)) : {};
  const datasetMetadata = {
    ...baseMeta,
    source_format: capture ? 'MyDataset Capture JSON' : 'Network JSON',
    entity: baseMeta.entity || objectName,
    entity_type: baseMeta.entity_type || sourceContext.entityType,
    entity_id: baseMeta.entity_id || sourceContext.objectId,
    source_url: baseMeta.source_url || sourceUrl,
    unique_records: baseMeta.unique_records ?? population.unique,
    retrieved_records: baseMeta.retrieved_records ?? population.raw,
    text_records: baseMeta.text_records ?? population.withText,
    empty_text_records: baseMeta.empty_text_records ?? population.withoutText,
    format_distribution: {
      ...(baseMeta.format_distribution || {}),
      requested_format: baseMeta?.format_distribution?.requested_format || baseMeta?.filter?.format || '',
      all_unique_records: baseMeta.unique_records ?? population.unique,
      with_text: baseMeta.text_records ?? population.withText,
      without_text: baseMeta.empty_text_records ?? population.withoutText
    }
  };
  return {
    adapter: 'traveloka-getReviews', sourceType: capture ? 'capture-json' : 'json', rows, files, responseCount, totalReviews: rows.length,
    uniqueSourceReviews: population.unique, textReviewCount: population.withText, emptyTextReviewCount: population.withoutText, sourceDuplicateReviewIds: population.duplicateIds,
    lastHasNext, captureMetadata: capture, datasetMetadata,
    sourceCandidates: [{ id: 'json_source', objectId: sourceContext.objectId, entityType: sourceContext.entityType, objectName, siteName: 'Traveloka', sourceUrl, canonicalUrl: sourceContext.canonicalUrl, responseCount, totalReviews: rows.length, uniqueReviews: population.unique, textReviews: population.withText, emptyTextReviews: population.withoutText, filter: datasetMetadata.filter || {}, lastHasNext, paginationComplete: datasetMetadata?.pagination?.complete === true }],
    selectedSourceId: 'json_source', sourceContext, importedAt: importedAt.toISOString()
  };
}

function copySourceFiles(runDir, files) {
  const targetDir = path.join(runDir, 'source-input');
  fs.mkdirSync(targetDir, { recursive: true });
  return files.map((item, index) => {
    if (String(item.sourceFormat || '').toLowerCase() === 'har') {
      const descriptorName = `${String(index + 1).padStart(3, '0')}-${item.name}.sha256.txt`;
      const descriptorPath = path.join(targetDir, descriptorName);
      const descriptor = [
        'MyDataset HAR provenance descriptor',
        `original_name=${item.name}`,
        `size_bytes=${Number(item.size || 0)}`,
        `modified_at=${item.modifiedAt || ''}`,
        `sha256=${item.sha256 || ''}`,
        'raw_har_stored=false',
        'privacy_note=HAR mentah tidak disalin otomatis karena dapat memuat Cookie/Authorization/session header. Simpan file HAR asli secara terpisah jika diperlukan untuk audit internal.'
      ].join('\n');
      fs.writeFileSync(descriptorPath, `${descriptor}\n`, 'utf8');
      return { ...item, storedAs: path.relative(runDir, descriptorPath).replace(/\\/g, '/'), rawHarStored: false };
    }
    const targetName = `${String(index + 1).padStart(3, '0')}-${item.name}`;
    const targetPath = path.join(targetDir, targetName);
    fs.copyFileSync(item.path, targetPath);
    return { ...item, storedAs: path.relative(runDir, targetPath).replace(/\\/g, '/') };
  });
}

module.exports = {
  parseJsonStream,
  responseCandidates,
  isTravelokaReview,
  flattenTravelokaReview,
  isTiketReview,
  flattenTiketReview,
  tiketPopulationStats,
  tiketCoverage,
  bookingReviews,
  flattenBookingReview,
  bookingPopulationStats,
  bookingCoverage,
  inspectNetworkFiles,
  copySourceFiles,
  finalDatasetMetadata,
  dateFromParts,
  epochDateTime,
  endpointLeaf,
  travelokaIdentityFromUrl,
  tiketIdentityFromUrl,
  reviewPopulationStats,
  coverageFromHarRecords,
  requestFilterSignature,
  requestConfigSignature
};
