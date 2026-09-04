 'use strict';

const networkBtn = document.getElementById('networkBtn');
const packageBtn = document.getElementById('packageBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const harInput = document.getElementById('harInput');
const harPackageBtn = document.getElementById('harPackageBtn');
const harJsonBtn = document.getElementById('harJsonBtn');
const harFileState = document.getElementById('harFileState');
const connectionState = document.getElementById('connectionState');
const status = document.getElementById('status');
const core = globalThis.MyDatasetCaptureCore;
const exporter = globalThis.MyDatasetCaptureExport;
let pendingHarMode = 'package';

function setStatus(message, kind = '') {
  status.textContent = String(message || '');
  status.classList.toggle('ok', kind === 'ok');
  status.classList.toggle('error', kind === 'error');
}

function safeFilePart(value) { return exporter.safeFilePart(value); }
function safeHost(url) { return exporter.safeHost(url); }
function localStamp() { return exporter.localStamp(); }

async function activeHttpTab() {
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (!tab?.id || !/^https?:\/\//i.test(String(tab.url || ''))) throw new Error('Buka halaman HTTP/HTTPS target terlebih dahulu.');
  return tab;
}

async function downloadBlob(blob, fileName, saveAs = true) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url:objectUrl, filename:fileName, saveAs, conflictAction:'uniquify' });
    return fileName;
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }
}

async function refreshBridgeStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    if (!tab?.id) throw new Error('tab tidak tersedia');
    const result = await chrome.runtime.sendMessage({ type:'mydataset:devtools-status', tabId:tab.id });
    const connected = Boolean(result?.connected);
    connectionState.textContent = connected
      ? `DevTools terhubung ke tab ${tab.id}. Network dapat dipindai.`
      : 'DevTools belum terdaftar untuk tab ini. Jika ekstensi baru saja di-reload, ekspor HAR sekarang sebelum menutup DevTools.';
    connectionState.classList.toggle('ok', connected);
    connectionState.classList.toggle('warn', !connected);
    return connected;
  } catch {
    connectionState.textContent = 'Status DevTools tidak dapat dibaca. Gunakan impor HAR bila data Network sudah terkumpul.';
    connectionState.classList.remove('ok');
    connectionState.classList.add('warn');
    return false;
  }
}

async function scanNetworkRecords() {
  const tab = await activeHttpTab();
  const filter = String(document.getElementById('networkFilter').value || 'getReviews').trim();
  const successOnly = document.getElementById('successOnly').checked;
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type:'mydataset:scan-current-network', tabId:tab.id, filter, successOnly });
  } catch (error) {
    throw new Error(`Bridge DevTools gagal: ${error?.message || error}. Jika Network sudah berisi data, ekspor HAR dengan content lalu gunakan menu Pemulihan dari HAR.`);
  }
  if (!result?.ok) {
    if (result?.errorCode === 'DEVTOOLS_NOT_CONNECTED') {
      throw new Error('DevTools untuk tab ini belum terhubung. Jika ekstensi baru saja diperbarui saat F12 sudah terbuka, jangan tutup DevTools dulu: ekspor HAR dengan content, lalu impor HAR melalui bagian Pemulihan dari HAR. Untuk sesi berikutnya, tutup dan buka kembali F12 setelah ekstensi aktif.');
    }
    throw new Error(result?.error || 'DevTools tidak mengembalikan data Network.');
  }
  const records = Array.isArray(result.records) ? result.records : [];
  if (!records.length) {
    const emptyBodies = Number(result?.skipped?.['empty-body'] || 0);
    throw new Error(emptyBodies
      ? `Request ${filter || 'JSON'} ditemukan tetapi body response tidak lagi tersedia. Muat ulang/ubah halaman review dengan F12 tetap terbuka, lalu coba lagi.`
      : `Tidak ada response JSON yang cocok dengan filter “${filter || '(kosong)'}”. Pastikan request terlihat di Network.`);
  }
  return {
    tab,
    records,
    meta: {
      sourceUrl:String(result.sourceUrl || tab.url || ''),
      pageTitle:String(result.pageTitle || tab.title || ''),
      filter,
      inspectedTabId:tab.id,
      captureMode:'devtools-har-scan',
      capturedAt:new Date().toISOString(),
      diagnosticRecords:Array.isArray(result.diagnosticRecords) ? result.diagnosticRecords : []
    }
  };
}

function setBusy(busy) {
  networkBtn.disabled = busy;
  packageBtn.disabled = busy;
  harPackageBtn.disabled = busy;
  harJsonBtn.disabled = busy;
  snapshotBtn.disabled = busy;
}

function auditStatusLines(artifacts) {
  const meta = artifacts?.datasetMetadata || {};
  const lines = [];
  if (meta.aggregate_total != null) {
    const split = meta.aggregate_traveloka != null && meta.aggregate_other != null
      ? ` (Traveloka ${Number(meta.aggregate_traveloka).toLocaleString('id-ID')} + lain ${Number(meta.aggregate_other).toLocaleString('id-ID')})`
      : '';
    lines.push(`Aggregate sumber: ${Number(meta.aggregate_total).toLocaleString('id-ID')}${split}.`);
  }
  if (meta.api_reported_text_count != null) {
    const gap = meta?.count_discrepancy?.reported_vs_retrieved;
    lines.push(`getReviewCount: ${Number(meta.api_reported_text_count).toLocaleString('id-ID')}${gap == null ? '' : ` · selisih listing: ${Number(gap).toLocaleString('id-ID')}`}.`);
  }
  if (meta?.pagination?.request_count != null) {
    lines.push(`Pagination: ${meta.pagination.complete ? 'lengkap teramati' : 'belum terbukti lengkap'} · ${Number(meta.pagination.request_count).toLocaleString('id-ID')} request · offset hilang ${Number(meta.pagination.missing_offsets || 0).toLocaleString('id-ID')}.`);
  }
  if (meta.coverage_claim) lines.push(`Coverage: ${meta.coverage_claim}; populasi penuh: tidak diklaim.`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

async function saveNetwork(kind) {
  setBusy(true);
  setStatus('Memindai DevTools Network…');
  try {
    const { records, meta } = await scanNetworkRecords();
    const artifacts = exporter.buildCaptureArtifacts(records, meta);
    const stats = artifacts.stats;
    if (kind === 'package') {
      setStatus('Membuat paket raw response…');
      const blob = exporter.zipBlob(artifacts.entries);
      const fileName = `MyDataset-Capture-${safeFilePart(safeHost(meta.sourceUrl))}-${localStamp()}.zip`;
      await downloadBlob(blob, fileName, true);
      setStatus(`Berhasil.\n${stats.responseCount} response · ${stats.rawReviewCount.toLocaleString('id-ID')} record mentah · ${stats.uniqueReviewCount.toLocaleString('id-ID')} review unik · ${stats.duplicateReviewCount.toLocaleString('id-ID')} duplikat.\nPagination API: ${stats.endpointPaginationComplete ? 'selesai (hasNext=false)' : (stats.lastHasNext === true ? 'masih ada (hasNext=true)' : 'tidak diketahui')}.${auditStatusLines(artifacts)}\nPaket: ${fileName}`, 'ok');
    } else {
      const blob = new Blob([JSON.stringify(artifacts.aggregate, null, 2)], { type:'application/json;charset=utf-8' });
      const fileName = `MyDataset-XHR-${safeFilePart(safeHost(meta.sourceUrl))}-${artifacts.endpoint}-all-${localStamp()}.json`;
      await downloadBlob(blob, fileName, true);
      setStatus(`Berhasil.\n${stats.responseCount} response · ${stats.uniqueReviewCount.toLocaleString('id-ID')} review unik (${stats.duplicateReviewCount.toLocaleString('id-ID')} duplikat dibuang dari file gabungan).${auditStatusLines(artifacts)}\nFile: ${fileName}`, 'ok');
    }
  } catch (error) {
    setStatus(`Gagal: ${error?.message || error}`, 'error');
  } finally {
    setBusy(false);
  }
}


function harEntriesFromObject(value) {
  if (Array.isArray(value?.log?.entries)) return value.log.entries;
  if (Array.isArray(value?.entries)) return value.entries;
  return [];
}

function harRequestAdapter(entry) {
  const content = entry?.response?.content || {};
  const text = String(content.text || '');
  const encoding = String(content.encoding || '');
  return {
    ...entry,
    getContent(callback) {
      callback(text, encoding);
    }
  };
}

async function recordsFromHar(harObject, { filter = 'getReviews', successOnly = true } = {}) {
  const entries = harEntriesFromObject(harObject);
  if (!entries.length) throw new Error('File bukan HAR yang valid atau tidak memiliki log.entries.');
  const records = [];
  const seen = new Set();
  const skipped = { filter:0, 'empty-body':0, 'too-large':0, 'not-json':0, duplicate:0, error:0 };
  for (const entry of entries) {
    try {
      const result = await core.requestRecord(harRequestAdapter(entry), { filter, successOnly, fromScan:true });
      if (!result.record) {
        const key = Object.prototype.hasOwnProperty.call(skipped, result.reason) ? result.reason : 'error';
        skipped[key] += 1;
        continue;
      }
      if (seen.has(result.record.fingerprint)) {
        skipped.duplicate += 1;
        continue;
      }
      seen.add(result.record.fingerprint);
      records.push(result.record);
    } catch {
      skipped.error += 1;
    }
  }
  return { entries, records, skipped };
}

async function activeTabMetaFallback() {
  try {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    return {
      sourceUrl:/^https?:\/\//i.test(String(tab?.url || '')) ? String(tab.url) : '',
      pageTitle:String(tab?.title || ''),
      inspectedTabId:tab?.id || null
    };
  } catch {
    return { sourceUrl:'', pageTitle:'', inspectedTabId:null };
  }
}

async function saveFromHarFile(file, kind) {
  if (!file) return;
  setBusy(true);
  setStatus(`Membaca HAR: ${file.name}…`);
  harFileState.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  try {
    const raw = await file.text();
    let harObject;
    try { harObject = JSON.parse(raw); }
    catch { throw new Error('HAR tidak dapat diparse sebagai JSON.'); }

    const filter = String(document.getElementById('networkFilter').value || 'getReviews').trim();
    const successOnly = document.getElementById('successOnly').checked;
    const [scan, familyScan, aggregateScan] = await Promise.all([
      recordsFromHar(harObject, { filter, successOnly }),
      recordsFromHar(harObject, { filter:'getReview', successOnly }),
      recordsFromHar(harObject, { filter:'getAvailableReviewWithAggregate', successOnly })
    ]);
    const diagnosticRecords = [];
    const seenDiagnostics = new Set();
    for (const record of [...(familyScan.records || []), ...(aggregateScan.records || [])]) {
      if (!core.isReviewDiagnosticRecord(record)) continue;
      const key = String(record?.fingerprint || `${record?.method || ''}|${record?.url || ''}|${record?.startedDateTime || ''}`);
      if (seenDiagnostics.has(key)) continue;
      seenDiagnostics.add(key);
      diagnosticRecords.push(record);
    }
    if (!scan.records.length) {
      const emptyBodies = Number(scan.skipped['empty-body'] || 0);
      throw new Error(emptyBodies
        ? `HAR menemukan request “${filter}”, tetapi body response tidak disertakan. Di Network gunakan ekspor HAR yang menyertakan content/response body.`
        : `Tidak ada response JSON yang cocok dengan filter “${filter || '(kosong)'}” di HAR.`);
    }

    const tabMeta = await activeTabMetaFallback();
    const meta = {
      ...tabMeta,
      filter,
      captureMode:'har-file-import',
      capturedAt:new Date().toISOString(),
      importedHarName:file.name,
      diagnosticRecords
    };
    const artifacts = exporter.buildCaptureArtifacts(scan.records, meta);
    const stats = artifacts.stats;

    if (kind === 'package') {
      const blob = exporter.zipBlob(artifacts.entries);
      const fileName = `MyDataset-Capture-HAR-${safeFilePart(safeHost(meta.sourceUrl || scan.records[0]?.url))}-${localStamp()}.zip`;
      await downloadBlob(blob, fileName, true);
      setStatus(`HAR berhasil diproses.\n${stats.responseCount} response · ${stats.rawReviewCount.toLocaleString('id-ID')} record mentah · ${stats.uniqueReviewCount.toLocaleString('id-ID')} review unik · ${stats.duplicateReviewCount.toLocaleString('id-ID')} duplikat.${auditStatusLines(artifacts)}\nPaket: ${fileName}`, 'ok');
    } else {
      const blob = new Blob([JSON.stringify(artifacts.aggregate, null, 2)], { type:'application/json;charset=utf-8' });
      const fileName = `MyDataset-XHR-HAR-${safeFilePart(safeHost(meta.sourceUrl || scan.records[0]?.url))}-${artifacts.endpoint}-all-${localStamp()}.json`;
      await downloadBlob(blob, fileName, true);
      setStatus(`HAR berhasil diproses.\n${stats.responseCount} response · ${stats.uniqueReviewCount.toLocaleString('id-ID')} review unik (${stats.duplicateReviewCount.toLocaleString('id-ID')} duplikat dibuang).${auditStatusLines(artifacts)}\nFile: ${fileName}`, 'ok');
    }
  } catch (error) {
    setStatus(`Gagal memproses HAR: ${error?.message || error}`, 'error');
  } finally {
    setBusy(false);
    harInput.value = '';
  }
}

async function captureSnapshotHtml() {
  snapshotBtn.disabled = true; networkBtn.disabled = true; packageBtn.disabled = true;
  setStatus('Membaca halaman aktif…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(String(tab.url || ''))) {
      throw new Error('Buka halaman HTTP/HTTPS yang ingin disimpan terlebih dahulu.');
    }
    if (/traveloka\./i.test(String(tab.url || ''))) {
      throw new Error('Traveloka tidak menggunakan Snapshot DOM. Gunakan Simpan Paket getReviews atau JSON Gabungan dengan DevTools tetap terbuka.');
    }

    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const reviewPayloads = [];
        const seenPayloads = new Set();
        const keyOf = item => String(item?.reviewId || item?.writingid || item?.writingId || item?.id || item?.reviewTimestamp || item?.createdAt || item?.postedAt || item?.reviewContentText || item?.reviewOriginalText || '').slice(0, 320);
        const pushReview = item => {
          if (!item || typeof item !== 'object' || reviewPayloads.length >= 5000) return;
          const hasShape = ['reviewId','writingid','writingId','reviewTimestamp','reviewContentText','reviewOriginalText','reviewerName','reviewScore'].some(key => item[key] != null)
            || (item.reviewer && typeof item.reviewer === 'object');
          if (!hasShape) return;
          let key = keyOf(item);
          if (!key) {
            try { key = JSON.stringify(item).slice(0, 320); } catch { key = ''; }
          }
          if (!key || seenPayloads.has(key)) return;
          seenPayloads.add(key);
          reviewPayloads.push(item);
        };
        const walkReviews = (value, depth = 0) => {
          if (value == null || depth > 8 || reviewPayloads.length >= 5000) return;
          if (Array.isArray(value)) {
            for (const item of value.slice(0, 800)) walkReviews(item, depth + 1);
            return;
          }
          if (typeof value !== 'object') return;
          pushReview(value);
          for (const next of Object.values(value)) {
            if (next && typeof next === 'object') walkReviews(next, depth + 1);
          }
        };
        if (Array.isArray(window.__PETIKDATA_CAPTURED_REVIEWS__)) {
          for (const item of window.__PETIKDATA_CAPTURED_REVIEWS__.slice(-5000)) pushReview(item);
        }
        for (const script of [...document.scripts]) {
          const raw = String(script.textContent || '').trim();
          if (raw.length < 2 || raw.length > 5_000_000) continue;
          if (!/(?:reviewTimestamp|reviewContentText|reviewOriginalText|reviewId|writingid|reviewScore)/i.test(raw)) continue;
          if (!(raw.startsWith('{') || raw.startsWith('['))) continue;
          try { walkReviews(JSON.parse(raw), 0); } catch {}
        }

        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script').forEach(node => node.remove());
        clone.querySelectorAll('iframe,frame,object,embed').forEach(node => node.remove());
        const head = clone.querySelector('head') || clone.insertBefore(document.createElement('head'), clone.firstChild);
        for (const selector of ['meta[name="petikdata-source-url"]','meta[name="petikdata-captured-at"]']) {
          clone.querySelectorAll(selector).forEach(node => node.remove());
        }
        const source = document.createElement('meta');
        source.setAttribute('name', 'petikdata-source-url');
        source.setAttribute('content', location.href);
        head.prepend(source);
        const captured = document.createElement('meta');
        captured.setAttribute('name', 'petikdata-captured-at');
        captured.setAttribute('content', new Date().toISOString());
        head.prepend(captured);

        const visible = el => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const originalReviewLists = [...document.querySelectorAll('[data-testid="review-list-container"]')];
        const clonedReviewLists = [...clone.querySelectorAll('[data-testid="review-list-container"]')];
        originalReviewLists.forEach((node, index) => {
          clonedReviewLists[index]?.setAttribute('data-petikdata-visible-at-capture', visible(node) ? 'true' : 'false');
        });

        if (reviewPayloads.length) {
          const template = document.createElement('template');
          template.id = 'petikdata-captured-review-payload';
          template.setAttribute('data-count', String(reviewPayloads.length));
          template.textContent = JSON.stringify(reviewPayloads);
          const cloneBody = clone.querySelector('body') || clone;
          cloneBody.appendChild(template);
        }

        const doctype = document.doctype
          ? `<!DOCTYPE ${document.doctype.name || 'html'}>`
          : '<!DOCTYPE html>';
        return {
          html: `${doctype}
${clone.outerHTML}`,
          url: location.href,
          title: document.title || '',
          host: location.hostname || 'halaman'
        };
      }
    });

    const result = execution?.result;
    if (!result?.html) throw new Error('DOM halaman tidak dapat dibaca.');
    const blob = new Blob([result.html], { type: 'text/html;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const fileName = `MyDataset-${safeFilePart(result.host)}-${safeFilePart(result.title)}-${localStamp()}.html`;
    try {
      await chrome.downloads.download({ url: objectUrl, filename: fileName, saveAs: true, conflictAction: 'uniquify' });
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
    }
    setStatus(`Snapshot siap: ${fileName}
Selanjutnya impor file ini di MyDataset.`);
  } catch (error) {
    setStatus(`Gagal: ${error?.message || error}`);
  } finally {
    snapshotBtn.disabled = false; networkBtn.disabled = false; packageBtn.disabled = false;
  }
}


packageBtn.addEventListener('click', () => saveNetwork('package'));
networkBtn.addEventListener('click', () => saveNetwork('aggregate'));
harPackageBtn.addEventListener('click', () => { pendingHarMode = 'package'; harInput.click(); });
harJsonBtn.addEventListener('click', () => { pendingHarMode = 'aggregate'; harInput.click(); });
harInput.addEventListener('change', () => saveFromHarFile(harInput.files?.[0], pendingHarMode));
snapshotBtn.addEventListener('click', captureSnapshotHtml);
refreshBridgeStatus();
