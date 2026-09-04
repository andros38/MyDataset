(function(global){
  'use strict';

  const EXTENSION_VERSION = '1.0.0';
  const SCHEMA_VERSION = 5;

  function safeFilePart(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'capture';
  }

  function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, '') || 'capture'; } catch { return 'capture'; }
  }

  function localStamp(date = new Date()) {
    const two = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${two(date.getMonth()+1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  }

  function endpointName(records, fallback = 'review-network') {
    for (const record of records || []) {
      try {
        const path = new URL(record?.url || '').pathname.split('/').filter(Boolean);
        const candidate = path[path.length - 1];
        if (candidate) return safeFilePart(candidate);
      } catch {}
    }
    return safeFilePart(fallback || 'review-network');
  }

  function summarizeRecords(records) {
    const core = global.MyDatasetCaptureCore;
    const seenReviews = new Set();
    const perRecord = [];
    let rawReviewCount = 0;
    let uniqueReviewCount = 0;
    let duplicateReviewCount = 0;

    (records || []).forEach((record, index) => {
      const reviews = core.reviewsIn(record?.body);
      let newUnique = 0;
      let duplicates = 0;
      for (const review of reviews) {
        const key = core.reviewIdentity(review);
        // A review without a stable identity is retained and counted as unique.
        if (!key) {
          newUnique += 1;
          uniqueReviewCount += 1;
          continue;
        }
        if (seenReviews.has(key)) {
          duplicates += 1;
          duplicateReviewCount += 1;
        } else {
          seenReviews.add(key);
          newUnique += 1;
          uniqueReviewCount += 1;
        }
      }
      rawReviewCount += reviews.length;
      perRecord.push({
        sequence: index + 1,
        rawReviewCount: reviews.length,
        uniqueNewReviewCount: newUnique,
        duplicateReviewCount: duplicates,
        hasNext: typeof record?.hasNext === 'boolean' ? record.hasNext : core.hasNextIn(record?.body)
      });
    });

    const lastPaginationRecord = [...(records || [])].reverse().find(item => typeof item?.hasNext === 'boolean');
    const lastHasNext = lastPaginationRecord ? lastPaginationRecord.hasNext : null;
    return {
      responseCount: (records || []).length,
      rawReviewCount,
      uniqueReviewCount,
      duplicateReviewCount,
      lastHasNext,
      endpointPaginationComplete: lastHasNext === false,
      perRecord
    };
  }

  function dedupeResponseBodies(records) {
    const core = global.MyDatasetCaptureCore;
    const seenReviews = new Set();
    return (records || []).map(record => {
      let clone;
      try { clone = JSON.parse(JSON.stringify(record?.body)); } catch { clone = record?.body; }
      const walk = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 12) return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item, depth + 1);
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          if (Array.isArray(child) && (key === 'reviews' || (key === 'content' && child.some(item => item && typeof item === 'object' && item.submitId != null && item.ratingSummary != null)))) {
            value[key] = child.filter(review => {
              const identity = core.reviewIdentity(review);
              if (!identity) return true;
              if (seenReviews.has(identity)) return false;
              seenReviews.add(identity);
              return true;
            });
          } else if (child && typeof child === 'object') {
            walk(child, depth + 1);
          }
        }
      };
      walk(clone, 0);
      return clone;
    });
  }

  function requestMeta(record, sequence, rawFile) {
    return {
      sequence,
      rawFile,
      url: String(record?.url || ''),
      method: String(record?.method || 'GET'),
      status: Number(record?.status || 0),
      mimeType: String(record?.mimeType || ''),
      startedDateTime: String(record?.startedDateTime || ''),
      capturedAt: String(record?.capturedAt || ''),
      reviewCount: Number(record?.reviewCount || 0),
      hasNext: typeof record?.hasNext === 'boolean' ? record.hasNext : null,
      fromScan: Boolean(record?.fromScan),
      responseBytes: Number(record?.responseBytes || 0),
      requestBodyAvailable: Boolean(record?.requestBodyAvailable || record?.request?.available),
      request: record?.request || { mimeType:'', text:'', json:null, form:null, available:false, query:{} },
      requestHash: String(record?.requestHash || ''),
      responseHash: String(record?.responseHash || ''),
      fingerprint: String(record?.fingerprint || '')
    };
  }

  function acquisitionCoverage(records) {
    const pages = (records || []).map((record, index) => {
      const data = record?.request?.json?.data || {};
      const skip = Number(data?.skip);
      const limit = Number(data?.limit);
      return {
        sequence:index + 1,
        skip:Number.isFinite(skip) ? skip : null,
        limit:Number.isFinite(limit) ? limit : null,
        returned:Number(record?.reviewCount || 0)
      };
    }).filter(item => item.skip != null && item.limit != null && item.limit > 0);
    if (!pages.length) return { available:false, contiguous:null, firstSkip:null, lastSkip:null, nominalLimit:null, missingSkips:[] };
    const ordered = [...pages].sort((a,b) => a.skip - b.skip || a.sequence - b.sequence);
    const uniqueSkips = [...new Set(ordered.map(item => item.skip))].sort((a,b) => a-b);
    const nominalLimit = ordered[0].limit;
    const missingSkips = [];
    if (uniqueSkips.length) {
      for (let expected = uniqueSkips[0]; expected <= uniqueSkips[uniqueSkips.length - 1]; expected += nominalLimit) {
        if (!uniqueSkips.includes(expected)) missingSkips.push(expected);
        if (missingSkips.length >= 100) break;
      }
    }
    const duplicateSkips = ordered.length - uniqueSkips.length;
    const filters = records?.[0]?.request?.json?.data || {};
    return {
      available:true,
      contiguous:missingSkips.length === 0 && duplicateSkips === 0,
      firstSkip:uniqueSkips[0],
      lastSkip:uniqueSkips[uniqueSkips.length - 1],
      nominalLimit,
      requestCount:ordered.length,
      duplicateSkipCount:duplicateSkips,
      missingSkips,
      objectId:filters.objectId ?? null,
      configId:filters.configId ?? null,
      origin:filters.origin ?? null,
      sort:filters.sort ?? null,
      filter:filters.filter ?? null
    };
  }

  function tiketCoverage(records) {
    const pages = new Map();
    let totalPages = null;
    let totalElements = null;
    let last = null;
    for (const record of records || []) {
      const userReviews = record?.body?.data?.userReviews || record?.body?.userReviews || {};
      const page = Number(userReviews.number);
      const size = Number(userReviews.size);
      if (Number.isFinite(page)) {
        const previous = pages.get(page);
        const returned = Array.isArray(userReviews.content) ? userReviews.content.length : Number(record?.reviewCount || 0);
        if (!previous || returned > previous.returned || userReviews.last === true) pages.set(page, { page, size:Number.isFinite(size)?size:null, returned, last:userReviews.last === true });
      }
      const tp = Number(userReviews.totalPages); if (Number.isFinite(tp)) totalPages = tp;
      const te = Number(userReviews.totalElements); if (Number.isFinite(te)) totalElements = te;
      if (typeof userReviews.last === 'boolean' && userReviews.last) last = true;
    }
    const ordered=[...pages.keys()].sort((a,b)=>a-b);
    const missing=[];
    if (Number.isFinite(totalPages) && totalPages > 0) for(let page=0;page<totalPages;page+=1) if(!pages.has(page)) missing.push(page);
    const complete=Number.isFinite(totalPages) && totalPages>0 && missing.length===0 && last===true;
    return { available:ordered.length>0, complete, firstPage:ordered[0]??null, lastPage:ordered.at(-1)??null, totalPages, totalElements, requestCount:ordered.length, missingPages:missing, last };
  }

  function finiteCount(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function recordRequestData(record) {
    const json = record?.request?.json;
    if (!json || typeof json !== 'object') return {};
    const data = json.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : json;
  }

  function sourceAggregateSummary(records) {
    const core = global.MyDatasetCaptureCore;
    let aggregateTotal = null;
    let aggregateTraveloka = null;
    let aggregateOther = null;
    let aggregateOtherProvider = '';
    let entity = '';
    let availableRecord = null;
    let summaryRecord = null;

    for (const record of records || []) {
      const endpoint = core.endpointLeaf(record?.url || '');
      const body = record?.body;
      if (!body || typeof body !== 'object') continue;
      if (endpoint === 'getAvailableReviewWithAggregate') {
        const data = body?.data || {};
        const traveloka = data?.traveloka || {};
        const other = data?.other || {};
        const travelokaCount = finiteCount(traveloka?.count);
        const otherCount = finiteCount(other?.count);
        if (travelokaCount != null) aggregateTraveloka = travelokaCount;
        if (otherCount != null) aggregateOther = otherCount;
        if (traveloka?.objectName) entity = String(traveloka.objectName);
        else if (other?.objectName) entity = String(other.objectName);
        if (other?.provider) aggregateOtherProvider = String(other.provider);
        availableRecord = record;
      }
      if (endpoint === 'getReviewAggregateSummary') {
        const reviewAggregate = body?.data?.reviewAggregate || {};
        const direct = finiteCount(reviewAggregate?.count);
        if (direct != null) aggregateTotal = direct;
        if (reviewAggregate?.objectName) entity = String(reviewAggregate.objectName);
        summaryRecord = record;
      }
    }

    const sumOfSources = aggregateTraveloka != null && aggregateOther != null
      ? aggregateTraveloka + aggregateOther
      : null;
    if (aggregateTotal == null && sumOfSources != null) aggregateTotal = sumOfSources;

    return {
      aggregateTotal,
      aggregateTraveloka,
      aggregateOther,
      aggregateOtherProvider,
      entity,
      sumOfSources,
      consistent: aggregateTotal == null || sumOfSources == null ? null : aggregateTotal === sumOfSources,
      evidence: {
        availableReviewWithAggregate: Boolean(availableRecord),
        reviewAggregateSummary: Boolean(summaryRecord)
      }
    };
  }

  function countEndpointSummary(records) {
    const core = global.MyDatasetCaptureCore;
    let reportedCount = null;
    let requestFilter = null;
    let requestOrigin = null;
    let requestCount = 0;
    let recordIndex = null;

    (records || []).forEach((record, index) => {
      if (core.endpointLeaf(record?.url || '') !== 'getReviewCount') return;
      requestCount += 1;
      const count = core.countValueIn(record?.body);
      if (count != null) {
        reportedCount = count;
        recordIndex = index + 1;
      }
      const data = recordRequestData(record);
      if (data?.filter && typeof data.filter === 'object') requestFilter = { ...data.filter };
      if (data?.origin != null && String(data.origin).trim()) requestOrigin = String(data.origin);
    });

    return { reportedCount, requestFilter, requestOrigin, requestCount, recordIndex };
  }

  function buildDatasetMetadata(meta, stats, diagnostics, coverage) {
    const platform = String(meta?.platform || 'Traveloka');
    if (/tiket/i.test(platform)) {
      const uniqueRecords = Number(stats?.uniqueReviewCount || 0);
      const reported = coverage?.totalElements == null ? null : Number(coverage.totalElements);
      return {
        schemaVersion:1,
        platform:'Tiket',
        entity:String(meta?.pageTitle || '').trim(),
        page_title:String(meta?.pageTitle || ''),
        source_url:String(meta?.sourceUrl || ''),
        api_reported_count:reported,
        retrieved_records:Number(stats?.rawReviewCount || 0),
        unique_records:uniqueRecords,
        pagination:{ first_page:coverage?.firstPage??null, last_page:coverage?.lastPage??null, total_pages:coverage?.totalPages??null, request_count:coverage?.requestCount??Number(stats?.responseCount||0), missing_pages:Array.isArray(coverage?.missingPages)?coverage.missingPages.length:null, missing_page_values:Array.isArray(coverage?.missingPages)?coverage.missingPages:[], last:coverage?.last??null, complete:coverage?.complete===true },
        count_discrepancy:{ reported_vs_retrieved:reported==null?null:reported-uniqueRecords, cause:reported==null?'count not available':(reported===uniqueRecords?'no discrepancy observed':'not established by public API response') },
        coverage_claim:coverage?.complete===true?'complete_observed_internalReview_pagination':'incomplete_observed_internalReview_pagination',
        population_complete_claim:false,
        evidence:{ capture_extension_version:EXTENSION_VERSION, internalReview_response_count:Number(stats?.responseCount||0) }
      };
    }
    const aggregate = diagnostics?.aggregate || {};
    const countInfo = diagnostics?.countEndpoint || {};
    const selectedFilter = coverage?.filter && typeof coverage.filter === 'object'
      ? { ...coverage.filter }
      : (countInfo.requestFilter && typeof countInfo.requestFilter === 'object' ? { ...countInfo.requestFilter } : {});
    const paginationEvidenceAvailable = Boolean(coverage?.available);
    const observedComplete = stats?.lastHasNext === false && (!paginationEvidenceAvailable || coverage?.contiguous === true);
    const uniqueRecords = Number(stats?.uniqueReviewCount || 0);
    const reported = countInfo.reportedCount == null ? null : Number(countInfo.reportedCount);
    const difference = reported == null ? null : reported - uniqueRecords;
    const pageTitle = String(meta?.pageTitle || '');

    return {
      schemaVersion: 1,
      platform: 'Traveloka',
      entity: String(aggregate.entity || '').trim(),
      page_title: pageTitle,
      source_url: String(meta?.sourceUrl || ''),
      aggregate_total: aggregate.aggregateTotal ?? null,
      aggregate_traveloka: aggregate.aggregateTraveloka ?? null,
      aggregate_other: aggregate.aggregateOther ?? null,
      aggregate_other_provider: String(aggregate.aggregateOtherProvider || ''),
      aggregate_consistent: aggregate.consistent ?? null,
      filter: selectedFilter,
      listing_origin: coverage?.origin ?? null,
      count_request_origin: countInfo.requestOrigin ?? null,
      api_reported_text_count: reported,
      retrieved_records: Number(stats?.rawReviewCount || 0),
      unique_records: uniqueRecords,
      pagination: {
        first_skip: coverage?.firstSkip ?? null,
        last_skip: coverage?.lastSkip ?? null,
        limit: coverage?.nominalLimit ?? null,
        request_count: coverage?.requestCount ?? Number(stats?.responseCount || 0),
        missing_offsets: Array.isArray(coverage?.missingSkips) ? coverage.missingSkips.length : null,
        missing_skip_values: Array.isArray(coverage?.missingSkips) ? [...coverage.missingSkips] : [],
        duplicate_offsets: coverage?.duplicateSkipCount ?? null,
        last_has_next: stats?.lastHasNext ?? null,
        complete: observedComplete
      },
      count_discrepancy: {
        reported_vs_retrieved: difference,
        cause: difference === 0 ? 'no discrepancy observed' : 'not established by public API response'
      },
      coverage_claim: observedComplete
        ? 'complete_observed_getReviews_pagination'
        : (stats?.lastHasNext === true ? 'incomplete_observed_getReviews_pagination' : 'terminal_state_not_fully_verified'),
      population_complete_claim: false,
      evidence: {
        capture_extension_version: EXTENSION_VERSION,
        getReviews_response_count: Number(stats?.responseCount || 0),
        diagnostic_endpoint_counts: { ...(diagnostics?.endpoints || {}) },
        aggregate_sources: { ...(aggregate.evidence || {}) },
        count_endpoint_requests: Number(countInfo.requestCount || 0),
        skip_coverage_available: paginationEvidenceAvailable
      }
    };
  }

  function summarizeDiagnostics(records, uniqueReviewCount, platform = 'Traveloka') {
    const core = global.MyDatasetCaptureCore;
    if (!/traveloka/i.test(String(platform || ''))) return { responseCount:0, endpoints:{}, reportedCount:null, reportedCountRecord:null, countDifference:null, countMatches:null, countEndpoint:{}, aggregate:{}, interpretation:'' };
    const list = Array.isArray(records) ? records : [];
    const endpointMap = {};
    list.forEach((record, index) => {
      const endpoint = core.endpointLeaf(record?.url || '') || 'unknown';
      endpointMap[endpoint] = (endpointMap[endpoint] || 0) + 1;
    });
    const countEndpoint = countEndpointSummary(list);
    const aggregate = sourceAggregateSummary(list);
    const reportedCount = countEndpoint.reportedCount;
    const reportedCountRecord = countEndpoint.recordIndex;
    const countDifference = reportedCount == null ? null : Number(reportedCount) - Number(uniqueReviewCount || 0);
    return {
      responseCount:list.length,
      endpoints:endpointMap,
      reportedCount,
      reportedCountRecord,
      countDifference,
      countMatches:reportedCount == null ? null : countDifference === 0,
      countEndpoint,
      aggregate,
      interpretation:reportedCount == null
        ? 'getReviewCount tidak tertangkap; jumlah daftar hanya berdasarkan getReviews.'
        : (countDifference === 0
            ? 'Jumlah getReviewCount sama dengan review unik dari getReviews.'
            : 'Traveloka getReviewCount berbeda dari jumlah review unik yang benar-benar dikembalikan getReviews. Ini dicatat sebagai mismatch API, bukan review yang boleh dibuat/ditaksir oleh ekstensi.')
    };
  }

  function captureMetadata(meta, stats, diagnostics = null, coverage = null, datasetMetadata = null) {
    return {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      capturedAt: String(meta.capturedAt || new Date().toISOString()),
      sourceUrl: String(meta.sourceUrl || ''),
      pageTitle: String(meta.pageTitle || ''),
      platform: String(meta.platform || ''),
      filter: String(meta.filter || 'getReviews'),
      inspectedTabId: meta.inspectedTabId == null ? null : Number(meta.inspectedTabId),
      responseCount: stats.responseCount,
      // Backward-compatible field: now means unique review count.
      reviewCount: stats.uniqueReviewCount,
      rawReviewCount: stats.rawReviewCount,
      uniqueReviewCount: stats.uniqueReviewCount,
      duplicateReviewCount: stats.duplicateReviewCount,
      lastHasNext: stats.lastHasNext,
      endpointPaginationComplete: stats.endpointPaginationComplete,
      // Preserved for MyDataset v0.92 and older import screens.
      captureComplete: stats.endpointPaginationComplete,
      captureMode: String(meta.captureMode || 'devtools-panel'),
      deduplication: 'reviewId-first-occurrence',
      packageFormat: 'mydataset-capture-v4',
      apiReportedReviewCount: diagnostics?.reportedCount ?? null,
      apiCountDifference: diagnostics?.countDifference ?? null,
      apiCountMatches: diagnostics?.countMatches ?? null,
      skipCoverageComplete: coverage?.available ? Boolean(coverage.contiguous) : null,
      aggregateTotal: diagnostics?.aggregate?.aggregateTotal ?? null,
      aggregateTraveloka: diagnostics?.aggregate?.aggregateTraveloka ?? null,
      aggregateOther: diagnostics?.aggregate?.aggregateOther ?? null,
      datasetMetadata: datasetMetadata && typeof datasetMetadata === 'object' ? datasetMetadata : null
    };
  }

  function buildCaptureArtifacts(records, meta = {}) {
    const list = Array.isArray(records) ? records : [];
    const stats = summarizeRecords(list);
    const diagnosticRecords = Array.isArray(meta?.diagnosticRecords) ? meta.diagnosticRecords : [];
    const diagnostics = summarizeDiagnostics(diagnosticRecords, stats.uniqueReviewCount, meta?.platform);
    const coverage = /tiket/i.test(String(meta?.platform || '')) ? tiketCoverage(list) : acquisitionCoverage(list);
    const datasetMetadata = buildDatasetMetadata(meta, stats, diagnostics, coverage);
    const endpoint = endpointName(list, meta.filter || 'review-network');
    const width = Math.max(4, String(Math.max(1, list.length)).length);
    const rawNames = list.map((_, index) => `raw/${endpoint}-${String(index + 1).padStart(width, '0')}.json`);
    const baseMeta = captureMetadata(meta, stats, diagnostics, coverage, datasetMetadata);
    const requests = list.map((record, index) => requestMeta(record, index + 1, rawNames[index]));
    const dedupedResponses = dedupeResponseBodies(list);

    const aggregate = {
      _mydataset_capture: baseMeta,
      responses: dedupedResponses,
      requests
    };

    const rawFiles = list.map((record, index) => {
      const singleStats = summarizeRecords([record]);
      return {
        name: rawNames[index],
        payload: {
          _mydataset_capture: {
            ...captureMetadata({ ...meta, captureMode:'raw-response' }, singleStats),
            sequence: index + 1,
            packageRawResponse: true
          },
          responses: [record.body],
          requests: [requestMeta(record, index + 1, rawNames[index])]
        }
      };
    });

    const diagnosticNames = diagnosticRecords.map((record, index) => {
      const leaf = global.MyDatasetCaptureCore.endpointLeaf(record?.url || '') || 'review-meta';
      return `meta/${safeFilePart(leaf)}-${String(index + 1).padStart(4, '0')}.json`;
    });
    const diagnosticEntries = diagnosticRecords.map((record, index) => ({
      name:diagnosticNames[index],
      text:JSON.stringify({
        _mydataset_diagnostic:{
          schemaVersion:SCHEMA_VERSION,
          extensionVersion:EXTENSION_VERSION,
          endpoint:global.MyDatasetCaptureCore.endpointLeaf(record?.url || ''),
          sequence:index + 1,
          capturedAt:String(record?.capturedAt || ''),
          request:record?.request || null
        },
        response:record?.body ?? null
      }, null, 2)
    }));

    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      packageFormat: 'mydataset-capture-v4',
      extensionVersion: EXTENSION_VERSION,
      capturedAt: baseMeta.capturedAt,
      sourceUrl: baseMeta.sourceUrl,
      pageTitle: baseMeta.pageTitle,
      platform: baseMeta.platform,
      filter: baseMeta.filter,
      endpoint,
      summary: {
        responseCount: stats.responseCount,
        rawReviewCount: stats.rawReviewCount,
        uniqueReviewCount: stats.uniqueReviewCount,
        duplicateReviewCount: stats.duplicateReviewCount,
        lastHasNext: stats.lastHasNext,
        endpointPaginationComplete: stats.endpointPaginationComplete,
        apiReportedReviewCount:diagnostics.reportedCount,
        apiCountDifference:diagnostics.countDifference,
        apiCountMatches:diagnostics.countMatches,
        skipCoverageComplete:coverage.available ? coverage.contiguous : null
      },
      datasetMetadata,
      acquisition:coverage,
      diagnostics:{
        ...diagnostics,
        files:diagnosticRecords.map((record,index) => ({
          sequence:index + 1,
          endpoint:global.MyDatasetCaptureCore.endpointLeaf(record?.url || ''),
          file:diagnosticNames[index],
          method:String(record?.method || 'GET'),
          url:String(record?.url || ''),
          request:record?.request || null
        }))
      },
      importFile: `${endpoint}-all.json`,
      deduplication: 'reviewId-first-occurrence',
      note: 'Gunakan file *-all.json untuk impor normal ke MyDataset. Folder raw mempertahankan response endpoint review yang relevan. Metadata diagnostik hanya ditambahkan jika profile platform menyediakannya.',
      files: requests.map((request, index) => ({
        sequence: index + 1,
        file: rawNames[index],
        method: request.method,
        url: request.url,
        startedDateTime: request.startedDateTime,
        capturedAt: request.capturedAt,
        rawReviewCount: stats.perRecord[index].rawReviewCount,
        uniqueNewReviewCount: stats.perRecord[index].uniqueNewReviewCount,
        duplicateReviewCount: stats.perRecord[index].duplicateReviewCount,
        hasNext: stats.perRecord[index].hasNext,
        requestBodyAvailable: request.requestBodyAvailable,
        request: request.request,
        fingerprint: request.fingerprint
      }))
    };

    return {
      endpoint,
      stats,
      aggregate,
      manifest,
      rawFiles,
      entries: [
        { name:'manifest.json', text:JSON.stringify(manifest, null, 2) },
        { name:`${endpoint}-all.json`, text:JSON.stringify(aggregate, null, 2) },
        ...rawFiles.map(file => ({ name:file.name, text:JSON.stringify(file.payload, null, 2) })),
        ...diagnosticEntries
      ],
      diagnostics,
      coverage,
      datasetMetadata
    };
  }

  // Minimal ZIP writer using STORE (no compression). It avoids multi-download prompts
  // and keeps the capture package dependency-free inside a Manifest V3 extension.
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(value) {
    return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
  }

  function u32(value) {
    return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  function concatBytes(parts) {
    const size = parts.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const item of parts) { out.set(item, offset); offset += item.length; }
    return out;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
    const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    return { time, day };
  }

  function zipBytes(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const stamp = dosDateTime(new Date());

    for (const entry of entries || []) {
      const name = encoder.encode(String(entry.name || 'file.json').replace(/^\/+/, ''));
      const data = entry.bytes instanceof Uint8Array ? entry.bytes : encoder.encode(String(entry.text ?? ''));
      const crc = crc32(data);
      const localHeader = concatBytes([
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.day),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name
      ]);
      localParts.push(localHeader, data);

      const centralHeader = concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.day),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), name
      ]);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    const central = concatBytes(centralParts);
    const end = concatBytes([
      u32(0x06054b50), u16(0), u16(0), u16((entries || []).length), u16((entries || []).length),
      u32(central.length), u32(offset), u16(0)
    ]);
    return concatBytes([...localParts, central, end]);
  }

  function zipBlob(entries) {
    return new Blob([zipBytes(entries)], { type:'application/zip' });
  }

  global.MyDatasetCaptureExport = {
    EXTENSION_VERSION, SCHEMA_VERSION,
    safeFilePart, safeHost, localStamp, endpointName,
    summarizeRecords, dedupeResponseBodies, buildCaptureArtifacts, acquisitionCoverage, tiketCoverage, summarizeDiagnostics, buildDatasetMetadata,
    crc32, zipBytes, zipBlob
  };
})(globalThis);
