const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const { applyTransform } = require('../core/transforms');
const { formatScrapedAt, sanitizeExportRow } = require('../core/normalizers');
const { resolveSourceContext } = require('../core/source-context');
const { projectForRun } = require('../core/project-mode');
const { buildExpansionScript, hasTruncationMarker } = require('../ui/content-expansion');
const { configurePersistentBrowserSession } = require('../core/browser-profile');
const { inspectTerminalStateAtStepLimit } = require('../core/completion-state');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveIntOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return null;
  return Math.trunc(numeric);
}

function isTerminalPaginationCode(code = '') {
  return ['PAGINATION_END_REACHED', 'SOURCE_LIMIT_REACHED'].includes(String(code || ''));
}

function isAgodaLocation(value = '') {
  try { return /(^|\.)agoda\./i.test(new URL(String(value || '')).hostname); }
  catch { return /agoda\./i.test(String(value || '')); }
}

function isTripLocation(value = '') {
  try { return /(^|\.)trip\.com$/i.test(new URL(String(value || '')).hostname); }
  catch { return /(^|\.)trip\.com/i.test(String(value || '')); }
}

function isTiketLocation(value = '') {
  try { return /(^|\.)tiket\.com$/i.test(new URL(String(value || '')).hostname); }
  catch { return /(^|\.)tiket\.com/i.test(String(value || '')); }
}

function paginationAdapterLabel(value = '') {
  if (isTripLocation(value)) return 'Trip';
  if (isAgodaLocation(value)) return 'Agoda';
  if (isTiketLocation(value)) return 'Tiket';
  return 'Situs';
}

function supportsDirectPaginationRecovery(value = '') {
  // Direct numeric recovery is safe when a site exposes a bounded paginator
  // target. Tiket is included here, but unlike Agoda/Trip it is NOT allowed to
  // treat visible text alone as a logical page proof.
  return isAgodaLocation(value) || isTripLocation(value) || isTiketLocation(value);
}

function supportsLogicalContentPagination(value = '') {
  // Agoda and Trip are SPA review surfaces whose visual page marker may lag behind
  // the actual review cards. On these two adapters a fresh review fingerprint can
  // safely become the logical page proof, but only after a pagination action has an
  // expected numeric target.
  return isAgodaLocation(value) || isTripLocation(value);
}

function isTripPaginationSource(pagination = {}, sourceUrl = '') {
  const candidates = [sourceUrl, pagination?.meta?.sourceHost, pagination?.meta?.sourceUrl].filter(Boolean);
  return candidates.some(value => isTripLocation(String(value || '')));
}

function isWeakTripStoredSelector(selector = '') {
  const raw = String(selector || '').trim();
  if (!raw) return true;
  const compact = raw.replace(/\s+/g, ' ');
  // Positional selectors selected from Trip's CSS-module paginator are allowed as
  // a locator hint, but a bare descendant control ("... ul a") is never trusted
  // as an actionable Next selector. Runtime discovery will use it only to locate
  // the numeric cluster, then choose an exact page or a proven right-edge control.
  if (/^(?:a|button|li|span|\[role=["']?(?:button|link)["']?\])$/i.test(compact.replace(/\s+/g,''))) return true;
  if (/(?:^|[>+~\s])(?:ul|ol|nav)(?:[^,]*)\s+(?:a|button|\[role=["']?(?:button|link)["']?\])$/i.test(compact)
      && !/\[(?:data-|aria-|role|rel)|\.[A-Za-z_-]|:(?:nth|last|first|has|not|is)\b/i.test(compact.split(/\s+(?=[^\]]*$)/).pop() || '')) return true;
  return false;
}

function contentFingerprintSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value.filter(Boolean).map(String) : []);
}

function contentIsKnown(state, knownFingerprints) {
  const known = contentFingerprintSet(knownFingerprints);
  if (!known.size || !state) return false;
  return known.has(pageContentFingerprint(state));
}

function nativePageFingerprint(ids = [], itemCount = null) {
  const stableIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))].sort();
  if (!stableIds.length) return '';
  const count = positiveIntOrNull(itemCount) ?? stableIds.length;
  const payload = ['native', count, stableIds.join('|')].join('|');
  return `id:${crypto.createHash('sha1').update(payload).digest('hex')}`;
}

function storedRowNativeReviewId(row = {}) {
  if (!row || typeof row !== 'object') return '';
  const preferred = ['review_id','reviewId','reviewid','comment_id','commentId','writing_id','writingId','writingid','submit_id','submitId'];
  for (const key of preferred) {
    const value = row[key];
    if (value != null && String(value).trim() && !/^synthetic:/i.test(String(value).trim())) return String(value).trim();
  }
  for (const [key, value] of Object.entries(row)) {
    if (value == null || !String(value).trim()) continue;
    if (/^(?:review|comment|writing|submit)_?id$/i.test(String(key)) && !/^synthetic:/i.test(String(value).trim())) return String(value).trim();
  }
  return '';
}

function resumeNativePageFingerprints(runStore) {
  if (!runStore?.readRows) return [];
  let rows = [];
  try { rows = runStore.readRows(); } catch { return []; }
  const history = Array.isArray(runStore?.state?.pageHistory) ? runStore.state.pageHistory : [];
  const expectedCounts = new Map(history.map(entry => [String(entry?.sitePage ?? ''), Number(entry?.itemCount || 0)]));
  const grouped = new Map();
  for (const row of rows) {
    const page = positiveIntOrNull(row?._page);
    const id = storedRowNativeReviewId(row);
    if (page == null || !id) continue;
    const key = String(page);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(id);
  }
  const entries = [...grouped.entries()].sort((a,b)=>Number(a[0])-Number(b[0])).slice(-600);
  const fingerprints = [];
  for (const [page, ids] of entries) {
    const unique = [...new Set(ids.map(String))];
    const expected = expectedCounts.get(page) || unique.length;
    // Only reconstruct a page fingerprint when the saved clean rows cover every
    // source-native ID expected for that page. Partial groups must not become cycle proof.
    if (!unique.length || unique.length !== expected) continue;
    const fingerprint = nativePageFingerprint(unique, expected);
    if (fingerprint) fingerprints.push(fingerprint);
  }
  return fingerprints;
}

function withLogicalSitePage(state, logicalPage, source = 'content') {
  const logical = positiveIntOrNull(logicalPage);
  if (!state || logical == null || Number(state.pageNumber) === logical) return state;
  return {
    ...state,
    observedPageNumber: positiveIntOrNull(state.pageNumber),
    observedPageNumberSource: state.pageNumberSource || '',
    pageNumber: logical,
    pageNumberSource: `logical-${source}`
  };
}

async function runProject(project, onProgress = () => {}, options = {}) {
  project = projectForRun(project);
  validateProject(project);
  const {
    runStore = null,
    control = {},
    resume = false,
    targetWebContents = null,
    useCurrentPage = false
  } = options;

  let worker;
  let ownsWorker = false;
  if (targetWebContents && !targetWebContents.isDestroyed?.()) {
    worker = { webContents: targetWebContents };
  } else {
    const browserProfile = configurePersistentBrowserSession(session);
    const sharedSession = browserProfile.session;
    worker = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        images: true,
        backgroundThrottling: false,
        session: sharedSession
      }
    });
    if (browserProfile.userAgent) worker.webContents.setUserAgent(browserProfile.userAgent);
    ownsWorker = true;
  }

  const logs = [];
  const recordLog = message => {
    const line = String(message ?? '');
    logs.push(line);
    runStore?.appendLog?.(line);
    return line;
  };
  const previewRows = [];
  const scopeAll = project.acquisition?.scope === 'all' && project.mode === 'multipage';
  // v0.91: tidak ada hard limit 500. Scope 'all' mengikuti sumber sampai
  // paginator benar-benar berakhir; scope 'multiple' memakai target pengguna apa adanya.
  const maxPages = scopeAll ? null : (positiveIntOrNull(project.pagination?.maxPages) || 1);
  const delayMs = clamp(project.pagination?.delayMs ?? 5000, 250, 120000);
  const timeoutMs = clamp(project.settings?.timeoutMs ?? 30000, 3000, 120000);
  const retryCount = clamp(project.settings?.retryCount ?? 3, 0, 10);
  // v0.90: currentPage tetap dipertahankan untuk kompatibilitas, tetapi ia adalah
  // nomor langkah runner. Posisi paginator website disimpan terpisah supaya retry
  // tidak pernah menganggap step 101 sama dengan halaman situs 101.
  const checkpointPage = resume ? (positiveIntOrNull(runStore?.state?.currentStep ?? runStore?.state?.currentPage) || 1) : 1;
  const checkpointCompleted = Boolean(resume && runStore?.state?.pageCompleted);
  // Legacy v0.90 dapat menyimpan page=0 akibat Number(null). Anggap 0 sebagai unknown.
  const checkpointSitePage = resume ? positiveIntOrNull(runStore?.state?.confirmedSitePage) : null;
  const startPageCandidate = checkpointCompleted ? checkpointPage + 1 : checkpointPage;
  const startPage = maxPages == null ? startPageCandidate : Math.min(maxPages, startPageCandidate);

  try {
    runStore?.markRunning(resume ? 'Melanjutkan run dari checkpoint.' : (useCurrentPage ? 'Scraping dimulai dari tab aktif.' : 'Scraping dimulai.'));
    if (useCurrentPage) {
      const currentUrl = worker.webContents.getURL();
      onProgress({ stage: 'loading', message: 'Menggunakan kondisi tab yang sedang terbuka…', page: 1, runDir: runStore?.runDir, currentUrl });
      await waitForSettled(worker, Math.min(delayMs, 1000), control);
    } else {
      onProgress({ stage: 'loading', message: 'Membuka halaman awal…', page: 1, runDir: runStore?.runDir });
      await withRetry(() => loadUrl(worker, project.startUrl, timeoutMs), retryCount, delayMs, onProgress, 'membuka halaman');
      await waitForSettled(worker, Math.min(delayMs, 5000), control);
    }

    onProgress({ stage: 'access-guard', message: 'Memeriksa apakah halaman aman dan benar-benar dapat dibaca…', page: 1, runDir: runStore?.runDir, currentUrl: worker.webContents.getURL() });
    const initialAccess = await readAccessState(worker);
    if (initialAccess === 'restricted' || initialAccess === 'challenge') {
      const currentUrl = worker.webContents.getURL();
      const accessMessage = initialAccess === 'challenge'
        ? 'Run dijeda: situs meminta verifikasi manusia. Selesaikan verifikasi secara manual, atau buka halaman di Google Chrome lalu impor snapshot sebelum melanjutkan.'
        : 'Run dijeda: situs menolak browser tertanam. Buka halaman di Google Chrome. Untuk Traveloka ekspor HAR with content dan impor melalui HAR / Network; untuk situs DOM gunakan alur pemulihan yang sesuai, lalu lanjutkan dari checkpoint.';
      recordLog(accessMessage);
      runStore?.checkpoint({ currentPage: 1, pageCompleted: false, currentUrl, accessState: initialAccess });
      onProgress({ stage: 'access-required', message: accessMessage, page: 1, runDir: runStore?.runDir, currentUrl, accessState: initialAccess });
      return pausedResult(runStore, previewRows, logs, {
        message: accessMessage,
        accessIssue: { state: initialAccess, currentUrl }
      });
    }

    if (!useCurrentPage && Array.isArray(project.beforeActions)) {
      for (const action of project.beforeActions) {
        assertNotCanceled(control);
        if (control.pauseRequested) return pausedResult(runStore, previewRows, logs);
        await executeAction(worker, action, delayMs, control);
      }
    }

    if (project.mode === 'crawl') {
      return await runCrawlMode({
        worker, project, runStore, control, resume, previewRows, logs, recordLog,
        onProgress, delayMs, timeoutMs, retryCount
      });
    }

    if (resume && project.pagination && project.pagination.type !== 'none') {
      const restored = await restoreResumePosition({
        worker, project, runStore, checkpointStep: checkpointPage, checkpointSitePage, checkpointCompleted,
        useCurrentPage, delayMs, control, onProgress, recordLog
      });
      if (!restored.ok) {
        const error = new Error(restored.message || 'Posisi checkpoint tidak dapat dipulihkan dengan aman.');
        error.code = restored.code || 'RESUME_POSITION_UNKNOWN';
        error.details = restored;
        throw error;
      }
      if (restored.sourceEndReached) {
        const count = runStore?.state?.itemsCollected ?? previewRows.length;
        const message = restored.message || `Sumber sudah berada di halaman terakhir. ${count} hasil cleaning dipertahankan.`;
        runStore?.checkpoint({ sourceEndReason:'PAGINATION_END_REACHED', sourceEndMessage:message, failure:null });
        runStore?.markCompleted(message);
        onProgress({ stage:'done', message, page:checkpointPage, sitePage:checkpointSitePage, itemsCollected:count, rawItemsRead:runStore?.state?.rawItemsRead ?? count, duplicatesSkipped:runStore?.state?.exactDuplicates ?? 0, possibleDuplicates:runStore?.state?.possibleDuplicates ?? 0 });
        return { ok:true, partial:false, paused:false, runDir:runStore?.runDir||null, rows:runStore?runStore.readRows({limit:300}):previewRows, totalRows:count, logs, state:runStore?.state||null };
      }
    }

    // Fingerprint halaman harus bertahan lintas retry. Tanpa ini, setelah Agoda
    // reset ke halaman 1, tombol Coba Lagi dapat membaca ulang halaman lama seolah baru.
    const visitedFingerprints = new Set(Array.isArray(runStore?.state?.pageFingerprints) ? runStore.state.pageFingerprints : []);
    const visitedContentFingerprints = new Set(Array.isArray(runStore?.state?.contentFingerprints) ? runStore.state.contentFingerprints : []);
    // v1.0.17 can resume v1.0.16 runs safely: rebuild source-native page
    // fingerprints from already saved review_id rows so an old text-only checkpoint
    // cannot accidentally accept stale cards under a newer paginator label.
    if (resume && runStore) {
      for (const fingerprint of resumeNativePageFingerprints(runStore)) visitedContentFingerprints.add(fingerprint);
    }
    let page = startPage;
    let paginationFailure = null;
    let terminalSourceEnd = null;
    let userStepLimitReached = false;
    let lastConfirmedState = null;

    while (maxPages == null || page <= maxPages) {
      assertNotCanceled(control);
      if (control.pauseRequested) return pausedResult(runStore, previewRows, logs);

      onProgress({ stage: 'expanding', message: `Membuka teks terpotong pada langkah ${page}…`, page });
      const expansion = await expandTruncatedContent(worker, project);
      recordExpansionLog(expansion, recordLog, `Langkah ${page}`);

      // Jangan membaca DOM ketika komponen review sedang transisi/kosong. Agoda
      // dapat sesaat menampilkan empty-state lalu merender ulang paginator.
      const expectedSitePage = positiveIntOrNull(runStore?.state?.expectedSitePage);
      let stable = await stabilizeReadablePage(worker, project, {
        expectedSitePage,
        previousSitePage: positiveIntOrNull(runStore?.state?.confirmedSitePage),
        knownContentFingerprints: visitedContentFingerprints,
        timeoutMs: Math.max(7000, Math.min(20000, delayMs * 4)),
        control
      });
      // Agoda dan Trip dapat sesaat merender panel kosong atau mengembalikan
      // marker paginator lama setelah SPA selesai memperbarui review. Empty-state
      // bukan alasan untuk langsung menghentikan run: bangunkan panel terlebih dulu,
      // lalu pulihkan target numerik bila target halaman memang sudah diketahui.
      const currentRunUrl = worker.webContents.getURL();
      const recoverablePaginationState = ['PAGINATION_STATE_RESET','PAGINATION_CYCLE','PAGINATION_STATE_UNSTABLE','PAGINATION_EMPTY_STATE'].includes(stable.code);
      const siteSupportsDirectRecovery = supportsDirectPaginationRecovery(currentRunUrl);
      if (!stable.ok && recoverablePaginationState && expectedSitePage != null && siteSupportsDirectRecovery) {
        if (stable.code === 'PAGINATION_EMPTY_STATE') {
          const panelRecovery = await recoverTransientReviewPanel(worker, project, control, recordLog);
          if (panelRecovery?.recovered && panelRecovery.state) {
            const panelContent = pageContentFingerprint(panelRecovery.state);
            if (!visitedContentFingerprints.has(panelContent)) {
              stable = {
                ok:true,
                state:withLogicalSitePage(panelRecovery.state, expectedSitePage, `${paginationAdapterLabel(currentRunUrl).toLowerCase()}-panel-recovery`),
                recovered:true,
                panelRecovered:true
              };
              recordLog(`Pemulihan panel: ${paginationAdapterLabel(currentRunUrl)} kembali menampilkan review untuk target halaman ${expectedSitePage}.`);
            }
          }
        }
        if (!stable.ok) {
          const recovery = await recoverPaginationToPage(worker, project, expectedSitePage, control, onProgress, page, `State ${paginationAdapterLabel(currentRunUrl)} belum berada pada konten halaman target sebelum ekstraksi.`, {
            knownContentFingerprints: visitedContentFingerprints,
            requireFreshContent: true
          });
          if (recovery.ok) {
            stable = { ok:true, state:recovery.state, elapsedMs:recovery.elapsedMs, recovered:true };
            recordLog(`Pagination recovery: halaman ${expectedSitePage} dipulihkan sebelum ekstraksi.`);
          }
        }
        if (stable.ok) {
          runStore?.checkpoint({
            expectedSitePage,
            paginationRecoveryCount:Number(runStore?.state?.paginationRecoveryCount || 0) + 1,
            failure:null
          });
        }
      }
      if (!stable.ok) {
        if (isTerminalPaginationCode(stable.code) && page > 1) {
          terminalSourceEnd = {
            code: stable.code,
            message: stable.message,
            page: Math.max(1, page - 1),
            sitePage: positiveIntOrNull(runStore?.state?.confirmedSitePage)
          };
          recordLog(`Sumber berhenti: ${stable.message}`);
          runStore?.checkpoint({
            sourceEndReason: stable.code,
            sourceEndMessage: stable.message,
            failure: null,
            currentStep: terminalSourceEnd.page,
            currentPage: terminalSourceEnd.page
          });
          onProgress({ stage:'pagination-end', message:stable.message, page:terminalSourceEnd.page, sitePage:terminalSourceEnd.sitePage });
          break;
        }
        paginationFailure = {
          code: stable.code || 'PAGINATION_STATE_UNSTABLE',
          message: stable.message || 'Keadaan halaman tidak stabil untuk diekstrak.',
          details: stable
        };
        onProgress({ stage:'pagination', message:`Validasi pagination gagal: ${paginationFailure.message}`, page, sitePage:stable.detectedSitePage ?? expectedSitePage, failure:paginationFailure });
        recordLog(`Dihentikan: ${paginationFailure.message}`);
        break;
      }

      let currentState = stable.state;
      const previousItemKeys = Array.isArray(runStore?.state?.lastPageItemKeys) ? runStore.state.lastPageItemKeys : [];
      let tripPopulationDiagnostic = null;
      // Trip.com dapat mempertahankan node halaman sebelumnya saat halaman baru sudah
      // aktif. Karena itu jumlah card DOM total bukan bukti jumlah review baru.
      // v1.1.6 menstabilkan *fresh record population*: identitas halaman sekarang
      // dibandingkan dengan lastPageItemKeys dan hanya record baru yang dipantau.
      if (isTripLocation(currentRunUrl)) {
        const history = Array.isArray(runStore?.state?.pageHistory) ? runStore.state.pageHistory : [];
        const previousEntry = history.length ? history[history.length - 1] : null;
        const previousCount = Number(previousEntry?.itemCount || 0);
        const currentCount = Number(currentState?.itemCount || 0);
        const initialFreshness = tripRecordFreshness(currentState, previousItemKeys);
        const shouldStabilize = previousCount >= 2 && currentCount > 0 && (
          currentCount < previousCount ||
          initialFreshness.staleCount > 0 ||
          (initialFreshness.identityComparable && initialFreshness.freshCount < currentCount)
        );
        if (shouldStabilize) {
          const settledPopulation = await stabilizeTripRecordPopulation(worker, project, currentState, {
            control,
            previousItemKeys,
            timeoutMs: Math.max(7200, Math.min(9000, delayMs + 5500)),
            minStableMs: Math.max(2200, Math.min(3600, delayMs + 800)),
            staleGraceMs: Math.max(6200, Math.min(8000, delayMs + 5200))
          });
          if (settledPopulation?.state) currentState = settledPopulation.state;
          tripPopulationDiagnostic = settledPopulation?.diagnostic || tripRecordFreshness(currentState, previousItemKeys);
          const pageLabel = positiveIntOrNull(currentState?.pageNumber) ?? expectedSitePage ?? page;
          const initialFresh = Number(settledPopulation?.initialFreshCount ?? initialFreshness.freshCount ?? 0);
          const finalFresh = Number(settledPopulation?.finalFreshCount ?? tripPopulationDiagnostic.freshCount ?? 0);
          const logical = Number(currentState?.itemCount || 0);
          const raw = Number(currentState?.rawItemCount || logical);
          const stale = Number(tripPopulationDiagnostic?.staleCount || 0);
          if (finalFresh > initialFresh) {
            recordLog(`Stabilisasi Trip fresh-record halaman ${pageLabel}: review baru bertambah ${initialFresh} → ${finalFresh}; DOM akhir ${raw} card mentah / ${logical} logis, ${stale} stale dari halaman sebelumnya. Waktu ${Number(settledPopulation?.elapsedMs || 0)} ms.`);
          } else {
            recordLog(`Stabilisasi Trip fresh-record halaman ${pageLabel}: ${finalFresh} review baru stabil; DOM ${raw} card mentah / ${logical} logis, ${stale} stale dari halaman sebelumnya. Waktu ${Number(settledPopulation?.elapsedMs || 0)} ms.`);
          }
        } else if (previousItemKeys.length) {
          tripPopulationDiagnostic = initialFreshness;
        }
      }
      lastConfirmedState = currentState;
      const detectedSitePage = positiveIntOrNull(currentState.pageNumber);
      const sitePage = detectedSitePage ?? expectedSitePage ?? (page === 1 ? 1 : null);
      const fingerprint = pageStateFingerprint(currentState);
      const contentFingerprint = pageContentFingerprint(currentState);
      const priorHistory = Array.isArray(runStore?.state?.pageHistory) ? runStore.state.pageHistory : [];
      const priorContent = priorHistory.find(entry => entry?.contentFingerprint === contentFingerprint) || null;

      if (visitedContentFingerprints.has(contentFingerprint) || visitedFingerprints.has(fingerprint)) {
        const priorLabel = priorContent?.sitePage ? `halaman ${priorContent.sitePage}` : 'halaman yang sudah diproses';
        const nowLabel = sitePage ? `halaman ${sitePage}` : 'keadaan DOM saat ini';
        paginationFailure = {
          code: sitePage != null && (positiveIntOrNull(runStore?.state?.confirmedSitePage) ?? sitePage) > sitePage ? 'PAGINATION_STATE_RESET' : 'PAGINATION_CYCLE',
          message: `Keadaan review yang sama terdeteksi kembali: ${nowLabel} identik dengan ${priorLabel}.`,
          details: { sitePage, priorSitePage: priorContent?.sitePage || null, fingerprint, contentFingerprint }
        };
        onProgress({ stage:'pagination', message:`Siklus/reset pagination terdeteksi: ${paginationFailure.message}`, page, sitePage, failure:paginationFailure });
        recordLog(`Dihentikan: ${paginationFailure.message}`);
        break;
      }
      visitedFingerprints.add(fingerprint);
      visitedContentFingerprints.add(contentFingerprint);

      onProgress({ stage: 'extracting', message: `Mengambil data langkah ${page}${sitePage ? ` (halaman situs ${sitePage})` : ''}…`, page, sitePage });
      const rawRows = await extractRows(worker, project, {
        // Agoda mempertahankan node halaman sebelumnya pada DOM transisi. Bila
        // identitas record tersedia, jangan hitung node lama itu sebagai raw baru.
        excludeItemKeys: previousItemKeys
      });
      if (!rawRows.length && Number(currentState.itemCount || 0) > 0) {
        paginationFailure = {
          code: 'DOM_EXTRACTION_EMPTY',
          message: `DOM memuat ${currentState.itemCount} record tetapi extractor menghasilkan 0 baris${sitePage ? ` pada halaman ${sitePage}` : ''}.`,
          details: { sitePage, itemCount: currentState.itemCount, rawItemCount: currentState.rawItemCount }
        };
        recordLog(`Dihentikan: ${paginationFailure.message}`);
        break;
      }

      let added = 0;
      let duplicates = 0;
      let possibleDuplicates = 0;
      let requiredMissing = 0;
      let truncatedRows = 0;
      let syntheticReviewIds = 0;
      const currentPageUrl = worker.webContents.getURL();
      const sourceContext = await readSourceContext(worker, currentPageUrl, project.source);
      const capturedAt = await readCapturedAt(worker);
      const scrapedAt = formatScrapedAt(capturedAt ? new Date(capturedAt) : new Date());
      if (currentState.itemCount <= 1 && maxPages > 1) {
        recordLog('Peringatan container: hanya 1 item logis terdeteksi pada halaman ini. Untuk daftar review, ini biasanya berarti seluruh panel dipilih sebagai container.');
      }

      onProgress({ stage: 'normalizing', message: `Membersihkan dan merapikan ${rawRows.length} record pada langkah ${page}…`, page, sitePage });
      const preparedRows = [];
      for (const raw of rawRows) {
        assertNotCanceled(control);
        if (control.pauseRequested) {
          runStore?.checkpoint({ currentPage: page, currentStep: page, confirmedSitePage: sitePage, currentUrl: currentPageUrl });
          return pausedResult(runStore, previewRows, logs);
        }

        const provenance = {
          _page: sitePage ?? page,
          _step: page,
          ...(sourceContext.objectName ? { _objectName: sourceContext.objectName } : {}),
          _sourceUrl: sourceContext.sourceUrl || currentPageUrl,
          _scrapedAt: scrapedAt,
          ...(runStore?.state?.sessionId ? { _sessionId: runStore.state.sessionId } : {}),
          ...(runStore?.state?.runId ? { _runId: runStore.state.runId } : {}),
          _acquisitionMethod: project.acquisition?.method || 'dom'
        };
        // Data Mentah = hasil ekstraksi sebelum transform/normalisasi dan sebelum deduplikasi.
        runStore?.appendRawRow?.({ ...raw, ...provenance });
        const row = transformRow(raw, project, scrapedAt);
        const syntheticIdentity = ensureSyntheticReviewId(row, {
          siteProfile: project.siteProfile || '',
          siteName: sourceContext.siteName || '',
          sourceUrl: sourceContext.sourceUrl || currentPageUrl,
          objectName: sourceContext.objectName || project.reviewSubject || project.name || '',
          page: sitePage ?? page,
          sourceRecordIndex: raw?._sourceRecordIndex ?? ''
        });
        if (syntheticIdentity.generated) syntheticReviewIds += 1;
        if (hasMissingRequired(row, project.fields)) requiredMissing += 1;
        const truncation = truncationMetadata(raw, project, expansion);
        if (truncation._contentStatus) truncatedRows += 1;
        const enriched = { ...row, ...truncation, ...provenance };
        preparedRows.push(enriched);
      }

      onProgress({
        stage: 'deduplicating',
        message: `Memeriksa identitas dan duplikat ${preparedRows.length} record pada langkah ${page}…`,
        page, sitePage,
        itemsCollected: runStore?.state?.itemsCollected ?? previewRows.length,
        rawItemsRead: runStore?.state?.rawItemsRead ?? 0,
        duplicatesSkipped: runStore?.state?.exactDuplicates ?? runStore?.state?.duplicatesSkipped ?? 0
      });
      for (const enriched of preparedRows) {
        assertNotCanceled(control);
        if (runStore) {
          const result = runStore.appendRow(enriched, { recordRaw: false });
          if (!result.added) { duplicates += 1; continue; }
          if (result.possibleDuplicate) possibleDuplicates += 1;
        }
        if (previewRows.length < 300) previewRows.push(enriched);
        added += 1;
      }

      const siteLabel = sitePage != null ? ` / halaman situs ${sitePage}` : '';
      const message = `Langkah ${page}${siteLabel}: ${added} hasil cleaning baru, ${duplicates} duplikat pasti dipisahkan, ${possibleDuplicates} potensi duplikat dipertahankan, ${rawRows.length} data asli terbaca.`;
      recordLog(message);
      if (requiredMissing) recordLog(`Peringatan: ${requiredMissing} baris kehilangan minimal satu field wajib.`);
      if (truncatedRows) recordLog(`Peringatan kualitas: ${truncatedRows} baris masih ditandai terpotong; lihat _contentStatus dan _truncatedFields pada hasil ekspor.`);
      if (syntheticReviewIds) recordLog(`Identitas fallback: ${syntheticReviewIds} review Tiket tidak menyediakan ID native; dibuat review_id deterministik berprefix synthetic:tiket:.`);

      const pageHistory = priorHistory.concat([{
        step: page,
        sitePage,
        fingerprint,
        contentFingerprint,
        itemCount: Number(currentState.itemCount || 0),
        rawItemCount: Number(currentState.rawItemCount || currentState.itemCount || 0),
        itemKeys: Array.isArray(currentState.itemKeys) ? currentState.itemKeys.slice(0, 500) : [],
        ...(tripPopulationDiagnostic ? {
          freshItemCount: Number(tripPopulationDiagnostic.freshCount || 0),
          staleItemCount: Number(tripPopulationDiagnostic.staleCount || 0),
          freshItemKeys: Array.isArray(tripPopulationDiagnostic.freshKeys) ? tripPopulationDiagnostic.freshKeys.slice(0, 100) : []
        } : {}),
        capturedAt: new Date().toISOString()
      }]).slice(-600);
      runStore?.checkpoint({
        status: 'running',
        currentPage: page,
        currentStep: page,
        confirmedSitePage: sitePage,
        expectedSitePage: sitePage,
        pageCompleted: true,
        lastPageFingerprint: fingerprint,
        lastPageContentFingerprint: contentFingerprint,
        pageFingerprints: [...visitedFingerprints].slice(-600),
        contentFingerprints: [...visitedContentFingerprints].slice(-600),
        pageHistory,
        lastPageItemKeys: Array.isArray(currentState.itemKeys) ? currentState.itemKeys.slice(0, 500) : [],
        currentUrl: currentPageUrl,
        sourceUrl: sourceContext.sourceUrl || currentPageUrl,
        objectName: sourceContext.objectName || '',
        siteName: sourceContext.siteName || '',
        failure: null,
        lastMessage: message
      });
      onProgress({
        stage: 'checkpoint', message, page, sitePage,
        itemsCollected: runStore?.state?.itemsCollected ?? previewRows.length,
        rawItemsRead: runStore?.state?.rawItemsRead ?? rawRows.length,
        duplicatesSkipped: runStore?.state?.exactDuplicates ?? runStore?.state?.duplicatesSkipped ?? duplicates,
        possibleDuplicates: runStore?.state?.possibleDuplicates ?? possibleDuplicates
      });

      if (!project.pagination || project.pagination.type === 'none') break;
      if (maxPages != null && page >= maxPages) {
        // Guard terakhir: counter internal tidak boleh menyatakan selesai bila
        // paginator situs yang dapat dibaca masih berada di bawah batas target.
        if (sitePage != null && maxPages > 1 && sitePage < maxPages && project.pagination.type === 'next') {
          paginationFailure = {
            code: 'PAGINATION_COUNTER_DRIFT',
            message: `Batas langkah ${maxPages} tercapai, tetapi paginator situs baru berada di halaman ${sitePage}. Run tidak ditandai selesai agar data tidak dianggap lengkap secara keliru.`,
            details: { step: page, sitePage, maxPages }
          };
          recordLog(`Dihentikan: ${paginationFailure.message}`);
        } else {
          // Sebelum menandai completed_step_limit, lakukan inspeksi terminal read-only.
          // Bukti generik tetap Next=disabled. Khusus Tiket, paginator terminal dapat
          // menghapus chevron Next; karena itu v1.1.6 mengambil tiga sampel read-only
          // dan hanya menerima akhir sumber bila semuanya konsisten pada halaman angka
          // terakhir, halaman pendek, serta tidak ada Next terkonfigurasi/semantik.
          let terminalInspectionState = currentState;
          try { terminalInspectionState = await readPageState(worker, project); }
          catch { /* gunakan state terakhir yang sudah terverifikasi */ }
          const terminalSamples = [terminalInspectionState || currentState || {}];
          if (isTiketLocation(currentRunUrl)) {
            for (let sampleIndex = 0; sampleIndex < 2; sampleIndex += 1) {
              try {
                await interruptibleSleep(260, control);
                terminalSamples.push(await readPageState(worker, project));
              } catch { break; }
            }
          }
          const previousPageCount = Number(priorHistory?.[priorHistory.length - 1]?.itemCount || 0);
          const terminalInspection = inspectTerminalStateAtStepLimit(terminalSamples[terminalSamples.length - 1] || currentState || {}, {
            siteProfile: project.siteProfile || '',
            sourceUrl: currentRunUrl,
            previousItemCount: previousPageCount,
            samples: terminalSamples
          });
          if (terminalInspection.confirmed) {
            const terminalMessage = terminalInspection.message || `Akhir sumber terverifikasi pada batas langkah ${maxPages}.`;
            terminalSourceEnd = {
              code: 'PAGINATION_END_REACHED',
              message: terminalMessage,
              page,
              sitePage: terminalInspection.pageNumber ?? sitePage,
              evidence: terminalInspection.evidence
            };
            recordLog(`Batas langkah ${maxPages} bertepatan dengan akhir sumber. ${terminalMessage}`);
            runStore?.checkpoint({
              sourceEndReason: 'PAGINATION_END_REACHED',
              sourceEndMessage: terminalMessage,
              completionReason: null,
              completionMessage: null,
              failure: null
            });
            onProgress({
              stage: 'pagination-end',
              message: terminalMessage,
              page,
              sitePage: terminalInspection.pageNumber ?? sitePage,
              terminalInspection: true,
              terminalEvidence: terminalInspection.evidence
            });
          } else {
            if (isTiketLocation(currentRunUrl)) {
              const sample = terminalSamples[terminalSamples.length - 1] || {};
              recordLog(`Inspeksi terminal Tiket belum cukup untuk mengklaim akhir sumber: halaman=${positiveIntOrNull(sample.pageNumber) ?? '-'}; halaman numerik terakhir=${positiveIntOrNull(sample.lastPageNumber) ?? '-'}; record=${Number(sample.itemCount || 0)}; record halaman sebelumnya=${previousPageCount || 0}; marker=${String(sample.pageNumberSource || '-')}; kontrol angka=${Number(sample.numericPageControlCount || 0)}; Next semantik=${Number(sample.nextControlCount || 0)}; Next terkonfigurasi=${Number(sample.configuredNextControlCount || 0)}.`);
            }
            userStepLimitReached = true;
            const stepMessage = `Batas langkah pengguna ${maxPages} tercapai. Run selesai sesuai cakupan yang diminta; akhir sumber belum terverifikasi tanpa navigasi tambahan.`;
            recordLog(stepMessage);
            runStore?.checkpoint({
              sourceEndReason: null,
              sourceEndMessage: null,
              completionReason:'USER_STEP_LIMIT_REACHED',
              completionMessage:stepMessage
            });
          }
        }
        break;
      }
      if (control.pauseRequested) return pausedResult(runStore, previewRows, logs);

      const advanced = await advancePagination(worker, project, delayMs, control, onProgress, page, {
        currentSitePage: sitePage,
        knownContentFingerprints: visitedContentFingerprints
      });
      if (!advanced.ok) {
        if (isTerminalPaginationCode(advanced.code)) {
          const terminalMessage = advanced.message || 'Halaman terakhir dari sumber telah tercapai.';
          terminalSourceEnd = { code: advanced.code, message: terminalMessage, page, sitePage };
          recordLog(`Sumber berhenti: ${terminalMessage}`);
          runStore?.checkpoint({ sourceEndReason: advanced.code, sourceEndMessage: terminalMessage, failure: null });
          onProgress({ stage:'pagination-end', message:terminalMessage, page, sitePage });
          break;
        }
        paginationFailure = {
          code: advanced.code || 'PAGINATION_FAILED',
          message: advanced.message || `Pagination “${project.pagination.type}” tidak dapat dilanjutkan.`,
          details: advanced.transition || advanced
        };
        if (isTripLocation(currentPageUrl)) {
          const observed = positiveIntOrNull(advanced?.transition?.state?.pageNumber) ?? positiveIntOrNull(advanced?.toPage);
          recordLog(`Diagnostik Trip: target ${sitePage != null ? sitePage + 1 : '?'}; strategi ${advanced.selectionSource || 'tidak-terverifikasi'}; selector ${advanced.selectorUsed || '-'}; kontrol ${positiveIntOrNull(advanced.pageNumber) ?? '-'}; halaman teramati ${observed ?? '-'}.`);
        }
        recordLog(`Dihentikan: ${paginationFailure.message}`);
        break;
      }
      if (advanced.selectorUsed) recordLog(`Pagination: selector aktif ${advanced.selectorUsed}${advanced.selectionSource ? ` (${advanced.selectionSource})` : ''}`);
      if (isTripLocation(currentPageUrl)) {
        recordLog(`Diagnostik Trip: target ${advanced.toPage ?? (sitePage != null ? sitePage + 1 : '?')}; strategi ${advanced.selectionSource || 'unknown'}; kontrol ${positiveIntOrNull(advanced.pageNumber) ?? '-'}; semantic-next ${advanced.semanticNext ? 'ya' : 'tidak'}; sisi-kanan ${advanced.rightmostAfterNumbers ? 'ya' : 'tidak'}.`);
      }
      if (advanced.fromPage && advanced.toPage) recordLog(`Pagination terkonfirmasi: halaman ${advanced.fromPage} → ${advanced.toPage}.`);
      if (advanced.recovered) recordLog(`Pagination recovery: halaman target ${advanced.toPage} diverifikasi ulang setelah SPA kembali ke state lama.`);
      const nextExpectedSitePage = positiveIntOrNull(advanced.toPage) ?? (sitePage != null ? sitePage + 1 : null);
      runStore?.checkpoint({
        currentPage: page + 1,
        currentStep: page + 1,
        pageCompleted: false,
        expectedSitePage: nextExpectedSitePage,
        currentUrl: worker.webContents.getURL(),
        failure: null
      });
      page += 1;
    }

    const count = runStore?.state?.itemsCollected ?? previewRows.length;
    const incomplete = Boolean(paginationFailure);
    if (incomplete) {
      const failure = {
        code: paginationFailure.code || 'PAGINATION_FAILED',
        message: paginationFailure.message || String(paginationFailure),
        details: paginationFailure.details || null,
        step: page,
        sitePage: positiveIntOrNull(lastConfirmedState?.pageNumber) ?? positiveIntOrNull(runStore?.state?.confirmedSitePage),
        recordedAt: new Date().toISOString()
      };
      runStore?.checkpoint({ failure });
      runStore?.markInterrupted(`Run parsial: ${failure.message}`);
      onProgress({ stage: 'error', message: `Run parsial: ${count} baris tersimpan. ${failure.message}`, page, sitePage: failure.sitePage, itemsCollected: count, failure });
    } else {
      const sourceLimited = terminalSourceEnd?.code === 'SOURCE_LIMIT_REACHED' || runStore?.state?.sourceEndReason === 'SOURCE_LIMIT_REACHED';
      if (sourceLimited) {
        const limitMessage = terminalSourceEnd?.message || runStore?.state?.sourceEndMessage || 'Sumber berhenti pada batas retrieval yang diamati.';
        runStore?.markCompletedSourceLimit(`Selesai pada batas sumber: ${count} hasil cleaning tersimpan. ${limitMessage}`);
        onProgress({ stage: 'done', message: `Selesai pada batas sumber: ${count} hasil cleaning.`, page, sitePage: runStore?.state?.confirmedSitePage ?? null, itemsCollected: count, rawItemsRead: runStore?.state?.rawItemsRead ?? count, duplicatesSkipped: runStore?.state?.exactDuplicates ?? 0, possibleDuplicates: runStore?.state?.possibleDuplicates ?? 0, sourceLimited:true });
      } else if (userStepLimitReached) {
        const stepMessage = `Selesai sesuai batas langkah ${maxPages}: ${count} hasil cleaning tersimpan. Akhir sumber belum diuji setelah langkah terakhir.`;
        runStore?.markCompletedStepLimit(stepMessage);
        onProgress({ stage: 'done', message: `Selesai sesuai batas langkah ${maxPages}: ${count} hasil cleaning.`, page, sitePage: runStore?.state?.confirmedSitePage ?? null, itemsCollected: count, rawItemsRead: runStore?.state?.rawItemsRead ?? count, duplicatesSkipped: runStore?.state?.exactDuplicates ?? 0, possibleDuplicates: runStore?.state?.possibleDuplicates ?? 0, stepLimited:true, maxPages });
      } else {
        const sourceEnded = terminalSourceEnd?.code === 'PAGINATION_END_REACHED' || runStore?.state?.sourceEndReason === 'PAGINATION_END_REACHED';
        const completedMessage = sourceEnded
          ? `Selesai: ${count} hasil cleaning tersimpan; akhir sumber terverifikasi.`
          : `Selesai: ${count} hasil cleaning tersimpan; ${runStore?.state?.exactDuplicates || 0} duplikat pasti dipisahkan.`;
        runStore?.markCompleted(completedMessage);
        onProgress({ stage: 'done', message: sourceEnded ? `Selesai: ${count} hasil cleaning; akhir sumber terverifikasi.` : `Selesai: ${count} hasil cleaning.`, page, sitePage: runStore?.state?.confirmedSitePage ?? null, itemsCollected: count, rawItemsRead: runStore?.state?.rawItemsRead ?? count, duplicatesSkipped: runStore?.state?.exactDuplicates ?? 0, possibleDuplicates: runStore?.state?.possibleDuplicates ?? 0, sourceEnded });
      }
    }
    const sourceLimited = !incomplete && (terminalSourceEnd?.code === 'SOURCE_LIMIT_REACHED' || runStore?.state?.sourceEndReason === 'SOURCE_LIMIT_REACHED');
    const sourceEnded = !incomplete && (terminalSourceEnd?.code === 'PAGINATION_END_REACHED' || runStore?.state?.sourceEndReason === 'PAGINATION_END_REACHED');
    const stepLimited = !incomplete && !sourceEnded && (userStepLimitReached || runStore?.state?.completionReason === 'USER_STEP_LIMIT_REACHED');
    return {
      ok: !incomplete,
      partial: incomplete,
      sourceLimited,
      sourceEnded,
      stepLimited,
      paused: false,
      runDir: runStore?.runDir || null,
      rows: runStore ? runStore.readRows({ limit: 300 }) : previewRows,
      totalRows: count,
      logs,
      failure: incomplete ? runStore?.state?.failure || paginationFailure : null,
      state: runStore?.state || null
    };
  } catch (error) {
    if (error && error.code === 'RUN_CANCELED') {
      runStore?.markInterrupted('Run dihentikan oleh pengguna.');
      return { ok: false, canceled: true, runDir: runStore?.runDir || null, rows: previewRows, logs, error: 'Run dihentikan.' };
    }
    runStore?.markFailed(error);
    const failure = { code: error.code || 'INTERNAL_ERROR', message: error.message, details: error.details || null, recordedAt: new Date().toISOString() };
    runStore?.checkpoint({ failure });
    onProgress({ stage: 'error', message: error.message, runDir: runStore?.runDir, failure });
    return {
      ok: false,
      runDir: runStore?.runDir || null,
      rows: runStore ? runStore.readRows({ limit: 300 }) : previewRows,
      totalRows: runStore?.state?.itemsCollected ?? previewRows.length,
      logs,
      error: error.message,
      failure: runStore?.state?.failure || { code: error.code || 'INTERNAL_ERROR', message: error.message },
      state: runStore?.state || null
    };
  } finally {
    if (ownsWorker && worker && !worker.isDestroyed()) worker.destroy();
  }
}

async function runCrawlMode(ctx) {
  const { worker, project, runStore, control, resume, previewRows, logs, recordLog, onProgress, delayMs, timeoutMs, retryCount } = ctx;
  const crawl = project.crawl || {};
  const maxUrls = clamp(crawl.maxUrls ?? 100, 1, 5000);
  const maxDepth = clamp(crawl.maxDepth ?? 2, 0, 10);
  const initialUrl = worker.webContents.getURL() || project.startUrl;
  const startCanonical = normalizeCrawlUrl(initialUrl, initialUrl);
  let queue = [];
  let visited = new Set();

  if (resume && Array.isArray(runStore?.state?.crawlQueue) && Array.isArray(runStore?.state?.crawlVisited)) {
    queue = runStore.state.crawlQueue.filter(x => x && x.url).map(x => ({ url: String(x.url), depth: Number(x.depth) || 0 }));
    visited = new Set(runStore.state.crawlVisited.map(String));
    recordLog(`Resume crawl: ${queue.length} URL menunggu, ${visited.size} URL sudah dikunjungi.`);
  } else {
    queue = [{ url: startCanonical || initialUrl, depth: 0 }];
  }

  const origin = new URL(startCanonical || initialUrl);
  let index = visited.size;
  let failedPages = 0;
  runStore?.checkpoint({ crawlQueue: queue, crawlVisited: [...visited], crawlMode: true });

  while (queue.length && visited.size < maxUrls) {
    assertNotCanceled(control);
    if (control.pauseRequested) {
      runStore?.checkpoint({ crawlQueue: queue, crawlVisited: [...visited], currentPage: index + 1 });
      return pausedResult(runStore, previewRows, logs);
    }

    const current = queue.shift();
    const url = normalizeCrawlUrl(current.url, origin.href);
    if (!url || visited.has(url) || current.depth > maxDepth || !isAllowedCrawlUrl(url, origin, crawl)) continue;
    visited.add(url);
    index += 1;

    const loadedUrl = worker.webContents.getURL();
    if (normalizeCrawlUrl(loadedUrl, origin.href) !== url) {
      onProgress({ stage: 'crawling', message: `Membuka URL ${index}/${maxUrls} · kedalaman ${current.depth}…`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length });
      try {
        await withRetry(() => loadUrl(worker, url, timeoutMs), retryCount, delayMs, onProgress, 'membuka URL crawl');
        await waitForSettled(worker, Math.min(delayMs, 5000), control);
      } catch (error) {
        failedPages += 1;
        recordLog(`URL gagal: ${url} · ${error.message}`);
        runStore?.checkpoint({ currentPage: index, currentUrl: url, crawlQueue: queue, crawlVisited: [...visited], crawlFailed: failedPages });
        continue;
      }
    }

    const access = await readAccessState(worker);
    if (access !== 'ok') {
      failedPages += 1;
      recordLog(`URL dilewati (${access}): ${url}`);
      onProgress({ stage: 'access-guard', message: `Halaman dilewati karena status akses: ${access}.`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length });
      runStore?.checkpoint({ currentPage: index, currentUrl: url, crawlQueue: queue, crawlVisited: [...visited], crawlFailed: failedPages });
      continue;
    }

    onProgress({ stage: 'expanding', message: `Membuka teks terpotong dari URL ${index}…`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length });
    const expansion = await expandTruncatedContent(worker, project);
    recordExpansionLog(expansion, recordLog, `Crawl URL ${index}`);
    onProgress({ stage: 'extracting', message: `Membaca data dari URL ${index}…`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length });
    const rawRows = await extractRows(worker, project);
    const sourceContext = await readSourceContext(worker, url, project.source);
    const capturedAt = await readCapturedAt(worker);
    const scrapedAt = formatScrapedAt(capturedAt ? new Date(capturedAt) : new Date());
    let added = 0, duplicates = 0, possibleDuplicates = 0, requiredMissing = 0, truncatedRows = 0;
    onProgress({ stage: 'normalizing', message: `Membersihkan dan merapikan ${rawRows.length} record dari URL ${index}…`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length });
    const preparedRows = [];
    for (const raw of rawRows) {
      assertNotCanceled(control);
      const provenance = {
        _page: index,
        _crawlDepth: current.depth,
        ...(sourceContext.objectName ? { _objectName: sourceContext.objectName } : {}),
        _sourceUrl: sourceContext.sourceUrl || url,
        _scrapedAt: scrapedAt,
        ...(runStore?.state?.sessionId ? { _sessionId: runStore.state.sessionId } : {}),
        ...(runStore?.state?.runId ? { _runId: runStore.state.runId } : {}),
        _acquisitionMethod: project.acquisition?.method || 'dom'
      };
      runStore?.appendRawRow?.({ ...raw, ...provenance });
      const row = transformRow(raw, project, scrapedAt);
      if (hasMissingRequired(row, project.fields)) requiredMissing += 1;
      const truncation = truncationMetadata(raw, project, expansion);
      if (truncation._contentStatus) truncatedRows += 1;
      const enriched = { ...row, ...truncation, ...provenance };
      preparedRows.push(enriched);
    }
    onProgress({ stage: 'deduplicating', message: `Memeriksa identitas dan duplikat ${preparedRows.length} record dari URL ${index}…`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length, itemsCollected: runStore?.state?.itemsCollected ?? previewRows.length, rawItemsRead: runStore?.state?.rawItemsRead ?? 0, duplicatesSkipped: runStore?.state?.exactDuplicates ?? runStore?.state?.duplicatesSkipped ?? 0 });
    for (const enriched of preparedRows) {
      assertNotCanceled(control);
      if (runStore) {
        const result = runStore.appendRow(enriched, { recordRaw: false });
        if (!result.added) { duplicates += 1; continue; }
        if (result.possibleDuplicate) possibleDuplicates += 1;
      }
      if (previewRows.length < 300) previewRows.push(enriched);
      added += 1;
    }

    onProgress({ stage: 'discovering', message: `Mencari tautan baru dari URL ${index}…`, page: index, currentUrl: url, visitedUrls: visited.size, queuedUrls: queue.length });
    if (current.depth < maxDepth) {
      const links = await discoverLinks(worker);
      for (const rawLink of links) {
        if (visited.size + queue.length >= maxUrls * 3) break;
        const next = normalizeCrawlUrl(rawLink, url);
        if (!next || visited.has(next) || queue.some(x => x.url === next) || !isAllowedCrawlUrl(next, origin, crawl)) continue;
        queue.push({ url: next, depth: current.depth + 1 });
      }
    }

    const message = `Crawl URL ${index}: ${added} hasil cleaning baru, ${duplicates} duplikat pasti dipisahkan, ${possibleDuplicates} potensi duplikat dipertahankan, ${rawRows.length} data asli terbaca · antrean ${queue.length}.`;
    recordLog(message);
    if (requiredMissing) recordLog(`Peringatan: ${requiredMissing} baris kehilangan minimal satu field wajib.`);
    if (truncatedRows) recordLog(`Peringatan kualitas: ${truncatedRows} baris masih ditandai terpotong; lihat _contentStatus dan _truncatedFields pada hasil ekspor.`);
    runStore?.checkpoint({
      status: 'running', currentPage: index, currentUrl: url, lastMessage: message,
      sourceUrl: sourceContext.sourceUrl || url,
      objectName: sourceContext.objectName || '', siteName: sourceContext.siteName || '',
      crawlQueue: queue, crawlVisited: [...visited], crawlFailed: failedPages,
      crawlDepth: current.depth
    });
    onProgress({
      stage: 'checkpoint', message, page: index, currentUrl: url,
      itemsCollected: runStore?.state?.itemsCollected ?? previewRows.length,
      rawItemsRead: runStore?.state?.rawItemsRead ?? rawRows.length,
      duplicatesSkipped: runStore?.state?.exactDuplicates ?? runStore?.state?.duplicatesSkipped ?? duplicates,
      possibleDuplicates: runStore?.state?.possibleDuplicates ?? possibleDuplicates,
      visitedUrls: visited.size, queuedUrls: queue.length
    });
  }

  const count = runStore?.state?.itemsCollected ?? previewRows.length;
  const exhaustedByLimit = visited.size >= maxUrls && queue.length > 0;
  const finishMessage = exhaustedByLimit
    ? `Crawl berhenti pada batas ${maxUrls} URL: ${count} baris unik tersimpan.`
    : `Crawl selesai: ${visited.size} URL dikunjungi, ${count} baris unik tersimpan.`;
  runStore?.markCompleted(finishMessage);
  runStore?.checkpoint({ crawlQueue: queue, crawlVisited: [...visited], crawlFailed: failedPages });
  onProgress({ stage: 'done', message: finishMessage, page: index, itemsCollected: count, rawItemsRead: runStore?.state?.rawItemsRead ?? count, duplicatesSkipped: runStore?.state?.exactDuplicates ?? 0, possibleDuplicates: runStore?.state?.possibleDuplicates ?? 0, visitedUrls: visited.size, queuedUrls: queue.length });
  return {
    ok: true, partial: false, paused: false, runDir: runStore?.runDir || null,
    rows: runStore ? runStore.readRows({ limit: 300 }) : previewRows,
    totalRows: count, logs, state: runStore?.state || null,
    crawl: { visitedUrls: visited.size, queuedUrls: queue.length, failedPages }
  };
}

async function discoverLinks(win) {
  return await win.webContents.executeJavaScript(`(() => {
    const out=[]; const seen=new Set();
    for(const a of document.querySelectorAll('a[href]')){
      try{const url=new URL(a.getAttribute('href'),location.href);if(!/^https?:$/.test(url.protocol))continue;url.hash='';const value=url.href;if(!seen.has(value)){seen.add(value);out.push(value);}if(out.length>=3000)break;}catch{}
    }
    return out;
  })()`, true);
}

async function readAccessState(win) {
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const text=((document.title||'')+' '+(document.body?.innerText||'')).slice(0,30000).toLowerCase();
      if(/access is temporarily restricted|unusual activity|akses\s+dibatasi\s+(?:untuk\s+)?sementara|akses\s+sementara\s+dibatasi|pemblokiran ini perlu|access denied|forbidden/.test(text))return 'restricted';
      if(/captcha|verify you are human|security check|challenge/.test(text))return 'challenge';
      if(!document.body)return 'unknown';
      return 'ok';
    })()`,true);
  } catch { return 'unknown'; }
}

function normalizeCrawlUrl(raw, base) {
  try {
    const u = new URL(String(raw || ''), base);
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|mc_)/i.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch { return ''; }
}

function registrableHost(hostname) {
  const parts=String(hostname||'').toLowerCase().split('.').filter(Boolean);
  return parts.length<=2?parts.join('.'):parts.slice(-2).join('.');
}

function isAllowedCrawlUrl(url, origin, crawl = {}) {
  let u; try { u=new URL(url); } catch { return false; }
  const scope=crawl.scope||'same-host';
  if(scope==='same-host' && u.host!==origin.host) return false;
  if(scope==='same-domain' && registrableHost(u.hostname)!==registrableHost(origin.hostname)) return false;
  if(scope==='path') {
    if(u.host!==origin.host) return false;
    const basePath=origin.pathname.replace(/[^/]+$/,'');
    if(basePath && !u.pathname.startsWith(basePath)) return false;
  }
  const includes=splitPatterns(crawl.include); const excludes=splitPatterns(crawl.exclude);
  if(includes.length && !includes.some(p=>urlMatchesPattern(u.href,p))) return false;
  if(excludes.some(p=>urlMatchesPattern(u.href,p))) return false;
  return true;
}

function splitPatterns(value) {
  if(Array.isArray(value)) return value.map(String).map(x=>x.trim()).filter(Boolean);
  return String(value||'').split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean);
}

function urlMatchesPattern(url, pattern) {
  const p=String(pattern||'').trim(); if(!p)return false;
  if(p.startsWith('/') && p.endsWith('/') && p.length>2){try{return new RegExp(p.slice(1,-1),'i').test(url);}catch{}}
  if(p.includes('*')){const escaped=p.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*');try{return new RegExp(escaped,'i').test(url);}catch{}}
  return url.toLowerCase().includes(p.toLowerCase());
}

function pausedResult(runStore, previewRows, logs, options = {}) {
  runStore?.markPaused(options.message || 'Run dijeda oleh pengguna.');
  const count = runStore?.state?.itemsCollected ?? previewRows.length;
  return {
    ok: true,
    paused: true,
    runDir: runStore?.runDir || null,
    rows: runStore ? runStore.readRows({ limit: 300 }) : previewRows,
    totalRows: count,
    logs,
    state: runStore?.state || null,
    ...(options.accessIssue ? { accessIssue: options.accessIssue } : {})
  };
}

async function expandTruncatedContent(win, project) {
  const empty = {
    found: 0,
    expanded: 0,
    failed: 0,
    unresolvedRecordIndexes: [],
    expandedRecordIndexes: [],
    labels: []
  };
  if (project?.settings?.expandTruncatedText === false || !project?.itemSelector) return empty;
  try {
    const result = await win.webContents.executeJavaScript(buildExpansionScript({
      itemSelector: project.itemSelector,
      maxControls: 120,
      waitMs: 1500,
      pollMs: 70
    }), true);
    if (!result || typeof result !== 'object') return empty;
    return {
      found: Math.max(0, Number(result.found) || 0),
      expanded: Math.max(0, Number(result.expanded) || 0),
      failed: Math.max(0, Number(result.failed) || 0),
      unresolvedRecordIndexes: Array.isArray(result.unresolvedRecordIndexes)
        ? result.unresolvedRecordIndexes.map(Number).filter(Number.isFinite)
        : [],
      expandedRecordIndexes: Array.isArray(result.expandedRecordIndexes)
        ? result.expandedRecordIndexes.map(Number).filter(Number.isFinite)
        : [],
      labels: Array.isArray(result.labels) ? result.labels.map(String).slice(0, 12) : []
    };
  } catch (error) {
    return { ...empty, error: error?.message || String(error) };
  }
}

function recordExpansionLog(result, recordLog, context = 'Halaman') {
  if (!result) return;
  if (result.error) {
    recordLog(`${context}: pemeriksaan teks terpotong gagal (${result.error}); ekstraksi tetap dilanjutkan dengan penanda kualitas.`);
    return;
  }
  if (!result.found) return;
  if (result.failed) {
    recordLog(`${context}: ${result.expanded}/${result.found} teks terpotong berhasil dibuka; ${result.failed} belum dapat dibuka dan akan ditandai pada hasil.`);
  } else {
    recordLog(`${context}: ${result.expanded}/${result.found} teks terpotong berhasil dibuka sebelum ekstraksi.`);
  }
}

function truncationMetadata(raw, project, expansion = null) {
  const fields = Array.isArray(project?.fields) ? project.fields : [];
  const failed = new Set(Array.isArray(expansion?.unresolvedRecordIndexes) ? expansion.unresolvedRecordIndexes : []);
  const sourceIndex = Number(raw?._sourceRecordIndex);
  const expansionFailed = Number.isFinite(sourceIndex) && failed.has(sourceIndex);
  const markedFields = fields
    .filter(field => {
      const value = raw?.[field.name];
      if (hasTruncationMarker(value)) return true;
      if (!expansionFailed) return false;
      const semantics = `${field.name || ''} ${field.semanticRole || ''}`;
      return /(review|comment|content|body|description|text)/i.test(semantics);
    })
    .map(field => field.name);
  if (!markedFields.length && expansionFailed) {
    const textField = fields.find(field => (field.extract || 'text') === 'text');
    if (textField) markedFields.push(textField.name);
  }
  if (!markedFields.length) return {};
  return {
    _contentStatus: 'truncated',
    _truncatedFields: [...new Set(markedFields)].join(', ')
  };
}

function ensureSyntheticReviewId(row, context = {}) {
  if (!row || typeof row !== 'object') return { generated:false, id:'' };
  const existing = row.review_id ?? row.reviewId ?? row.reviewid ?? row.comment_id ?? row.commentId ?? row.writing_id ?? row.writingId ?? row.submit_id ?? row.submitId;
  if (existing != null && String(existing).trim()) return { generated:false, id:String(existing).trim() };
  const siteHint = `${context.siteProfile || ''} ${context.siteName || ''} ${context.sourceUrl || ''}`;
  if (!/(?:^|\s|\.)tiket(?:\.com)?(?:\s|$|\/)/i.test(siteHint)) return { generated:false, id:'' };
  const norm = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('id-ID');
  const semanticParts = [
    norm(context.objectName),
    norm(row.review_date),
    norm(row.reviewer_name),
    norm(row.review_text),
    norm(row.rating_score),
    norm(row.rating_max),
    norm(row.room_type),
    norm(row.traveler_type ?? row.travel_type),
    norm(row.stay_detail)
  ];
  const substantive = semanticParts.filter(value => value.length >= 2);
  if (substantive.length < 3) return { generated:false, id:'' };
  const identityParts = [...semanticParts, norm(context.page), norm(context.sourceRecordIndex)];
  const digest = crypto.createHash('sha256').update(identityParts.join('|')).digest('hex').slice(0,24);
  const id = `synthetic:tiket:${digest}`;
  row.review_id = id;
  // Prefix pada review_id memastikan ID tidak disalahartikan sebagai ID native.
  // Metadata internal ini tetap tersedia pada ekspor sesi untuk provenance teknis.
  row._reviewIdSource = 'synthetic';
  row._reviewIdReason = 'source-id-unavailable';
  return { generated:true, id };
}

function transformRow(raw, project, scrapedAt = null) {
  const fields = Array.isArray(project?.fields) ? project.fields : [];
  const row = {};
  const identity = project?.itemIdentity || project?.itemMeta?.identity || null;
  const identityName = String(raw?._recordIdName || identity?.suggestedName || 'record_id');
  if (raw?._recordId != null && String(raw._recordId) !== '') row[identityName] = raw._recordId;
  for (const field of fields) row[field.name] = applyTransform(raw[field.name], field);
  const hasConfiguredRatingMax = fields.some(field => /rating[_\s-]*max|max[_\s-]*score|rating[_\s-]*scale/i.test(`${field.name || ''} ${field.semanticRole || ''}`));
  if (!hasConfiguredRatingMax && raw?.rating_max != null && String(raw.rating_max).trim() !== '') {
    row.rating_max = applyTransform(raw.rating_max, { name:'rating_max', semanticRole:'rating_max', dataType:'number', transform:'extractNumber' });
  }
  if (scrapedAt) row._scrapedAt = scrapedAt;
  return sanitizeExportRow(row);
}

function hasMissingRequired(row, fields) {
  return fields.some(field => field.required && (row[field.name] == null || row[field.name] === ''));
}

function validateProject(project) {
  if (!project || typeof project !== 'object') throw new Error('Proyek tidak valid.');
  if (!/^https?:\/\//i.test(project.startUrl) && !/^file:\/\//i.test(project.startUrl)) {
    throw new Error('URL awal harus menggunakan http://, https://, atau file://.');
  }
  if (!project.itemSelector) throw new Error('Batas satu record belum ditentukan. Pilih field pertama agar struktur dapat dideteksi otomatis.');
  if (!Array.isArray(project.fields) || project.fields.length === 0) throw new Error('Tambahkan minimal satu field.');
  const names = new Set();
  for (const field of project.fields) {
    if (!field.name) throw new Error('Setiap field harus mempunyai nama.');
    if (names.has(field.name)) throw new Error(`Nama field duplikat: ${field.name}`);
    names.add(field.name);
  }
}

async function loadUrl(win, url, timeoutMs) {
  let timeout;
  try {
    const timer = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timeout saat membuka ${url}`)), timeoutMs);
    });
    const loader = typeof win.loadURL === 'function' ? win.loadURL(url) : win.webContents.loadURL(url);
    await Promise.race([loader, timer]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readCapturedAt(win) {
  try {
    const raw = await win.webContents.executeJavaScript(`(() => document.querySelector('meta[name="petikdata-captured-at"]')?.getAttribute('content') || '')()`, true);
    const parsed = new Date(String(raw || ''));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  } catch {
    return '';
  }
}

async function readSourceContext(win, fallback = '', projectSource = null) {
  try {
    const signals = await win.webContents.executeJavaScript(`(() => {
      const structuredNames=[];
      const addStructured=value=>{
        if(!value||typeof value!=='object')return;
        const type=Array.isArray(value['@type'])?value['@type'].join(' '):String(value['@type']||'');
        if(/hotel|lodgingbusiness|resort|hostel|accommodation|product|localbusiness/i.test(type)&&typeof value.name==='string') structuredNames.push(value.name);
        if(Array.isArray(value['@graph'])) value['@graph'].forEach(addStructured);
        if(value.item&&typeof value.item==='object') addStructured(value.item);
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script=>{
        try{const parsed=JSON.parse(script.textContent||'null');(Array.isArray(parsed)?parsed:[parsed]).forEach(addStructured);}catch{}
      });
      const meta=(selector,attribute='content')=>document.querySelector(selector)?.getAttribute(attribute)||'';
      const importedSourceUrl=meta('meta[name="petikdata-source-url"]');
      const canonicalUrl=importedSourceUrl||meta('link[rel="canonical"]','href')||meta('meta[property="og:url"]');
      const identityUrls=[];
      for(const node of document.childNodes){
        if(node.nodeType!==8)continue;
        const text=String(node.nodeValue||'').trim();const urlIndex=text.indexOf('http');
        if(text.toLowerCase().includes('saved from url=')&&urlIndex>=0)identityUrls.push(text.slice(urlIndex).trim());
      }
      document.querySelectorAll('link[href*="inventory_id=" i],link[href*="hotel_id=" i],a[href*="inventory_id=" i],a[href*="hotel_id=" i]').forEach(node=>{
        const href=node.getAttribute('href')||'';if(/^https?:/i.test(href))identityUrls.push(href);
      });
      try{
        const next=JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent||'null');
        const query=next?.query||next?.props?.pageProps?.query||null;
        if(query&&typeof query==='object'&&Object.keys(query).some(key=>/^(?:inventory_id|hotel_id|property_id|product_id)$/i.test(key))){
          const hinted=new URL(canonicalUrl||location.href,location.href);
          for(const [key,value] of Object.entries(query))if(value!=null&&typeof value!=='object')hinted.searchParams.set(key,String(value));
          identityUrls.push(hinted.href);
        }
      }catch{}
      return {
        url:location.href,
        canonicalUrl,
        identityUrls:[...new Set(identityUrls)].slice(0,10),
        title:document.title||'',
        structuredNames:[...new Set(structuredNames)].slice(0,10),
        metaNames:[
          meta('meta[property="og:title"]'),
          meta('meta[name="twitter:title"]'),
          meta('meta[itemprop="name"]')
        ].filter(Boolean),
        headings:[...document.querySelectorAll('h1,h2,[data-testid*="hotel-name" i],[data-testid*="property-name" i]')]
          .map(node=>(node.textContent||'').trim()).filter(Boolean).slice(0,15)
      };
    })()`, true);
    const normalizedSignals = typeof signals === 'string'
      ? { url: fallback, canonicalUrl: signals }
      : { ...(signals || {}), url: signals?.url || fallback };
    return resolveSourceContext({
      ...normalizedSignals,
      preferredObjectName: projectSource?.objectName || ''
    });
  } catch {
    return resolveSourceContext({
      url: fallback,
      preferredObjectName: projectSource?.objectName || ''
    });
  }
}

async function waitForSettled(win, delayMs, control = {}) {
  await interruptibleSleep(delayMs, control);
  try {
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      if (document.readyState === 'complete') return resolve(true);
      window.addEventListener('load', () => resolve(true), { once: true });
      setTimeout(() => resolve(true), 5000);
    })`, true);
  } catch {}
}

async function extractRows(win, project, options = {}) {
  const payload = {
    itemSelector: project.itemSelector,
    itemKeyAttribute: project.itemKeyAttribute || project.itemMeta?.keyAttribute || null,
    itemIdentity: project.itemIdentity || project.itemMeta?.identity || null,
    siteProfile: project.siteProfile || 'auto',
    excludeItemKeys: Array.isArray(options.excludeItemKeys) ? options.excludeItemKeys.map(String).slice(0, 1000) : [],
    fields: project.fields.map(field => ({
      name: field.name,
      selector: field.selector,
      selectors: field.selectors,
      extract: field.extract,
      attribute: field.attribute,
      jsonPath: field.jsonPath,
      regex: field.regex,
      regexFlags: field.regexFlags,
      expectedSignature: field.expectedSignature || '',
      targetTag: field.targetTag || '',
      targetClasses: field.targetClasses || [],
      semanticRole: field.semanticRole || ''
    }))
  };
  const code = String.raw`(() => {
    const cfg = ${JSON.stringify(payload)};
    const allRoots = [...document.querySelectorAll(cfg.itemSelector)];
    const getPath = (obj, path) => !path ? obj : String(path).split('.').filter(Boolean).reduce((cur, key) => cur == null ? null : cur[key], obj);
    const parseJson = raw => { try { return raw == null ? null : JSON.parse(raw); } catch { return null; } };
    const fieldLooks = (field, pattern) => pattern.test(String(field?.name || '') + ' ' + String(field?.semanticRole || ''));
    const scanJsonValue = (root, names) => {
      const wanted = new Set(names.map(name => String(name).toLowerCase().replace(/[^a-z0-9]/g,'')));
      const walk = (obj, depth = 0) => {
        if (obj == null || depth > 7) return null;
        if (Array.isArray(obj)) { for (const item of obj.slice(0,30)) { const hit = walk(item, depth + 1); if (hit != null) return hit; } return null; }
        if (typeof obj !== 'object') return null;
        for (const [key,value] of Object.entries(obj)) {
          const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
          if (wanted.has(normalized) && (typeof value === 'string' || typeof value === 'number')) return value;
        }
        for (const value of Object.values(obj)) { if (value && typeof value === 'object') { const hit = walk(value, depth + 1); if (hit != null) return hit; } }
        return null;
      };
      for (const attr of [...root.attributes]) {
        const raw=String(attr.value||'').trim();
        if(raw.length<2||raw.length>30000||(!raw.startsWith('{')&&!raw.startsWith('['))) continue;
        const hit=walk(parseJson(raw));
        if(hit!=null) return hit;
      }
      return null;
    };
    const timestampFromRoot = root => scanJsonValue(root, ['reviewTimestamp','review_timestamp','timestamp','createdAt','created_at','postedAt','publishedAt','reviewDate','review_date']);
    const detectJsonIdentity = root => {
      const wanted = new Set(['writingid','reviewid','review_id','submitid','submit_id','commentid','comment_id','itemid','item_id','recordid','record_id','productid','product_id']);
      const walk = (obj, path = [], depth = 0) => {
        if (obj == null || depth > 6) return null;
        if (Array.isArray(obj)) { for (let i=0;i<Math.min(obj.length,20);i++){ const hit=walk(obj[i],[...path,String(i)],depth+1); if(hit)return hit; } return null; }
        if (typeof obj !== 'object') return null;
        for (const [key,value] of Object.entries(obj)) { const normalized=String(key).toLowerCase().replace(/[^a-z0-9_]/g,''); if(wanted.has(normalized)&&(typeof value==='string'||typeof value==='number')) return {path:[...path,key].join('.'),value}; }
        for (const [key,value] of Object.entries(obj)) { if(value&&typeof value==='object'){ const hit=walk(value,[...path,key],depth+1); if(hit)return hit; } }
        return null;
      };
      for (const attr of [...root.attributes]) { const raw=String(attr.value||'').trim(); if(raw.length<2||raw.length>25000||(!raw.startsWith('{')&&!raw.startsWith('['))) continue; const hit=walk(parseJson(raw)); if(hit)return {mode:'containerJsonAttribute',attribute:attr.name,jsonPath:hit.path}; }
      return null;
    };
    let effectiveIdentity = cfg.itemIdentity || null;
    let effectiveKeyAttribute = cfg.itemKeyAttribute || null;
    if (!effectiveIdentity && !effectiveKeyAttribute && allRoots.length >= 2) {
      const attrs=['data-review-id','data-comment-id','data-writing-id','data-submit-id','data-item-id','data-record-id','data-product-id','data-id','data-key','id'];
      for(const attr of attrs){ const values=allRoots.map(root=>root.getAttribute(attr)).filter(Boolean); if(values.length/Math.max(1,allRoots.length)>=0.8 && new Set(values).size>=2){ effectiveKeyAttribute=attr; break; } }
      if(!effectiveKeyAttribute){ const detected=allRoots.map(detectJsonIdentity).filter(Boolean); if(detected.length/Math.max(1,allRoots.length)>=0.6){ const groups=new Map(); for(const item of detected){const k=[item.mode,item.attribute,item.jsonPath].join('|');groups.set(k,(groups.get(k)||0)+1);} const best=[...groups.entries()].sort((a,b)=>b[1]-a[1])[0]; if(best){const [mode,attribute,jsonPath]=best[0].split('|');effectiveIdentity={mode,attribute,jsonPath};} } }
    }
    const rootKey = root => {
      if (effectiveKeyAttribute) return root.getAttribute(effectiveKeyAttribute);
      if (!effectiveIdentity) return null;
      if (effectiveIdentity.mode === 'containerAttribute') return root.getAttribute(effectiveIdentity.attribute || '');
      if (effectiveIdentity.mode === 'containerJsonAttribute') return getPath(parseJson(root.getAttribute(effectiveIdentity.attribute || '')), effectiveIdentity.jsonPath || '');
      return null;
    };
    const rootScore = root => {
      if (!root || !root.isConnected) return -100000;
      let score = 0;
      try {
        let node=root,hidden=false;
        for(let depth=0;node&&node.nodeType===1&&depth<18;depth++,node=node.parentElement){
          const style=getComputedStyle(node);
          if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)===0){hidden=true;break;}
          if(node.getAttribute?.('aria-hidden')==='true') score-=2200;
        }
        score += hidden ? -12000 : 1000;
        const rect=root.getBoundingClientRect();
        if(rect.width>1&&rect.height>1){score+=700;if(rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth)score+=650;}
        else score-=1800;
        score+=Math.min(220,String(root.innerText||root.textContent||'').trim().length*.05);
      } catch {}
      return score;
    };
    const excludedKeys = new Set((cfg.excludeItemKeys || []).map(String));
    const groupedRoots = new Map(), looseRoots = [];
    allRoots.forEach((root,index)=>{
      const key=rootKey(root);
      if(key==null||String(key)===''){looseRoots.push({index,root});return;}
      const k=String(key);
      // Node review halaman sebelumnya sering masih dipertahankan oleh Agoda
      // selama transisi React. Bila ID-nya sama dengan halaman yang baru selesai,
      // ia bukan raw record baru dan harus diabaikan sebelum ekstraksi.
      if (excludedKeys.has(k)) return;
      if(!groupedRoots.has(k)) groupedRoots.set(k,{index,list:[]});
      groupedRoots.get(k).list.push(root);
    });
    const renderedLooseRoots=looseRoots.filter(({root})=>rootScore(root)>0);
    const chosenRoots=renderedLooseRoots.length?renderedLooseRoots:[...looseRoots];
    for(const group of groupedRoots.values()){
      const root=group.list.sort((a,b)=>rootScore(b)-rootScore(a))[0];
      if(root && rootScore(root)>0)chosenRoots.push({index:group.index,root});
    }
    chosenRoots.sort((a,b)=>a.index-b.index);
    const roots=chosenRoots.map(x=>x.root);
    const contentControlLabels=[
      'tampilkan lebih sedikit','tampilkan lebih banyak','lihat lebih sedikit','lihat lebih banyak',
      'baca lebih sedikit','baca lebih banyak','tampilkan selengkapnya','lihat selengkapnya',
      'baca selengkapnya','continue reading','show less','show more','see less','see more',
      'view less','view more','read less','read more','selengkapnya'
    ].sort((a,b)=>b.length-a.length);
    const normalizeControlLabel=value=>String(value==null?'':value).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().replace(/^[.\u2026\s]+|[.\u2026\s]+$/g,'').toLocaleLowerCase('id-ID');
    const isContentControl=node=>{
      if(!node)return false;
      const values=[node.getAttribute?.('aria-label'),node.getAttribute?.('title'),node.textContent];
      return values.some(value=>contentControlLabels.includes(normalizeControlLabel(value)));
    };
    const readVisibleText=el=>{
      let text='';
      try{
        const clone=el.cloneNode(true);
        const controls=[...clone.querySelectorAll('button,a,[role="button"],[data-testid*="read-more" i],[data-testid*="show-more" i],[class*="read-more" i],[class*="read_more" i]')];
        for(const control of controls)if(isContentControl(control))control.remove();
        // Beberapa situs memakai span tanpa role untuk tombol. Hapus hanya leaf
        // yang seluruh teksnya sama persis dengan label kontrol.
        for(const leaf of [...clone.querySelectorAll('span,strong')])if(!leaf.children.length&&isContentControl(leaf))leaf.remove();
        text=clone.textContent||'';
      }catch{text=el.innerText||el.textContent||'';}
      text=String(text).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
      let changed=true;
      while(changed&&text){changed=false;for(const label of contentControlLabels){const escaped=label.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');const next=text.replace(new RegExp('(?:\\s*(?:\\.{2,}|\\u2026+|[·•|–—-]+)\\s*)?'+escaped+'\\s*$','iu'),'').trim();if(next!==text){text=next;changed=true;break;}}}
      return text;
    };
    const capturedReviews = () => {
      const merged = [];
      const seen = new Set();
      const add = item => {
        if (!item || typeof item !== 'object' || merged.length >= 5000) return;
        let key = String(item.reviewId || item.submitId || item.writingid || item.writingId || item.id || item.reviewTimestamp || item.createdAt || item.postedAt || item.reviewContentText || item.reviewOriginalText || '').slice(0,320);
        if (!key) { try { key = JSON.stringify(item).slice(0,320); } catch { key = ''; } }
        if (!key || seen.has(key)) return;
        seen.add(key); merged.push(item);
      };
      if (Array.isArray(window.__PETIKDATA_CAPTURED_REVIEWS__)) window.__PETIKDATA_CAPTURED_REVIEWS__.slice(-5000).forEach(add);
      try {
        const raw = document.querySelector('#petikdata-captured-review-payload')?.textContent || '';
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) parsed.slice(-5000).forEach(add);
      } catch {}
      return merged;
    };
    const primitiveFromObject = (obj, names) => {
      const wanted = new Set(names.map(name => String(name).toLowerCase().replace(/[^a-z0-9]/g,'')));
      const walk = (value, depth = 0) => {
        if (value == null || depth > 7) return null;
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 80)) {
            const hit = walk(item, depth + 1);
            if (hit != null) return hit;
          }
          return null;
        }
        if (typeof value !== 'object') return null;
        for (const [key, next] of Object.entries(value)) {
          const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
          if (wanted.has(normalized) && (typeof next === 'string' || typeof next === 'number')) return next;
        }
        for (const next of Object.values(value)) {
          if (next && typeof next === 'object') {
            const hit = walk(next, depth + 1);
            if (hit != null) return hit;
          }
        }
        return null;
      };
      return walk(obj, 0);
    };
    const reviewIdentityValue = review => {
      if (!review || typeof review !== 'object') return null;
      // Prefer source-native review/comment identifiers. A deeply nested generic
      // Generic id can easily be a reviewer/profile ID, so only accept a generic id
      // directly on an object that itself has strong review semantics.
      for (const key of ['reviewId','review_id','writingid','writingId','commentId','comment_id','submitId','submit_id']) {
        const value = review[key];
        if (value != null && (typeof value === 'string' || typeof value === 'number') && String(value).trim()) return value;
      }
      for (const holder of ['review','comment','ugc','content']) {
        const nested = review[holder];
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
        for (const key of ['reviewId','review_id','writingid','writingId','commentId','comment_id','submitId','submit_id']) {
          const value = nested[key];
          if (value != null && (typeof value === 'string' || typeof value === 'number') && String(value).trim()) return value;
        }
      }
      const directId = review.id;
      const hasReviewShape = ['reviewContentText','reviewOriginalText','reviewText','reviewScore','rating','score','reviewTimestamp','reviewDate']
        .some(key => review[key] != null) || (typeof review.content === 'string' && review.content.trim().length >= 8);
      return hasReviewShape && directId != null && String(directId).trim() ? directId : null;
    };
    const domReviewIdentityFromRoot = root => {
      if (!root) return null;
      const directAttrs = ['data-review-id','data-comment-id','data-writing-id','data-submit-id'];
      for (const attr of directAttrs) {
        const direct = root.getAttribute?.(attr);
        if (direct != null && String(direct).trim()) return String(direct).trim();
      }
      try {
        const child = root.querySelector('[data-review-id],[data-comment-id],[data-writing-id],[data-submit-id]');
        if (child) {
          for (const attr of directAttrs) {
            const value = child.getAttribute(attr);
            if (value != null && String(value).trim()) return String(value).trim();
          }
        }
      } catch {}
      // Tiket can keep the review id inside a React/data JSON attribute on a
      // descendant rather than on the review card itself. Inspect a bounded
      // number of descendants so this stays cheap even on large pages.
      let nodes = [root];
      try { nodes.push(...[...root.querySelectorAll('*')].slice(0,140)); } catch {}
      for (const node of nodes) {
        for (const attr of [...(node.attributes || [])]) {
          const raw = String(attr.value || '').trim();
          if (raw.length < 2 || raw.length > 30000 || (!raw.startsWith('{') && !raw.startsWith('['))) continue;
          const parsed = parseJson(raw);
          const value = reviewIdentityValue(parsed);
          if (value != null && String(value).trim()) return String(value).trim();
        }
      }
      // React does not necessarily serialize source IDs into HTML attributes. Tiket's
      // submitId can live in the props attached to the rendered review subtree. Inspect
      // only bounded React props/memoizedProps and search explicitly for review IDs;
      // WeakSet + limits avoid following the full cyclic Fiber graph.
      const scanReactValue = (value, depth = 0, seenObjects = new WeakSet()) => {
        if (value == null || depth > 6) return null;
        if (typeof value !== 'object') return null;
        if (seenObjects.has(value)) return null;
        seenObjects.add(value);
        for (const key of ['submitId','submit_id','reviewId','review_id','writingId','writingid','commentId','comment_id']) {
          const direct = value[key];
          if (direct != null && (typeof direct === 'string' || typeof direct === 'number') && String(direct).trim()) return direct;
        }
        if (Array.isArray(value)) {
          for (const item of value.slice(0,40)) { const hit=scanReactValue(item,depth+1,seenObjects); if(hit!=null)return hit; }
          return null;
        }
        let traversed=0;
        for (const [key,next] of Object.entries(value)) {
          if (++traversed > 90) break;
          if (/^(?:return|child|sibling|stateNode|alternate|_debugOwner|_owner)$/i.test(key)) continue;
          if (next && typeof next === 'object') { const hit=scanReactValue(next,depth+1,seenObjects); if(hit!=null)return hit; }
        }
        return null;
      };
      for (const node of nodes.slice(0,80)) {
        let keys=[];try{keys=Object.keys(node).filter(key=>/^__reactProps\$|^__reactFiber\$|^__reactInternalInstance\$/i.test(key)).slice(0,4);}catch{}
        for (const key of keys) {
          let holder=null;try{holder=node[key];}catch{}
          if(!holder)continue;
          const candidates=/^__reactFiber\$/i.test(key)?[holder.memoizedProps,holder.pendingProps]:[holder];
          for(const candidate of candidates){const value=scanReactValue(candidate);if(value!=null&&String(value).trim())return String(value).trim();}
        }
      }
      return null;
    };
    const networkReviewIdentityFromRoot = root => {
      const list = capturedReviews();
      if (!list.length || !root) return null;
      const rootText = readVisibleText(root).toLowerCase();
      const rootKeyValue = String(rootKey(root) || '').replace(/[^a-z0-9]/gi, '');
      const textFields = ['reviewContentText','reviewOriginalText','reviewText','comment','content','text','body'];
      const reviewerFields = ['reviewerName','reviewer_name','customerName','userName','username','authorName','author'];
      const ratingFields = ['reviewScore','ratingSummary','rating_score','rating','score'];
      const textPartsOf = review => {
        const direct = textFields.map(name => primitiveFromObject(review, [name])).filter(Boolean).map(value=>String(value).trim()).filter(Boolean);
        const comments = Array.isArray(review?.comments) ? review.comments : [];
        const preferred = comments.filter(item => String(item?.questionCode || '').toLowerCase() === 'comment');
        const source = preferred.length ? preferred : comments;
        const commentValues = source.map(item => String(item?.value || '').trim()).filter(Boolean);
        return [...new Set([...direct, ...commentValues])];
      };
      const textOf = review => textPartsOf(review).join(' ').replace(/\s+/g,' ').trim();
      const reviewerOf = review => reviewerFields.map(name => primitiveFromObject(review, [name])).find(Boolean);
      const ratingOf = review => ratingFields.map(name => primitiveFromObject(review, [name])).find(value => value != null && String(value).trim() !== '');
      const ranked = [];
      for (const review of list) {
        const id = reviewIdentityValue(review);
        if (id == null || !String(id).trim()) continue;
        const normalizedId = String(id).replace(/[^a-z0-9]/gi, '');
        let score = 0;
        if (rootKeyValue && normalizedId && (rootKeyValue === normalizedId || rootKeyValue.includes(normalizedId) || normalizedId.includes(rootKeyValue))) score += 20;
        const reviewText = textOf(review).toLowerCase();
        const reviewParts = textPartsOf(review).map(value=>String(value).replace(/\s+/g,' ').trim().toLowerCase()).filter(Boolean);
        let textScore=0;
        for(const part of reviewParts){
          const snippet=part.slice(0,Math.min(120,part.length));
          if(snippet.length>=12&&rootText.includes(snippet)){textScore=Math.max(textScore,14);break;}
          if(part.length>=24&&rootText.includes(part.slice(0,24)))textScore=Math.max(textScore,9);
        }
        if(!textScore&&reviewText){const snippet=reviewText.slice(0,Math.min(96,reviewText.length));if(snippet.length>=12&&rootText.includes(snippet))textScore=12;else if(reviewText.length>=24&&rootText.includes(reviewText.slice(0,24)))textScore=7;}
        score+=textScore;
        const reviewer = String(reviewerOf(review) || '').replace(/\s+/g,' ').trim().toLowerCase();
        if (reviewer.length >= 2 && rootText.includes(reviewer)) score += 4;
        const rating = String(ratingOf(review) ?? '').trim().replace(',', '.');
        if (rating && new RegExp('(?:^|\\D)' + rating.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&') + '(?:\\D|$)').test(rootText.replace(',', '.'))) score += 2;
        if (score >= 8) ranked.push({ id: String(id).trim(), score });
      }
      ranked.sort((a,b) => b.score - a.score);
      if (!ranked.length) return null;
      // Require a unique strong winner when multiple captured responses contain
      // similar reviews from other pages.
      if (ranked[1] && ranked[0].score < ranked[1].score + 2) return null;
      return ranked[0].id;
    };
    const networkReviewTimestampFromRoot = root => {
      const list = capturedReviews();
      if (!list.length) return null;
      const key = rootKey(root);
      const rootText = readVisibleText(root).toLowerCase();
      const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '');
      const textFields = ['reviewContentText','reviewOriginalText','content','comment','text','body','reviewText'];
      const timestampFields = ['reviewTimestamp','review_timestamp','timestamp','createdAt','created_at','postedAt','publishedAt','reviewDate','review_date'];
      const timestampOf = review => primitiveFromObject(review, timestampFields);
      const idOf = review => reviewIdentityValue(review);
      const textOf = review => textFields.map(name => primitiveFromObject(review, [name])).filter(Boolean).map(String).join(' ').replace(/\s+/g,' ').trim();
      if (normalizedKey) {
        for (const review of list) {
          const reviewId = String(idOf(review) || '').replace(/[^a-z0-9]/gi, '');
          if (reviewId && (reviewId === normalizedKey || reviewId.includes(normalizedKey) || normalizedKey.includes(reviewId))) {
            const ts = timestampOf(review);
            if (ts != null) return ts;
          }
        }
      }
      for (const review of list) {
        const text = textOf(review).toLowerCase();
        if (text.length < 16) continue;
        const snippet = text.slice(0, Math.min(80, text.length));
        if (rootText.includes(snippet) || text.includes(rootText.slice(0, Math.min(80, rootText.length)))) {
          const ts = timestampOf(review);
          if (ts != null) return ts;
        }
      }
      return null;
    };
    const networkReviewTextFromRoot = root => {
      const list = capturedReviews();
      if (!list.length || !root) return null;
      const textFields = ['reviewContentText','reviewOriginalText','reviewText','reviewContent','content','comment','text','body'];
      const textPartsOf = review => {
        const direct=[];
        for(const name of textFields){
          const value=primitiveFromObject(review,[name]);
          if(value!=null&&String(value).trim()) direct.push(String(value).trim());
        }
        const comments=Array.isArray(review?.comments)?review.comments:[];
        const preferred=comments.filter(item=>String(item?.questionCode||'').toLowerCase()==='comment');
        const source=preferred.length?preferred:comments;
        for(const item of source){const value=String(item?.value||'').trim();if(value)direct.push(value);}
        return [...new Set(direct.map(value=>String(value).replace(/\s+/g,' ').trim()).filter(Boolean))];
      };
      const identity=domReviewIdentityFromRoot(root)||rootKey(root);
      const normalizedIdentity=String(identity||'').replace(/[^a-z0-9]/gi,'').toLowerCase();
      if(normalizedIdentity){
        for(const review of list){
          const reviewId=String(reviewIdentityValue(review)||'').replace(/[^a-z0-9]/gi,'').toLowerCase();
          if(reviewId&&(reviewId===normalizedIdentity||reviewId.includes(normalizedIdentity)||normalizedIdentity.includes(reviewId))){
            const parts=textPartsOf(review);
            if(parts.length)return parts.sort((a,b)=>b.length-a.length)[0];
          }
        }
      }
      const rootText=readVisibleText(root).toLocaleLowerCase('id-ID');
      let best=null;
      for(const review of list){
        const parts=textPartsOf(review);
        for(const part of parts){
          const normalized=part.toLocaleLowerCase('id-ID');
          const snippet=normalized.slice(0,Math.min(120,normalized.length));
          let score=0;
          if(snippet.length>=12&&rootText.includes(snippet))score=20;
          else if(normalized.length>=24&&rootText.includes(normalized.slice(0,24)))score=12;
          if(score&&(!best||score>best.score||score===best.score&&part.length>best.text.length))best={score,text:part};
        }
      }
      return best?.text||null;
    };
    const tripReviewTextFromRoot = (root, selectedEl, sourceText = '') => {
      if(!root)return null;
      const clean=value=>String(value==null?'':value).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
      const escapeRe=value=>String(value||'').replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&');
      const translationUiLabels=[
        'teks asli','original text','laporkan masalah terjemahan','report translation issue',
        'diterjemahkan oleh ai','translated by ai','terjemahan disediakan oleh google',
        'terjamahan disediakan oleh google','translation provided by google','translated by google',
        'terjemahkan','translate'
      ];
      const stripTripUi=value=>{
        let text=clean(value);
        if(!text)return'';
        for(const label of translationUiLabels){
          const re=new RegExp(escapeRe(label),'giu');
          text=text.replace(re,' ');
        }
        text=text.replace(/[|·•]+/g,' ').replace(/\s+/g,' ').trim();
        return text;
      };
      const source=stripTripUi(sourceText);
      const sourceNorm=source.toLocaleLowerCase('id-ID');
      const selected=stripTripUi(selectedEl?readVisibleText(selectedEl):'');
      const selectedNorm=selected.toLocaleLowerCase('id-ID');
      if(source&&selectedNorm&&selectedNorm.includes(sourceNorm))return source;
      const uiOnly=/^(?:bermanfaat|helpful|apakah ulasan ini membantu\??|ya|tidak|selengkapnya|read more|show more)$/i;
      const metadataOnly=value=>{
        const text=stripTripUi(value);
        if(!text||uiOnly.test(text))return true;
        if(/^\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?(?:\s+\S+)?$/i.test(text))return true;
        if(explicitReviewDateText(text))return true;
        if(/^\d{1,2}\s+(?:jan|feb|mar|apr|mei|may|jun|jul|agu|aug|sep|okt|oct|nov|des|dec)[a-z]*\s+\d{4}$/i.test(text))return true;
        return false;
      };
      // Trip dapat merender toolbar terjemahan dan metadata reviewer di dalam div
      // yang secara struktur mirip isi komentar. Bangun daftar metadata leaf per
      // record agar kandidat agregat seperti "TamuChinaKamar Deluxe..." ditolak.
      const metadataFragments=[];
      try{
        for(const el of [...root.querySelectorAll('*')].slice(0,220)){
          if((el.children?.length||0)>2)continue;
          const role=roleOf(el,root);
          if(!/^(?:reviewer_name|reviewer_country|room_type|traveler_type|stay_detail|review_count|review_date|rating_score|rating_max|rating_label)$/.test(role))continue;
          const value=stripTripUi(readVisibleText(el));
          if(value&&value.length<=140&&!metadataFragments.includes(value))metadataFragments.push(value);
        }
      }catch{}
      const metadataResidual=value=>{
        let text=stripTripUi(value);
        if(!text)return{residual:'',matched:0,ratio:0};
        const originalLen=text.length;
        let matched=0;
        const fragments=[...metadataFragments].sort((a,b)=>b.length-a.length);
        for(const fragment of fragments){
          if(fragment.length<2)continue;
          const re=new RegExp(escapeRe(fragment),'giu');
          if(re.test(text)){matched+=1;text=text.replace(re,' ');}
        }
        text=text.replace(/\b\d+\s+(?:ulasan|reviews?|comments?|komentar)\b/giu,' ')
          .replace(/\b(?:pengguna anonim|anonymous user|tamu|guest)\b/giu,' ')
          .replace(/[|·•,:;()\[\]{}]+/g,' ')
          .replace(/\s+/g,' ').trim();
        return{residual:text,matched,ratio:originalLen?text.length/originalLen:0};
      };
      const sanitizeCandidate=value=>{
        const text=stripTripUi(value);
        if(metadataOnly(text))return'';
        const meta=metadataResidual(text);
        // Bila tiga atau lebih fragmen metadata tersusun dalam satu kandidat dan
        // hampir tidak ada kalimat tersisa, kandidat tersebut bukan isi review.
        if(meta.matched>=3&&(meta.residual.length<8||meta.ratio<0.22))return'';
        return text;
      };
      const candidates=[];
      let nodes=[];try{nodes=[...root.querySelectorAll('p,span,div')];}catch{}
      for(const el of nodes){
        let visible=true;try{const st=getComputedStyle(el),box=el.getBoundingClientRect();visible=st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&box.width>0&&box.height>0;}catch{}
        if(!visible)continue;
        const rawText=clean(readVisibleText(el));
        const text=sanitizeCandidate(rawText);
        if(text.length<2||text.length>5000)continue;
        const norm=text.toLocaleLowerCase('id-ID');
        const classes=[...(el.classList||[])].join(' ').toLowerCase();
        const testid=String(el.getAttribute?.('data-testid')||'').toLowerCase();
        let score=0;
        if(testid==='review-comment'||testid==='review-text')score+=1200;
        if(/review.*(?:content|text|comment|body)|comment.*(?:content|text|body)|review[_-]?card[_-]?comment|readmorecomments.*comment/.test(classes))score+=850;
        if(roleOf(el,root)==='review_text')score+=320;
        const longChildren=[...el.children].filter(child=>sanitizeCandidate(child.innerText||child.textContent).length>=16).length;
        if(longChildren===0)score+=180;else if(longChildren<=2)score+=80;else score-=220;
        if(text.length>=8&&text.length<=1200)score+=140;
        if(source){
          if(norm===sourceNorm)score+=2200;
          else if(norm.includes(sourceNorm)||(sourceNorm.includes(norm)&&norm.length>=16))score+=1300;
          else if(sourceNorm.length>=24&&norm.includes(sourceNorm.slice(0,24)))score+=900;
        }
        if(/(?:^|\s)\d+(?:[.,]\d+)?\s*\/\s*10\b/.test(text))score-=900;
        if(/\b(?:bermanfaat|helpful)\b/i.test(text))score-=700;
        // Kandidat yang semula hanya toolbar terjemahan akan menjadi kosong setelah
        // stripTripUi; kandidat yang berisi teks ulasan + toolbar tetap dipertahankan.
        if(rawText!==text&&text.length<8)score-=1200;
        if(/\b(?:fantastis|spektakuler|luar biasa|sangat baik|baik|buruk)\b/i.test(text)&&explicitReviewDateText(text.replace(/^.*?(?=\d{1,2}\s)/,'')))score-=250;
        candidates.push({text,score,el});
      }
      candidates.sort((a,b)=>b.score-a.score||a.text.length-b.text.length);
      const candidate=candidates[0];
      if(candidate&&candidate.score>=350)return candidate.text;
      const selectedSafe=sanitizeCandidate(selected);
      if(selectedSafe)return selectedSafe;
      return source||null;
    };
    const explicitReviewDateText = value => {
      const text=String(value||'').replace(/\s+/g,' ').trim();
      if(!text||text.length>90)return false;
      return /^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text)
        || /^\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text)
        || /^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(text);
    };
    const reviewDateTextFromRoot = root => {
      if(!root)return null;
      const candidates=[];
      const add=el=>{
        if(!el)return;
        const text=readVisibleText(el);
        if(!explicitReviewDateText(text))return;
        let visible=true;
        try{const st=getComputedStyle(el),box=el.getBoundingClientRect();visible=st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&box.width>0&&box.height>0;}catch{}
        if(!visible)return;
        let score=100;
        if(/^diulas\s+pada/i.test(text)||/^reviewed\b/i.test(text))score+=500;
        const blob=[el.getAttribute?.('data-testid'),el.getAttribute?.('data-element-name'),el.getAttribute?.('aria-label'),[...(el.classList||[])].join(' ')].filter(Boolean).join(' ').toLowerCase();
        if(/review.*(?:date|time)|userreviewtime|review-statusbar|date/.test(blob))score+=220;
        if(el.children?.length===0)score+=60;
        candidates.push({text,score});
      };
      try{for(const el of root.querySelectorAll('*'))add(el);}catch{}
      if(!candidates.length)return null;
      candidates.sort((a,b)=>b.score-a.score);
      return candidates[0].text;
    };
    const read = (root, el, field) => {
      const isDateField = fieldLooks(field, /review[_\s-]*date|reviewed|posted|date/i);
      const isReviewTextField = fieldLooks(field, /review[_\s-]*(?:text|content|comment)|comment[_\s-]*(?:text|content|body)|(?:^|\s)review_text(?:$|\s)/i);
      const isTrip = String(cfg.siteProfile||'').toLowerCase()==='trip' || /(^|\.)trip\.com$/i.test(location.hostname);
      if (!el && !isDateField && !(isTrip && isReviewTextField)) return null;
      let value;
      const type = field.extract || 'text';
      if (type === 'text') {
        if (isTrip && isReviewTextField) {
          const sourceText = networkReviewTextFromRoot(root);
          value = tripReviewTextFromRoot(root, el, sourceText);
        }
        if (value == null && isDateField) {
          const timestamp = timestampFromRoot(root) ?? networkReviewTimestampFromRoot(root);
          if (timestamp != null && String(timestamp) !== '') value = timestamp;
          if (value == null && el) {
            const selectedText = readVisibleText(el);
            if (explicitReviewDateText(selectedText)) value = selectedText;
          }
          if (value == null) value = reviewDateTextFromRoot(root);
        }
        if (value == null && el) value = readVisibleText(el);
      }
      else if (type === 'html') value = el.innerHTML;
      else if (type === 'href') value = el.href || el.getAttribute('href');
      else if (type === 'src') value = el.src || el.getAttribute('src');
      else if (type === 'value') value = el.value;
      else if (type === 'attribute' || type === 'containerAttribute') value = el.getAttribute(field.attribute || '');
      else if (type === 'jsonAttribute' || type === 'containerJsonAttribute') {
        try { value = getPath(JSON.parse(el.getAttribute(field.attribute || '') || 'null'), field.jsonPath || ''); }
        catch { value = null; }
      } else value = readVisibleText(el);

      if (value != null && field.regex) {
        try {
          const re = new RegExp(field.regex, field.regexFlags || '');
          const match = String(value).match(re);
          value = match ? (match[1] ?? match[0]) : null;
        } catch {}
      }
      return value;
    };
    const marker = (el, limit) => {
      let cur=el;
      for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){
        for(const node of [cur,...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')]){
          if(!node) continue;
          for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){
            const v=node.getAttribute?.(a);
            if(v&&/(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name)/i.test(v)) return a+'='+v;
          }
          for(const c of [...(node.classList||[])]) if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score)/i.test(c)) return 'class='+c;
        }
      }
      return '';
    };
    const signature=(el,root)=>{if(!el)return '';for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=el.getAttribute?.(a);if(v)return a+'='+v;}return marker(el.parentElement||el,root);};
    const roleOf=(el,root)=>{
      if(!el)return'';
      const txt=String(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
      const classTokens=Array.from(el.classList||[],value=>String(value).toLowerCase());
      const hasClass=pattern=>classTokens.some(value=>pattern.test(value));
      const sig=signature(el,root).toLowerCase();
      const testid=String(el.getAttribute?.('data-testid')||'').toLowerCase();
      const infoCarrier=el.closest?.('[data-info-type]');
      const infoType=String(infoCarrier?.getAttribute?.('data-info-type')||'').toLowerCase();
      const tripProfile=String(cfg.siteProfile||'').toLowerCase()==='trip'||/(?:^|\.)(?:trip|ctrip)\.com$/i.test(String(location.hostname||''));
      const tripMonth='(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
      const tripBareStayMonth=tripProfile&&new RegExp('^'+tripMonth+'\\s+\\d{4}$','i').test(txt);
      const tripStayDetail=tripProfile&&(tripBareStayMonth||new RegExp('^(?:menginap(?:\\s+pada)?|stayed?(?:\\s+(?:in|during))?|stay(?:\\s+(?:in|during))?)\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt));
      const tripFullReviewDate=tripProfile&&(new RegExp('^\\d{1,2}\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^(?:reviewed|posted)\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt));
      const tripTranslationResidual=tripProfile?txt.replace(/(?:teks\s+asli|original\s+text|laporkan\s+masalah\s+terjemahan|report\s+translation\s+issue|diterjemahkan\s+oleh\s+ai|translated\s+by\s+ai|terj[ea]mahan\s+disediakan\s+oleh\s+google|translation\s+provided\s+by\s+google)/giu,' ').replace(/[|·•\s]+/g,' ').trim():txt;
      if(tripProfile&&tripTranslationResidual!==txt&&tripTranslationResidual.length<2)return'';
      if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(txt)&&txt.length<=120)return'';
      if(testid==='review-title')return'review_title';
      if(testid==='review-comment'||testid==='review-text')return'review_text';
      if(testid==='product-name')return'product_name';
      if(testid==='price')return'price';
      if(testid==='description')return'description';
      if(testid==='stock')return'stock';
      if(infoType==='reviewer-name'){
        if(el.closest?.('strong'))return'reviewer_name';
        if(String(el.tagName||'').toLowerCase()==='span')return'reviewer_country';
        return'reviewer_name';
      }
      if(infoType==='group-name')return'traveler_type';
      if(infoType==='room-type')return'room_type';
      if(infoType==='stay-detail')return'stay_detail';
      if(tripStayDetail)return'stay_detail';
      if(tripFullReviewDate)return'review_date';
      if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(txt))return'review_date';
      const agodaLeft=el.closest?.('.Review-comment-left');
      const agodaGroup=agodaLeft&&el.closest?.('.Review-comment-score, p');
      if(agodaGroup&&agodaLeft.contains(agodaGroup)){
        const spans=[...agodaGroup.children].filter(node=>String(node.tagName||'').toLowerCase()==='span');
        const carrier=spans.find(node=>node===el||node.contains(el));
        if(spans[0]===carrier)return'rating_score';
        if(spans[1]===carrier)return'rating_label';
      }
      if(/ic_languages|language|country/.test(sig))return'reviewer_country';
      if(/ic_roomline|roomline/.test(sig))return'room_type';
      if(/ic_business2|business2|travell/.test(sig))return'traveler_type';
      if(hasClass(/traveler[_-]?type|traveller[_-]?type|trip[_-]?type/))return'traveler_type';
      if(/calendar/.test(sig))return'stay_detail';
      if(/message/.test(sig)||/^\d+\s+(?:ulasan|reviews?|comments?|komentar)$/i.test(txt))return'review_count';
      if(hasClass(/reviewitem-username|review.*(?:user|guest|customer).*name|reviewer.*name|author.*name|customer[_-]?name/)||el.closest?.('cite'))return'reviewer_name';
      if((!tripProfile&&hasClass(/userreviewtime|review.*(?:date|time)|reviewcard.*date/))||explicitReviewDateText(txt)||/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return'review_date';
      const ptxt=String(el.parentElement?.innerText||el.parentElement?.textContent||'').trim().replace(/\s+/g,' ');
      if(hasClass(/rating.*score|score.*rating|review[_-]?card[_-]?user[_-]?review/)||(el.getAttribute?.('data-testid')||'').toLowerCase()==='tvat-ratingscore'||(/^\d+(?:[.,]\d+)?$/.test(txt)&&/^\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)$/.test(ptxt)))return'rating_score';
      if(/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(txt))return'rating_max';
      if(hasClass(/rating.*label|commentlevel/))return'rating_label';
      if(hasClass(/reviewitem-content|review[-_].*(?:content|text|copy|body)|comment[-_].*(?:content|text|body)|review[_-]?card[_-]?comment|readmorecomments.*comment|reviewcopy|review-copy/))return'review_text';
      if(hasClass(/product[-_]?name|product[-_]?title|item[-_]?name/))return'product_name';
      if(hasClass(/(?:^|[-_])price(?:$|[-_])|product[-_]?price/))return'price';
      if(hasClass(/(?:^|[-_])description(?:$|[-_])|product[-_]?description/))return'description';
      if(hasClass(/(?:^|[-_])stock(?:$|[-_])|availability/))return'stock';
      if(String(el.tagName||'').toLowerCase()==='a'&&hasClass(/detail[-_]?link|product[-_]?link/))return'url';
      const metadataAggregate=/\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|desember)\s+\d{4}\s*(?:[•·|–—-]\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?\s*$/i.test(txt)&&(/\b(?:perjalanan\s+bisnis|business\s+trip|pasangan|couple|keluarga|family|solo|sendiri|teman|friends?|rombongan|group|liburan|leisure)\b/i.test(txt)||(!/[.!?](?:\s|$)/.test(txt)&&txt.length<=180));
      if(metadataAggregate)return'';
      const textBlocks=[...el.children].filter(child=>String(child.innerText||child.textContent||'').trim().replace(/\s+/g,' ').length>=20).length;
      if(txt.length>=55&&txt.length<=5000&&textBlocks<=6)return'review_text';
      return'';
    };
    const ratingMaxFromScoreElement=(scoreEl,root)=>{
      if(!scoreEl||!root)return null;
      const parseMax=text=>{
        const raw=String(text||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
        let m=raw.match(/^\/\s*(5|10)(?:[.,]0+)?$/);
        if(m)return Number(m[1]);
        m=raw.match(/(?:^|\s)(?:out\s+of|dari)\s*(5|10)(?:[.,]0+)?(?:$|\s)/i);
        if(m)return Number(m[1]);
        m=raw.match(/\d+(?:[.,]\d+)?\s*\/\s*(5|10)(?:[.,]0+)?/);
        if(m)return Number(m[1]);
        return null;
      };
      const scopes=[];
      const add=node=>{if(node&&root.contains(node)&&!scopes.includes(node))scopes.push(node);};
      add(scoreEl.parentElement);
      add(scoreEl.closest?.('.Review-comment-score,[class*="rating" i],[class*="score" i],[data-testid*="rating" i],[data-testid*="score" i]'));
      let parent=scoreEl.parentElement;for(let i=0;parent&&parent!==root&&i<3;i++,parent=parent.parentElement)add(parent);
      for(const scope of scopes){
        const nodes=[scope,...scope.querySelectorAll(':scope > *, span, small, sup, sub')];
        for(const node of nodes){
          if(node===scoreEl||scoreEl.contains?.(node))continue;
          const max=parseMax(node.innerText||node.textContent||node.getAttribute?.('aria-label')||node.getAttribute?.('title'));
          if(max!=null)return max;
        }
        const max=parseMax(scope.innerText||scope.textContent||'');
        if(max!=null)return max;
      }
      return null;
    };
    const findTarget = (root, field) => {
      if (['containerAttribute','containerJsonAttribute'].includes(field.extract)) return root;
      const selectors=[...new Set([field.selector,...(Array.isArray(field.selectors)?field.selectors:[])].filter(Boolean))];
      const expected=field.expectedSignature||'';
      const targetTag=String(field.targetTag||'').toLowerCase();
      const targetClasses=new Set((field.targetClasses||[]).map(String));
      const wantedRole=String(field.semanticRole||'');
      let best=null;
      for(let i=0;i<selectors.length;i++){
        const selector=selectors[i]; const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(selector); let list=[];
        try{list=selector===':scope'?[root]:[...root.querySelectorAll(selector)];}catch{continue;}
        if(!list.length)continue;
        let candidates=list;
        if(targetTag){const byTag=candidates.filter(el=>el.tagName?.toLowerCase()===targetTag);if(byTag.length)candidates=byTag;}
        const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&['tiket','trip'].includes(String(cfg.siteProfile||'').toLowerCase()));
        // Agoda can render a valid review date with multiple wrapper signatures.
        // Treat review_date as semantically bound but signature-flexible: a different
        // wrapper is allowed only when roleOf() still confirms review_date.
        const semanticFlexibleRole=wantedRole==='review_date';
        if(expected){const bySig=candidates.filter(el=>signature(el,root)===expected);if(bySig.length)candidates=bySig;else if(semanticFlexibleRole){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}else if(!strictStructural||contextBoundRole)continue;}
        if(wantedRole&&(!strictStructural||contextBoundRole||semanticFlexibleRole)){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}
        if(targetClasses.size&&candidates.length>1){const byClass=candidates.filter(el=>[...targetClasses].some(c=>el.classList?.contains(c)));if(byClass.length)candidates=byClass;}
        if(candidates.length>1){const visible=candidates.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)candidates=visible;else{const pool=visible.length?visible:candidates;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)candidates=[pool[0]];}}if(candidates.length!==1)continue;
        const el=candidates[0];let score=1200-i*35;
        if(expected)score+=signature(el,root)===expected?500:-420;
        if(targetTag&&el.tagName?.toLowerCase()===targetTag)score+=120;
        if(targetClasses.size)score+=Math.min(240,[...targetClasses].filter(c=>el.classList?.contains(c)).length*80);
        if(selector.startsWith(':scope > '))score+=90;
        if(!best||score>best.score)best={el,score};
      }
      if(!best && wantedRole){
        let semantic=[];try{semantic=[...root.querySelectorAll('*')].filter(el=>roleOf(el,root)===wantedRole);}catch{}
        if(semantic.length===1) best={el:semantic[0],score:900};
      }
      return best?.el||null;
    };
    return roots.map((root, index) => {
      const row = {};
      const configuredIdentityName = String(effectiveIdentity?.suggestedName || '');
      const identityHint = [effectiveKeyAttribute, effectiveIdentity?.attribute, effectiveIdentity?.jsonPath, configuredIdentityName].filter(Boolean).join(' ');
      const nativeReviewId = domReviewIdentityFromRoot(root) || networkReviewIdentityFromRoot(root);
      const recordId = nativeReviewId || rootKey(root);
      if(recordId!=null&&String(recordId)!=='') {
        row._recordId=recordId;
        row._recordIdName = nativeReviewId || /(?:review|comment|writing)/i.test(identityHint) ? 'review_id' : (configuredIdentityName || 'record_id');
      }
      const resolvedTargets={};
      for (const field of cfg.fields) {
        const target=findTarget(root, field);
        resolvedTargets[field.name]=target;
        row[field.name]=read(root, target, field);
      }
      const hasConfiguredRatingMax=cfg.fields.some(field=>fieldLooks(field,/rating[_\s-]*max|max[_\s-]*score|rating[_\s-]*scale/i));
      if(!hasConfiguredRatingMax){
        const scoreField=cfg.fields.find(field=>fieldLooks(field,/rating[_\s-]*score|review[_\s-]*score|(?:^|\s)score(?:$|\s)/i));
        let detectedMax=scoreField?ratingMaxFromScoreElement(resolvedTargets[scoreField.name],root):null;
        // Agoda review scores use a 0-10 scale even when the current card omits
        // an explicit '/10' denominator. Keep the visible score as rating_score,
        // keep qualitative text (e.g. Spektakuler) as rating_label, and provide
        // the site-level numeric scale only when a valid score is actually present.
        if(detectedMax==null && (String(cfg.siteProfile||'').toLowerCase()==='agoda'||/(^|\.)agoda\./i.test(location.hostname)) && scoreField){
          const rawScore=String(row[scoreField.name]??'').replace(/\u00a0/g,' ').trim();
          const match=rawScore.match(/-?\d+(?:[.,]\d+)?/);
          const numeric=match?Number(match[0].replace(',','.')):NaN;
          if(Number.isFinite(numeric)&&numeric>=0&&numeric<=10)detectedMax=10;
        }
        if(detectedMax!=null)row.rating_max=detectedMax;
      }
      row._index = index + 1;
      row._sourceRecordIndex = allRoots.indexOf(root);
      return row;
    });
  })()`;
  return win.webContents.executeJavaScript(code, true);
}

async function clickSelector(win, selectorOrSelectors, options = {}) {
  const selectors = [...new Set((Array.isArray(selectorOrSelectors) ? selectorOrSelectors : [selectorOrSelectors]).filter(Boolean))];
  if (!selectors.length) return { ok: false, message: 'Selector pagination kosong.', selectorUsed: null, candidateCount: 0 };
  const intent = {
    type: ['next', 'loadMore', 'page'].includes(options.paginationType) ? options.paginationType : '',
    currentPage: positiveIntOrNull(options.currentPage),
    targetPage: positiveIntOrNull(options.targetPage),
    contextSelector: String(options.contextSelector || ''),
    itemSelector: String(options.itemSelector || ''),
    sourceHost: String(options.sourceHost || '')
  };
  const code = `(async () => {
    const selectors=${JSON.stringify(selectors)};
    const intent=${JSON.stringify(intent)};
    const runtimeHost=String(intent.sourceHost||location.hostname||'').toLowerCase();
    const isTrip=/(^|\\.)trip\\.com$/.test(runtimeHost);
    const seen=new Set();
    const candidates=[];
    const safeQuery=selector=>{try{return selector?[...document.querySelectorAll(selector)]:[];}catch{return[];}};
    const contextNodes=safeQuery(intent.contextSelector);
    const itemNodes=safeQuery(intent.itemSelector);
    const reviewShellSelector='[role="dialog"],dialog,[data-testid*="review" i],[data-element-name*="review" i],[class*="review-modal" i],[class*="review-dialog" i],[class*="review-drawer" i]';
    const itemShells=[...new Set(itemNodes.map(node=>{try{return node.closest(reviewShellSelector);}catch{return null;}}).filter(Boolean))];
    const ancestorsVisible=(el)=>{
      let node=el;
      while(node && node.nodeType===1){
        const st=getComputedStyle(node);
        if(st.display==='none' || st.visibility==='hidden' || Number(st.opacity||1)===0) return false;
        node=node.parentElement;
      }
      return true;
    };
    const hitTest=(el,rect)=>{
      const inViewport=rect.width>0 && rect.height>0 && rect.bottom>0 && rect.right>0 && rect.top<innerHeight && rect.left<innerWidth;
      if(!inViewport) return {inViewport:false,hittable:false};
      const x=Math.min(innerWidth-1,Math.max(0,rect.left+rect.width/2));
      const y=Math.min(innerHeight-1,Math.max(0,rect.top+rect.height/2));
      const hit=document.elementFromPoint(x,y);
      return {inViewport:true,hittable:Boolean(hit && (hit===el || el.contains(hit)))};
    };
    const resolveControl=(raw)=>{
      if(!raw || !(raw instanceof Element)) return raw;
      if(intent.type){
        const semanticSelector=[
          '[data-testid="chevron-right-pagination"]','[data-testid*="pagination-next" i]',
          '[data-testid*="next-pagination" i]','[data-testid*="pagination-right" i]',
          '[data-element-name*="paginator-next" i]','[data-element-name*="pagination-next" i]',
          '[data-testid="page-number-pagination"]','[data-element-page-number]',
          '[aria-label*="next" i]','[aria-label*="berikut" i]','[aria-label*="selanjut" i]',
          '[title*="next" i]','[title*="berikut" i]','a[rel="next"]'
        ].join(',');
        try{const semantic=raw.closest(semanticSelector);if(semantic)return semantic;}catch{}
      }
      try{return raw.closest('button,a,[role="button"],[role="link"]')||raw;}catch{return raw;}
    };
    const pageOf=(el)=>{
      const carrier=el.closest?.('[data-element-page-number],[data-testid="page-number-pagination"]')||el;
      const attr=carrier?.getAttribute?.('data-element-page-number');
      const text=String(carrier?.innerText||carrier?.textContent||'').trim();
      const textValue=/^\\d{1,6}$/.test(text)?Number(text):null;
      const attrValue=attr!=null&&String(attr).trim()!==''?Number(attr):null;
      // Agoda may recycle data-element-page-number as a local slot index once
      // the paginator reaches three digits. The visible numeric label is the
      // absolute site page and therefore wins when the two disagree.
      const value=Number.isFinite(textValue)?textValue:attrValue;
      return Number.isFinite(value)?value:null;
    };
    const intentScore=(el,pageNumber)=>{
      if(!intent.type)return 0;
      const classes=[...(el.classList||[])].join(' ');
      const blob=[
        el.getAttribute?.('data-testid'),el.getAttribute?.('data-element-name'),
        el.getAttribute?.('aria-label'),el.getAttribute?.('title'),el.getAttribute?.('rel'),
        classes,String(el.innerText||el.textContent||'').trim().slice(0,80)
      ].filter(Boolean).join(' ').toLowerCase();
      const tokens=[...(el.classList||[])].map(String);
      const active=tokens.some(value=>/(?:^|[-_])active(?:__|[-_]|$)/i.test(value)) && !tokens.some(value=>/(?:^|[-_])inactive(?:__|[-_]|$)/i.test(value));
      const ariaCurrent=el.getAttribute?.('aria-current');
      let score=0;
      if(intent.type==='next'){
        if(/next|berikut|selanjut|lanjut|chevron[-_ ]?right|arrow[-_ ]?right|right[-_ ]?paginat|paginat[^ ]*[-_ ]?right/.test(blob))score+=900;
        if(/previous|prev\\b|sebelum|chevron[-_ ]?left|arrow[-_ ]?left|left[-_ ]?paginat/.test(blob))score-=1200;
        if(pageNumber!=null&&intent.currentPage!=null){
          if(pageNumber===intent.currentPage+1)score+=760;
          else if(pageNumber<=intent.currentPage)score-=620;
          else score+=Math.max(40,260-(pageNumber-intent.currentPage)*35);
        }
      }else if(intent.type==='loadMore'){
        if(/load[-_ ]?more|muat[-_ ]?(?:lebih|lagi)|lihat[-_ ]?(?:lebih|lagi)|show[-_ ]?more/.test(blob))score+=900;
      }else if(intent.type==='page'){
        if(pageNumber!=null&&intent.targetPage!=null){
          if(pageNumber===intent.targetPage)score+=2200;
          else score-=1200+Math.min(500,Math.abs(pageNumber-intent.targetPage)*30);
        }else score-=900;
        if(/paginat|page[-_ ]?(?:number|step)|review[-_ ]?paginat/.test(blob))score+=350;
      }
      if(active||ariaCurrent==='page'||ariaCurrent==='true')score-=900;
      return score;
    };
    const navigationContext=(el)=>{
      let paginationRoot=null;try{paginationRoot=el.closest('nav,[class*="paginat" i],[data-testid*="paginat" i],[data-element-name*="paginat" i],[aria-label*="paginat" i]');}catch{}
      const inContext=contextNodes.some(node=>node===el||node.contains(el));
      const sameReviewShell=itemShells.some(node=>node===el||node.contains(el));
      let numericCluster=false,edgeAfterNumbers=false,edgeBeforeNumbers=false,rightmostAfterNumbers=false,walk=el;
      for(let depth=0;walk&&depth<7;depth+=1,walk=walk.parentElement){
        let controls=[];
        try{controls=[...walk.querySelectorAll('button,a,[role="button"],[role="link"]')].filter(node=>{const st=getComputedStyle(node),r=node.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)!==0&&r.width>0&&r.height>0;});}catch{}
        const numericIndexes=[];
        for(let i=0;i<controls.length;i+=1){if(/^\\d{1,5}$/.test(String(controls[i].innerText||controls[i].textContent||'').trim()))numericIndexes.push(i);}
        if(numericIndexes.length>=2){
          numericCluster=true;
          const controlIndex=controls.findIndex(node=>node===el||node.contains(el)||el.contains(node));
          if(controlIndex>=0){
            const firstNumeric=Math.min(...numericIndexes),lastNumeric=Math.max(...numericIndexes);
            edgeAfterNumbers=controlIndex>lastNumeric;
            edgeBeforeNumbers=controlIndex<firstNumeric;
            rightmostAfterNumbers=edgeAfterNumbers&&controlIndex===controls.length-1;
          }
          break;
        }
      }
      const ancestry=[];walk=el;for(let depth=0;walk&&depth<4;depth+=1,walk=walk.parentElement){ancestry.push(walk.getAttribute?.('data-testid'),walk.getAttribute?.('data-element-name'),walk.getAttribute?.('aria-label'),walk.getAttribute?.('role'),[...(walk.classList||[])].join(' '));}
      const blob=ancestry.filter(Boolean).join(' ').toLowerCase();
      const semanticNext=/(?:next|berikut|selanjut|lanjut|chevron[-_ ]?right|arrow[-_ ]?right|right[-_ ]?paginat|paginat[^ ]*[-_ ]?right)/.test(blob);
      const semanticPrevious=/(?:previous|prev\\b|sebelum|chevron[-_ ]?left|arrow[-_ ]?left|left[-_ ]?paginat)/.test(blob);
      const wrongSection=/(?:facility|facilities|amenit|gallery|carousel|photo|image-slider|room-tab|recommendation)/.test(blob)&&!/paginat|review/.test(blob);
      let score=0;if(inContext)score+=2400;if(sameReviewShell)score+=1000;if(paginationRoot)score+=700;if(numericCluster)score+=420;if(rightmostAfterNumbers&&intent.type==='next')score+=1250;else if(edgeAfterNumbers&&intent.type==='next')score+=120;if(semanticNext&&intent.type==='next')score+=950;if(semanticPrevious&&intent.type==='next')score-=1800;if(edgeBeforeNumbers&&intent.type==='next')score-=1500;if(wrongSection)score-=2600;
      return {inContext,sameReviewShell,paginationRoot:Boolean(paginationRoot),numericCluster,edgeAfterNumbers,edgeBeforeNumbers,rightmostAfterNumbers,semanticNext,semanticPrevious,wrongSection,score};
    };
    for(let selectorIndex=0;selectorIndex<selectors.length;selectorIndex+=1){
      const selector=selectors[selectorIndex];
      let list=[];
      try{list=[...document.querySelectorAll(selector)];}catch{}
      for(const raw of list){
        const el=resolveControl(raw);
        if(!el)continue;
        if(seen.has(el)) continue;
        seen.add(el);
        const style=getComputedStyle(el);
        const rect=el.getBoundingClientRect();
        const baseVisible=rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity||1)!==0 && ancestorsVisible(el);
        let matchesDisabled=false;try{matchesDisabled=el.matches(':disabled');}catch{}
        const disabled=Boolean(el.disabled) || el.getAttribute('aria-disabled')==='true' || matchesDisabled;
        const hit=baseVisible ? hitTest(el,rect) : {inViewport:false,hittable:false};
        const nav=el.closest('[data-element-name="review-paginator-step"]');
        const pageNumber=pageOf(nav || el);
        const location=el.closest('.Review-paginator')?.getAttribute('data-location') || null;
        const navContext=navigationContext(el);
        const semanticScore=intentScore(el,pageNumber);
        candidates.push({el,selector,selectorIndex,visible:baseVisible,inViewport:hit.inViewport,hittable:hit.hittable,disabled,rect,pageNumber,location,intentScore:semanticScore,navigationScore:semanticScore+navContext.score,...navContext});
      }
    }
    const enabled=candidates.filter(x=>!x.disabled);
    let usable=enabled.filter(x=>x.visible);
    const scoped=usable.filter(x=>x.inContext);
    if(contextNodes.length){
      if(scoped.length)usable=scoped;
      else if(isTrip&&(intent.type==='next'||intent.type==='page'))return {ok:false,candidateCount:candidates.length,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,disabledCount:candidates.filter(x=>x.disabled).length,selectors,reason:'trip-configured-context-miss'};
    }
    const safeSection=usable.filter(x=>!x.wrongSection);
    if(safeSection.length)usable=safeSection;

    // Numeric recovery must never click a different page and only discover the
    // mismatch afterwards. Filter to the exact target before any click occurs.
    if(intent.type==='page'&&intent.targetPage!=null){
      const exactTarget=usable.filter(x=>x.pageNumber===intent.targetPage);
      if(exactTarget.length)usable=exactTarget;
      else return {ok:false,candidateCount:candidates.length,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,disabledCount:candidates.filter(x=>x.disabled).length,selectors,reason:'target-page-not-found'};
    }

    // Trip often uses opaque CSS-module classes. Permit structural fallback only
    // inside a numeric paginator cluster/review context. This keeps a stored broad
    // selector seperti link global agar tidak pernah menang di bagian lain halaman hotel.
    if(isTrip&&(intent.type==='next'||intent.type==='page')){
      const tripSafe=usable.filter(x=>x.inContext||x.sameReviewShell||x.paginationRoot||x.numericCluster);
      if(tripSafe.length)usable=tripSafe;
      else return {ok:false,candidateCount:candidates.length,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,disabledCount:candidates.filter(x=>x.disabled).length,selectors,reason:'trip-pagination-context-not-found'};
      if(intent.type==='next'){
        // Trip's paginator window changes as the current page advances. Never allow a
        // generic anchor with pageNumber=null to qualify merely because it was found
        // by an old stored selector. Prefer the explicit current+1 page when visible;
        // otherwise require a semantically-proven Next control or the unique control
        // to the right of the numeric cluster.
        if(intent.currentPage!=null){
          const exactNext=usable.filter(x=>x.pageNumber===intent.currentPage+1);
          if(exactNext.length)usable=exactNext;
          else {
            const directional=usable.filter(x=>x.semanticNext||x.rightmostAfterNumbers);
            if(directional.length)usable=directional;
            else return {ok:false,candidateCount:candidates.length,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,disabledCount:candidates.filter(x=>x.disabled).length,selectors,reason:'trip-next-control-not-proven'};
          }
        }else{
          const directional=usable.filter(x=>x.semanticNext||x.rightmostAfterNumbers);
          if(directional.length)usable=directional;
          else return {ok:false,candidateCount:candidates.length,selectors,reason:'trip-next-control-not-proven'};
        }
        const wrongNumeric=usable.filter(x=>x.pageNumber!=null&&intent.currentPage!=null&&x.pageNumber!==intent.currentPage+1);
        if(usable.length&&wrongNumeric.length===usable.length)return {ok:false,candidateCount:candidates.length,selectors,reason:'trip-next-direction-ambiguous'};
      }
    }
    usable.sort((a,b)=>
      b.navigationScore-a.navigationScore ||
      a.selectorIndex-b.selectorIndex ||
      Number(b.hittable)-Number(a.hittable) ||
      Number(b.inViewport && b.visible)-Number(a.inViewport && a.visible) ||
      Number(b.location==='top')-Number(a.location==='top') ||
      Number(b.visible)-Number(a.visible)
    );
    const picked=usable[0];
    if(!picked) return {ok:false,candidateCount:candidates.length,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,disabledCount:candidates.filter(x=>x.disabled).length,selectors};
    const el=picked.el;
    if(!picked.inViewport||!picked.hittable){try{el.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}catch{}
      const frame=()=>new Promise(resolve=>{try{requestAnimationFrame(()=>resolve());}catch{setTimeout(resolve,0);}});
      await frame();await frame();
    }
    const finalRect=el.getBoundingClientRect();
    const finalHit=hitTest(el,finalRect);
    try{el.focus({preventScroll:true});}catch{}
    try{el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse'}));}catch{}
    try{el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));}catch{}
    try{el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));}catch{}
    try{el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerType:'mouse'}));}catch{}
    try{
      if(typeof el.click==='function')el.click();
      else el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    }catch{
      try{el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}
      catch{return {ok:false,candidateCount:candidates.length,selectorUsed:picked.selector,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,disabledCount:candidates.filter(x=>x.disabled).length,selectors};}
    }
    return {ok:true,candidateCount:candidates.length,selectorUsed:picked.selector,visibleCount:candidates.filter(x=>x.visible).length,hittableCount:candidates.filter(x=>x.hittable).length,hittableAfterScroll:finalHit.hittable,pageNumber:picked.pageNumber,location:picked.location,intentScore:picked.intentScore,navigationScore:picked.navigationScore,contextMatched:picked.inContext,numericCluster:picked.numericCluster,edgeAfterNumbers:picked.edgeAfterNumbers,rightmostAfterNumbers:picked.rightmostAfterNumbers,semanticNext:picked.semanticNext,controlText:String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80),selectors};
  })()`;
  try {
    const result = await win.webContents.executeJavaScript(code, true);
    return result || { ok: false, message: 'Tidak ada hasil dari click pagination.' };
  } catch (error) {
    return { ok: false, message: `Click pagination gagal: ${error.message}`, selectorUsed: null, candidateCount: 0 };
  }
}


async function clickTripPaginatorWindowControl(win, project, currentPage, options = {}) {
  const current = positiveIntOrNull(currentPage);
  if (current == null) return { ok:false, reason:'trip-current-page-unknown', candidateCount:0 };
  const target = current + 1;
  const pagination = project?.pagination || {};
  const contextSelector = String(pagination?.meta?.contextSelector || '').trim();
  const storedSelectors = [...new Set([
    pagination?.selector,
    ...(Array.isArray(pagination?.selectors) ? pagination.selectors : [])
  ].filter(Boolean).map(String))];
  const mode = options.exactOnly ? 'exact-only' : 'exact-or-forward';
  const itemSelector = String(project?.itemSelector || '').trim();
  const code = `(async()=>{
    const current=${JSON.stringify(current)};
    const target=${JSON.stringify(target)};
    const contextSelector=${JSON.stringify(contextSelector)};
    const storedSelectors=${JSON.stringify(storedSelectors)};
    const itemSelector=${JSON.stringify(itemSelector)};
    const mode=${JSON.stringify(mode)};
    const rendered=el=>{
      if(!el||!(el instanceof Element))return false;
      let node=el;
      while(node&&node.nodeType===1){const st=getComputedStyle(node);if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity||1)===0||node.getAttribute?.('aria-hidden')==='true')return false;node=node.parentElement;}
      const r=el.getBoundingClientRect();return r.width>0&&r.height>0;
    };
    const safeQuery=(root,selector)=>{try{return [...(root||document).querySelectorAll(selector)];}catch{return[];}};
    const normalize=el=>String(el?.innerText||el?.textContent||'').replace(/\\s+/g,' ').trim();
    const pageOf=el=>{const t=normalize(el);return /^\\d{1,6}$/.test(t)?Number(t):null;};
    const semanticBlob=el=>{
      const nodes=[el];let child=[];try{child=[...el.querySelectorAll('button,a,[role="button"],[role="link"],svg,use,i,span')].slice(0,12);}catch{}
      nodes.push(...child);
      return nodes.flatMap(node=>[
        node.getAttribute?.('aria-label'),node.getAttribute?.('title'),node.getAttribute?.('rel'),
        node.getAttribute?.('data-testid'),node.getAttribute?.('data-test'),node.getAttribute?.('data-element-name'),
        [...(node.classList||[])].join(' '),normalize(node).slice(0,40)
      ]).filter(Boolean).join(' ').toLowerCase();
    };
    const disabled=el=>{
      const nodes=[el];try{nodes.push(...el.querySelectorAll('button,a,[role="button"],[role="link"]'));}catch{}
      return nodes.some(node=>{let d=false;try{d=Boolean(node.matches?.(':disabled')||node.disabled);}catch{}const aria=String(node.getAttribute?.('aria-disabled')||'').toLowerCase();const cls=[...(node.classList||[])].join(' ');return d||aria==='true'||/(?:^|[-_])disabled(?:__|[-_]|$)/i.test(cls);});
    };
    const active=el=>{
      const nodes=[el];try{nodes.push(...el.querySelectorAll('button,a,[role="button"],[role="link"]'));}catch{}
      return nodes.some(node=>{const aria=String(node.getAttribute?.('aria-current')||'').toLowerCase();const selected=String(node.getAttribute?.('aria-selected')||'').toLowerCase();const data=String(node.getAttribute?.('data-active')||node.getAttribute?.('data-selected')||'').toLowerCase();const cls=[...(node.classList||[])].join(' ');return aria==='page'||aria==='true'||selected==='true'||data==='true'||/(?:^|[-_])(active|current|selected)(?:__|[-_]|$)/i.test(cls);});
    };
    const actionable=unit=>{
      if(!unit)return null;
      try{if(unit.matches('button,a,[role="button"],[role="link"]'))return unit;}catch{}
      let direct=null;try{direct=unit.querySelector(':scope > button,:scope > a,:scope > [role="button"],:scope > [role="link"]');}catch{}
      if(direct)return direct;
      let nested=null;try{nested=unit.querySelector('button,a,[role="button"],[role="link"]');}catch{}
      return nested||unit;
    };
    const unitsFor=root=>{
      if(!root)return [];
      const candidates=[];
      const addList=list=>{if(!list)return;const units=[...list.children].filter(rendered);if(units.length>=3)candidates.push(units);};
      if(/^(UL|OL)$/.test(root.tagName||''))addList(root);
      try{for(const list of root.querySelectorAll(':scope > ul,:scope > ol'))addList(list);}catch{}
      if(!candidates.length){const direct=[...root.children].filter(rendered);if(direct.length>=3)candidates.push(direct);}
      if(!candidates.length){try{for(const list of root.querySelectorAll('ul,ol')){const units=[...list.children].filter(rendered);if(units.length>=3)candidates.push(units);}}catch{}}
      candidates.sort((a,b)=>{
        const na=a.filter(x=>pageOf(x)!=null).length,nb=b.filter(x=>pageOf(x)!=null).length;
        return nb-na || a.length-b.length;
      });
      return candidates[0]||[];
    };
    const roots=new Set();
    const contextRoots=[];
    if(contextSelector){for(const node of safeQuery(document,contextSelector)){if(rendered(node)){roots.add(node);contextRoots.push(node);}}}
    for(const selector of storedSelectors){for(const node of safeQuery(document,selector)){if(!rendered(node))continue;let root=null;try{root=node.closest('ul,ol,nav,[class*="paginat" i],[data-testid*="paginat" i],[data-test*="paginat" i],[aria-label*="paginat" i]');}catch{}if(root)roots.add(root);let walk=node.parentElement;for(let depth=0;walk&&walk!==document.body&&depth<7;depth+=1,walk=walk.parentElement){const units=unitsFor(walk);if(units.filter(x=>pageOf(x)!=null).length>=2){roots.add(walk);break;}}}}
    for(const node of safeQuery(document,'nav,[class*="paginat" i],[data-testid*="paginat" i],[data-test*="paginat" i],[aria-label*="paginat" i]'))if(rendered(node))roots.add(node);
    // Trip uses opaque CSS-module classes, so a compact <ul>/<ol> with several
    // direct numeric <li> children is itself strong paginator evidence.
    for(const list of safeQuery(document,'ul,ol')){
      if(!rendered(list))continue;
      const units=[...list.children].filter(rendered);
      const numeric=units.filter(x=>pageOf(x)!=null);
      if(numeric.length>=2&&units.length<=16)roots.add(list);
    }
    let reviewAnchor=null;
    if(itemSelector){const items=safeQuery(document,itemSelector).filter(rendered);reviewAnchor=items[items.length-1]||null;}
    // When the configured pagination context still resolves, keep discovery inside
    // that context. Global numeric lists are only a recovery path for a stale context.
    const rootPool=contextRoots.length?contextRoots:[...roots];
    const clusters=rootPool.map(root=>{
      const units=unitsFor(root);
      const numeric=units.map((unit,index)=>({unit,index,page:pageOf(unit)})).filter(x=>x.page!=null);
      if(numeric.length<2||units.length>20)return null;
      const pages=numeric.map(x=>x.page);
      const hasCurrent=pages.includes(current);
      const hasTarget=pages.includes(target);
      const activeCurrent=numeric.some(x=>x.page===current&&active(x.unit));
      const configured=Boolean(contextSelector&&safeQuery(document,contextSelector).some(node=>node===root||node.contains(root)||root.contains(node)));
      let proximity=0;if(reviewAnchor){try{const rr=root.getBoundingClientRect(),ir=reviewAnchor.getBoundingClientRect();proximity=Math.max(0,500-Math.min(500,Math.abs(rr.top-ir.bottom)));}catch{}}
      const score=numeric.length*180+(hasCurrent?1100:0)+(activeCurrent?700:0)+(hasTarget?2200:0)+(configured?1800:0)+proximity-(units.length>12?(units.length-12)*80:0);
      return {root,units,numeric,pages,score};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
    const best=clusters[0];
    if(!best)return {ok:false,reason:'trip-paginator-root-not-found',candidateCount:0,targetPage:target};
    const {units,numeric,pages}=best;
    const currentEntry=numeric.find(x=>x.page===current&&(active(x.unit)))||numeric.find(x=>x.page===current)||null;
    const targetEntry=numeric.find(x=>x.page===target)||null;
    const clickUnit=async(unit,kind,pageNumber=null)=>{
      const el=actionable(unit);if(!el||disabled(unit))return {ok:false,reason:'trip-control-disabled',candidateCount:units.length,targetPage:target,numericPages:pages};
      try{el.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}catch{}
      await new Promise(resolve=>{try{requestAnimationFrame(()=>requestAnimationFrame(resolve));}catch{setTimeout(resolve,0);}});
      try{el.focus?.({preventScroll:true});}catch{}
      try{el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse'}));}catch{}
      try{el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));}catch{}
      try{el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));}catch{}
      try{el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerType:'mouse'}));}catch{}
      try{if(typeof el.click==='function')el.click();else el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}catch{try{unit.click?.();}catch{}}
      return {ok:true,actionKind:kind,pageNumber,controlText:normalize(unit).slice(0,80),candidateCount:units.length,numericPages:pages,semanticNext:kind==='semantic-next',edgeAfterNumbers:kind==='right-edge-next',rightmostAfterNumbers:kind==='right-edge-next',numericCluster:true,selectorUsed:'trip-direct-child-paginator'};
    };
    if(targetEntry)return clickUnit(targetEntry.unit,'exact-page',target);
    if(mode==='exact-only')return {ok:false,reason:'trip-target-page-not-visible',candidateCount:units.length,targetPage:target,numericPages:pages};
    if(!currentEntry)return {ok:false,reason:'trip-current-page-not-in-window',candidateCount:units.length,currentPage:current,targetPage:target,numericPages:pages};
    const currentIndex=currentEntry.index;
    const lastNumericIndex=Math.max(...numeric.map(x=>x.index));
    const allNonNumeric=units.map((unit,index)=>({unit,index,text:normalize(unit),blob:semanticBlob(unit)})).filter(x=>pageOf(x.unit)==null&&!disabled(x.unit));
    const afterCurrent=allNonNumeric.filter(x=>x.index>currentIndex);
    const isEllipsisEntry=x=>/^(?:\\.{2,}|…+)$/.test(x.text.replace(/\\s+/g,''))||/(?:ellipsis|more[-_ ]?page|jump[-_ ]?next)/.test(x.blob);
    const ellipsis=afterCurrent.filter(isEllipsisEntry);

    // Trip's live paginator exposes the actual forward control as the rightmost
    // direct child, commonly <li><a>...</a></li>. An ellipsis may appear earlier
    // in the same row. v1.0.20 incorrectly preferred that ellipsis at 5 -> 6.
    // Prefer a real forward control first; ellipsis is only a last-resort window shift.
    const semanticNext=afterCurrent.filter(x=>/(?:next|berikut|selanjut|lanjut|chevron[-_ ]?right|arrow[-_ ]?right|right[-_ ]?paginat|paginat[^ ]*[-_ ]?right)/.test(x.blob)&&!/(?:previous|prev\\b|sebelum|left[-_ ]?paginat|chevron[-_ ]?left)/.test(x.blob));
    if(semanticNext.length){const pick=semanticNext.sort((a,b)=>b.index-a.index)[0];return clickUnit(pick.unit,'semantic-next',null);}

    // CSS-module class names on Trip can be opaque, so the right-edge position in
    // the verified paginator cluster is meaningful. Support both a clickable <li>
    // and an inner <a>/<button>, matching what the picker exposes to the user.
    const trailing=allNonNumeric.filter(x=>x.index>lastNumericIndex);
    const rightmost=trailing.find(x=>x.index===units.length-1&&!isEllipsisEntry(x));
    if(rightmost){
      const priorTrailing=trailing.filter(x=>x.index<rightmost.index);
      const onlyTrailingControl=trailing.length===1;
      const ellipsisBeforeRightEdge=priorTrailing.some(isEllipsisEntry);
      // The picker can legitimately resolve either the outer <li> or its inner <a>.
      // Do not require an inline onclick property: Trip/React may use delegated
      // handlers. clickUnit() prefers an inner anchor/button when present and falls
      // back to the <li>; the caller still requires a fresh-page fingerprint.
      if(onlyTrailingControl||ellipsisBeforeRightEdge)return clickUnit(rightmost.unit,'right-edge-next',null);
    }

    // Ellipsis is not Next. Only use it when no direct forward control can be
    // structurally proven; the caller then re-scans for the exact target before
    // extracting any review data.
    if(ellipsis.length){const pick=ellipsis.sort((a,b)=>a.index-b.index)[0];return clickUnit(pick.unit,'window-forward',null);}
    return {ok:false,reason:'trip-forward-control-not-proven',candidateCount:units.length,targetPage:target,numericPages:pages,currentIndex,lastNumericIndex};
  })()`;
  try {
    const result = await win.webContents.executeJavaScript(code, true);
    return result || { ok:false, reason:'trip-paginator-no-result', candidateCount:0, targetPage:target };
  } catch (error) {
    return { ok:false, reason:'trip-paginator-script-error', message:error.message, candidateCount:0, targetPage:target };
  }
}

function scopedSelector(selector, contextSelector = '') {
  const raw = String(selector || '').trim();
  const context = String(contextSelector || '').trim();
  if (!raw) return '';
  if (!context || raw.startsWith(context)) return raw;
  return `${context} ${raw}`;
}

function primaryPaginationSelectors(pagination = {}) {
  const primary = String(pagination.selector || '').trim();
  if (!primary) return [];
  const context = String(pagination.meta?.contextSelector || '').trim();
  return [...new Set([scopedSelector(primary, context), primary].filter(Boolean))];
}

function storedPaginationAlternativeSelectors(pagination = {}) {
  const primary = String(pagination.selector || '').trim();
  const context = String(pagination.meta?.contextSelector || '').trim();
  const host = String(pagination.meta?.sourceHost || '').toLowerCase();
  const trip = /(^|\.)trip\.com$/.test(host);
  const raw = Array.isArray(pagination.selectors) ? pagination.selectors : [];
  const alternatives = raw
    .map(value => String(value || '').trim())
    .filter(value => value && value !== primary && !(trip && isWeakTripStoredSelector(value)));
  const out = [];
  for (const selector of alternatives) {
    const scoped = scopedSelector(selector, context);
    if (scoped) out.push(scoped);
    out.push(selector);
  }
  return [...new Set(out.filter(Boolean))];
}

function paginationSelectors(pagination = {}, sourceUrl = '') {
  const scoped = [];
  const selected = [];
  const siteStrong = [];
  const semantic = [];
  const labels = [];
  const attrs = pagination.meta?.attributes || {};
  const tag = pagination.meta?.tag || 'button';
  const contextSelector = String(pagination.meta?.contextSelector || '').trim();
  const quote = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let host=String(pagination.meta?.sourceHost||'').toLowerCase();
  try{host=new URL(String(sourceUrl||'')).hostname.toLowerCase()||host;}catch{}

  if (Array.isArray(pagination.selectors)) selected.push(...pagination.selectors);
  if (pagination.selector) selected.push(pagination.selector);
  if (/(^|\.)trip\.com$/.test(host)) {
    const primary = String(pagination.selector || '').trim();
    const filtered = selected.filter(selector => String(selector || '').trim() === primary || !isWeakTripStoredSelector(selector));
    selected.splice(0, selected.length, ...filtered);
  }
  if(contextSelector){
    for(const selector of selected.filter(Boolean)){
      if(String(selector).startsWith(contextSelector))scoped.push(selector);
      else scoped.push(`${contextSelector} ${selector}`);
    }
  }
  if (pagination.type === 'next') {
    if(/agoda\./.test(host))siteStrong.push(
      '.Review-paginator[data-location="top"] [data-element-name*="paginator-next" i]',
      '.Review-paginator [aria-label*="next" i]',
      '[data-element-name="review-paginator-step"] [aria-label*="next" i]'
    );
    else if(/(^|\.)trip\.com$/.test(host))siteStrong.push(
      '[aria-label*="next" i]','[aria-label*="berikut" i]','[title*="next" i]','a[rel="next"]',
      'nav > ul > li > a','nav ul li > a','ul > li > a','ol > li > a',
      'nav > ul > li > button','nav ul li > button','ul > li > button','ol > li > button'
    );
    else if(/tiket\./.test(host))siteStrong.push(
      '[data-testid="chevron-right-pagination"]','[data-testid*="pagination-right" i]'
    );
    else if(/traveloka\./.test(host))siteStrong.push(
      '[data-testid="next-page-btn"]','[data-testid*="pagination-next" i]','[data-testid*="next-pagination" i]'
    );
    else if(/trip\.com$|\.trip\.com$/.test(host))siteStrong.push(
      '[data-testid*="pagination-next" i]','[data-test*="pagination-next" i]','[class*="pagination-next" i]',
      'nav li > a','nav li > button','[class*="paginat" i] li > a','[class*="paginat" i] li > button',
      'ul > li > a','ul > li > button','ol > li > a','ol > li > button'
    );
    else siteStrong.push(
      '[data-testid*="pagination-next" i]','[data-testid*="next-pagination" i]',
      '[data-element-name*="paginator-next" i]','a[rel="next"]'
    );
    labels.push(
      'button[aria-label*="next" i]','[role="button"][aria-label*="next" i]',
      'button[aria-label*="berikut" i]','[role="button"][aria-label*="berikut" i]',
      'button[aria-label*="selanjut" i]','[role="button"][aria-label*="selanjut" i]',
      '[title*="next" i]','[title*="berikut" i]'
    );
  } else if (pagination.type === 'loadMore') {
    siteStrong.push(
      '[data-testid*="load-more" i]','[data-testid*="loadmore" i]',
      '[data-element-name*="load-more" i]','[data-element-name*="loadmore" i]'
    );
    labels.push(
      'button[aria-label*="load more" i]','button[aria-label*="muat lebih" i]',
      'button[title*="load more" i]','button[title*="muat lebih" i]'
    );
  }
  for (const attr of ['data-element-name','aria-label','data-testid','data-selenium','title']) {
    const value = attrs[attr];
    if (!value || String(value).length > 160) continue;
    semantic.push(`${tag}[${attr}="${quote(value)}"]`);
    semantic.push(`[${attr}="${quote(value)}"]`);
    if (attr === 'data-element-name' && String(value).includes('paginator')) {
      semantic.push(`.Review-paginator[data-location="top"] ${tag}[${attr}="${quote(value)}"]`);
      semantic.push(`[data-element-name="review-paginator-step"] ${tag}[${attr}="${quote(value)}"]`);
    }
  }
  // Selectors with nth-of-type are deliberately last; Agoda changes the amount
  // of visible page-number buttons as the current page advances.
  selected.sort((a,b) => Number(String(a).includes('nth-of-type')) - Number(String(b).includes('nth-of-type')));
  const scopedSemantic=contextSelector?semantic.map(selector=>`${contextSelector} ${selector}`):[];
  return [...new Set([...scoped,...scopedSemantic,...selected,...semantic,...siteStrong,...labels].filter(Boolean))];
}

async function executeAction(win, action, delayMs, control) {
  if (!action || !action.type) return;
  if (action.type === 'wait') {
    await interruptibleSleep(clamp(action.ms ?? delayMs, 100, 60000), control);
    return;
  }
  if (action.type === 'click') {
    const result = await clickSelector(win, action.selectors || action.selector);
    if (!result.ok && action.required !== false) throw new Error(`Elemen click tidak ditemukan: ${action.selector}`);
    await waitForSettled(win, action.waitAfterMs ?? delayMs, control);
    return;
  }
  if (action.type === 'input') {
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(action.selector || '')});
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(action.value ?? '')});
      else el.value = ${JSON.stringify(action.value ?? '')};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    const ok = await win.webContents.executeJavaScript(code, true);
    if (!ok && action.required !== false) throw new Error(`Elemen input tidak ditemukan: ${action.selector}`);
    await interruptibleSleep(action.waitAfterMs ?? 300, control);
  }
}

function paginationPageNumberSelectors(project, targetPage) {
  const target = positiveIntOrNull(targetPage);
  if (target == null) return [];
  const value = String(target).replace(/"/g, '\\"');
  const contextSelector = String(project?.pagination?.meta?.contextSelector || '').trim();
  let host = String(project?.pagination?.meta?.sourceHost || '').toLowerCase();
  try { host = new URL(String(project?.startUrl || '')).hostname.toLowerCase() || host; } catch {}
  const base = [
    `[data-element-page-number="${value}"]`,
    `[data-page="${value}"]`,
    `[data-page-number="${value}"]`,
    '[data-testid="page-number-pagination"]',
    '[data-element-name="review-paginator-step"]',
    '[class*="paginat" i] button',
    '[class*="paginat" i] a',
    '[class*="paginat" i] [role="button"]',
    '[data-testid*="paginat" i] button',
    '[data-testid*="paginat" i] a',
    '[data-test*="paginat" i] button',
    '[data-test*="paginat" i] a',
    'nav[aria-label*="paginat" i] button',
    'nav[aria-label*="paginat" i] a'
  ];
  if (/(^|\.)trip\.com$/.test(host)) {
    // Trip may expose only opaque CSS-module classes. These broad structural
    // selectors are safe because clickSelector hard-filters the exact numeric
    // target and requires a paginator context before clicking on Trip.
    base.push(
      'nav > ul > li','nav ul > li','ul > li','ol > li',
      'nav li > a','nav li > button','ul > li > a','ul > li > button','ol > li > a','ol > li > button'
    );
  }
  const scoped = contextSelector
    ? base.map(selector => String(selector).startsWith(contextSelector) ? selector : `${contextSelector} ${selector}`)
    : [];
  const directScoped = contextSelector && /(^|\.)trip\.com$/.test(host)
    ? [`${contextSelector} > li`, `${contextSelector} > li > a`, `${contextSelector} > li > button`, `${contextSelector} > li > [role="button"]`, `${contextSelector} > li > [role="link"]`]
    : [];
  return [...new Set([...directScoped, ...scoped, ...base])];
}

async function waitForSpecificPage(win, project, targetPage, timeoutMs, control, options = {}) {
  const target = positiveIntOrNull(targetPage);
  if (target == null) return { ok:false, code:'PAGINATION_TARGET_UNKNOWN', message:'Nomor halaman target tidak tersedia untuk recovery.' };
  const started = Date.now();
  const beforeContent = String(options.beforeContentFingerprint || '');
  const knownContent = contentFingerprintSet(options.knownContentFingerprints);
  const allowLogicalContent = Boolean(options.allowLogicalContent);
  const requireFreshContent = Boolean(options.requireFreshContent);
  let stableKey = null;
  let stableCount = 0;
  let stableLogicalByContent = false;
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    assertNotCanceled(control);
    if (control.pauseRequested) return { ok:false, code:'RUN_PAUSED', message:'Run dijeda saat memverifikasi recovery pagination.', state:lastState };
    const state = await readPageState(win, project);
    lastState = state;
    const validRecords = Number(state?.itemCount || 0) > 0 && !state?.emptyReviewState && !state?.loadingState;
    const content = validRecords ? pageContentFingerprint(state) : '';
    const contentFresh = validRecords
      && (!beforeContent || content !== beforeContent)
      && !contentIsKnown(state, knownContent);
    const numericReady = validRecords
      && Number(state?.pageNumber) === target
      && (!requireFreshContent || contentFresh);
    const logicalReady = allowLogicalContent
      && validRecords
      && Boolean(beforeContent)
      && contentFresh;
    if (!numericReady && !logicalReady) {
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
      await interruptibleSleep(300, control);
      continue;
    }
    const logicalByContent = !numericReady && logicalReady;
    const effective = logicalByContent ? withLogicalSitePage(state, target, 'content-recovery') : state;
    const key = logicalByContent ? content : pageStateFingerprint(effective);
    if (key === stableKey && logicalByContent === stableLogicalByContent) stableCount += 1;
    else { stableKey = key; stableCount = 1; stableLogicalByContent = logicalByContent; }
    if (stableCount >= 3) {
      await interruptibleSleep(350, control);
      const confirm = await readPageState(win, project);
      const confirmValid = Number(confirm?.itemCount || 0) > 0 && !confirm?.emptyReviewState && !confirm?.loadingState;
      const confirmContent = confirmValid ? pageContentFingerprint(confirm) : '';
      const confirmFresh = confirmValid
        && (!beforeContent || confirmContent !== beforeContent)
        && !contentIsKnown(confirm, knownContent);
      const confirmNumeric = confirmValid
        && Number(confirm?.pageNumber) === target
        && (!requireFreshContent || confirmFresh);
      const confirmLogical = allowLogicalContent
        && confirmValid
        && Boolean(beforeContent)
        && confirmFresh;
      const confirmLogicalByContent = !confirmNumeric && confirmLogical;
      const confirmState = confirmLogicalByContent ? withLogicalSitePage(confirm, target, 'content-recovery-confirm') : confirm;
      const confirmKey = confirmLogicalByContent ? confirmContent : pageStateFingerprint(confirmState);
      if ((confirmNumeric || confirmLogical) && confirmKey === stableKey && confirmLogicalByContent === stableLogicalByContent) {
        return { ok:true, state:confirmState, toPage:target, logicalByContent:confirmLogicalByContent, elapsedMs:Date.now()-started };
      }
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
    }
    await interruptibleSleep(250, control);
  }
  return {
    ok:false,
    code:'PAGINATION_RECOVERY_FAILED',
    message:`Halaman target ${target} tidak stabil setelah recovery pagination.`,
    state:lastState,
    toPage:lastState?.pageNumber ?? null,
    elapsedMs:Date.now()-started
  };
}

async function recoverPaginationToPage(win, project, targetPage, control, onProgress = () => {}, step = 1, reason = '', options = {}) {
  const target = positiveIntOrNull(targetPage);
  if (target == null) return { ok:false, code:'PAGINATION_TARGET_UNKNOWN', message:'Nomor halaman target tidak tersedia untuk recovery.' };
  const current = await readPageState(win, project);
  onProgress({
    stage:'pagination-recovery',
    message:`${reason ? `${reason} ` : ''}Mencoba memulihkan halaman ${target} secara langsung…`,
    page:step,
    sitePage:target
  });
  const selectors = paginationPageNumberSelectors(project, target);
  const clicked = await clickSelector(win, selectors, {
    paginationType:'page',
    currentPage:current?.pageNumber,
    targetPage:target,
    contextSelector:project?.pagination?.meta?.contextSelector || '',
    itemSelector:project?.itemSelector || '',
    sourceHost:project?.pagination?.meta?.sourceHost || ''
  });
  if (!clicked.ok || Number(clicked.pageNumber) !== target) {
    return {
      ok:false,
      code:'PAGINATION_RECOVERY_FAILED',
      message:`Tombol nomor halaman ${target} tidak dapat dipilih dengan aman untuk recovery.`,
      state:current,
      targetPage:target,
      recovery:clicked
    };
  }
  const verified = await waitForSpecificPage(win, project, target, 15000, control, {
    beforeContentFingerprint: pageContentFingerprint(current),
    knownContentFingerprints: options.knownContentFingerprints,
    allowLogicalContent: supportsLogicalContentPagination(current?.url || project.startUrl || ''),
    requireFreshContent: Boolean(options.requireFreshContent)
  });
  if (!verified.ok) return { ...verified, targetPage:target, recovery:clicked };
  onProgress({
    stage:'pagination-recovered',
    message:`Halaman ${target} berhasil dipulihkan dan diverifikasi ulang.`,
    page:step,
    sitePage:target,
    selectorUsed:clicked.selectorUsed
  });
  return { ok:true, targetPage:target, state:verified.state, recovery:clicked, elapsedMs:verified.elapsedMs };
}

async function verifyPaginationAfterDelay(win, project, beforeState, changed, control, onProgress, page, options = {}) {
  const logicalBefore = positiveIntOrNull(options.currentSitePage) ?? positiveIntOrNull(changed?.fromPage) ?? positiveIntOrNull(beforeState?.pageNumber);
  const targetPage = positiveIntOrNull(changed?.toPage) ?? (logicalBefore != null ? logicalBefore + 1 : null);
  const knownContent = contentFingerprintSet(options.knownContentFingerprints);
  const current = await readPageState(win, project);
  const validRecords = Number(current?.itemCount || 0) > 0 && !current?.emptyReviewState && !current?.loadingState;
  const beforeContent = pageContentFingerprint(beforeState);
  const currentContent = pageContentFingerprint(current);
  const confirmedContent = pageContentFingerprint(changed?.state || {});
  const currentKnown = contentIsKnown(current, knownContent);
  const stillConfirmedFresh = validRecords
    && currentContent !== beforeContent
    && !currentKnown
    && (!confirmedContent || currentContent === confirmedContent);

  if (targetPage != null && Number(current?.pageNumber) === targetPage && stillConfirmedFresh) {
    return { ok:true, recovered:false, targetPage, state:current };
  }

  const logicalFreshContent = targetPage != null
    && supportsLogicalContentPagination(current?.url || beforeState?.url || project.startUrl || '')
    && validRecords
    && currentContent !== beforeContent
    && (!confirmedContent || currentContent === confirmedContent)
    && !contentIsKnown(current, knownContent);

  // Agoda dan Trip dapat mempertahankan review target sementara marker page aktif
  // terlambat/ambigu. Setelah tombol pagination sudah mengarah ke target numerik,
  // fingerprint konten baru menjadi bukti yang lebih kuat daripada label tersebut.
  if (logicalFreshContent) {
    return {
      ok:true,
      recovered:false,
      logicalByContent:true,
      targetPage,
      state:withLogicalSitePage(current, targetPage, 'trusted-content-after-delay')
    };
  }

  if (targetPage == null) {
    // Sites without readable page numbers cannot use numeric recovery. Still reject a
    // delayed rollback when content has reverted to the pre-click fingerprint.
    if (validRecords && currentContent !== beforeContent && (!confirmedContent || currentContent === confirmedContent)) {
      return { ok:true, recovered:false, targetPage:null, state:current };
    }
    return {
      ok:false,
      code:'PAGINATION_STATE_RESET',
      message:'Halaman berubah sesaat tetapi kembali ke data lama setelah jeda. Nomor halaman target tidak tersedia untuk recovery otomatis.',
      state:current,
      targetPage:null
    };
  }

  onProgress({
    stage:'pagination-recovery',
    message:`Halaman sempat terkonfirmasi ${targetPage}, tetapi setelah jeda kembali ke ${current?.pageNumber ?? 'state lama'}. Mencoba recovery langsung ke halaman ${targetPage}…`,
    page,
    sitePage:targetPage
  });

  const recovered = await recoverPaginationToPage(
    win, project, targetPage, control, onProgress, page,
    `SPA kembali ke halaman ${current?.pageNumber ?? 'state lama'} setelah jeda.`,
    { knownContentFingerprints:options.knownContentFingerprints, requireFreshContent:true }
  );
  if (!recovered.ok) return recovered;
  return { ...recovered, recovered:true, targetPage, state:recovered.state };
}

async function advancePagination(win, project, delayMs, control, onProgress, page, options = {}) {
  const pagination = project.pagination || { type: 'none' };
  if (pagination.type === 'next' || pagination.type === 'loadMore') {
    const before = await readPageState(win, project);
    const logicalBeforePage = positiveIntOrNull(options.currentSitePage) ?? positiveIntOrNull(before.pageNumber);
    const knownContent = contentFingerprintSet(options.knownContentFingerprints);
    // Catat tahap navigasi sebelum discovery/klik. Jika kontrol tidak pernah dapat
    // dibuktikan, error tetap diarahkan ke Navigasi Halaman, bukan stage sebelumnya
    // seperti Pemeriksaan Akses pada alur Coba Lagi/checkpoint recovery.
    onProgress({
      stage:'pagination',
      message:`Menyiapkan navigasi${logicalBeforePage ? ` dari halaman ${logicalBeforePage}` : ''} dan mencari kontrol halaman berikutnya…`,
      page,
      sitePage:logicalBeforePage
    });
    // A visible numeric paginator window is not proof of the real last page.
    // Agoda can render only a small slice (for example just page 1 plus ellipsis)
    // while a working Next button still exists. End-of-source is therefore accepted
    // only from an explicitly disabled Next control before the click attempt.
    if (pagination.type === 'next' && before.nextDisabled) {
      return { ok:false, code:'PAGINATION_END_REACHED', message:`Halaman terakhir dari sumber telah tercapai${logicalBeforePage ? ` pada halaman ${logicalBeforePage}` : ''}.`, transition:{ fromPage:logicalBeforePage, toPage:null, state:before } };
    }
    const selectors = paginationSelectors(pagination, before.url || project.startUrl || '');
    const clickOptions = {
      paginationType: pagination.type,
      currentPage: logicalBeforePage,
      contextSelector: pagination.meta?.contextSelector || '',
      itemSelector: project.itemSelector || '',
      sourceHost: pagination.meta?.sourceHost || ''
    };
    // The control explicitly selected by the user is authoritative. Try it alone
    // first; only when it is missing/disabled/unhittable may stored alternatives
    // and site/semantic fallbacks participate.
    const primarySelectors = primaryPaginationSelectors(pagination);
    const storedAlternatives = storedPaginationAlternativeSelectors(pagination);
    const tripAdapter = isTripPaginationSource(pagination, before.url || project.startUrl || '');
    const exactTripTarget = tripAdapter && pagination.type === 'next' && logicalBeforePage != null ? logicalBeforePage + 1 : null;
    let clicked = { ok:false, candidateCount:0, message:'Belum ada kontrol pagination yang diverifikasi.' };
    let selectionSource = '';

    // Trip.com changes the number of <li> nodes in its paginator window. Before
    // trusting a positional stored selector, try the explicit next page number.
    // clickSelector hard-filters page intent to exactly current+1, so a broad
    // discovery selector cannot accidentally choose page 1/ellipsis/previous.
    let tripWindowHardFailure = false;
    if (exactTripTarget != null) {
      const exactSelectors = paginationPageNumberSelectors(project, exactTripTarget);
      clicked = await clickSelector(win, exactSelectors, {
        ...clickOptions,
        paginationType:'page',
        targetPage:exactTripTarget
      });
      if (clicked.ok && Number(clicked.pageNumber) === exactTripTarget) selectionSource = 'trip-exact-next-page';
      else clicked = { ...clicked, ok:false };

      // Trip's middle paginator window can hide current+1 behind an ellipsis. Use a
      // dedicated direct-child <li> adapter instead of trusting a positional nth-of-type
      // selector. A window-forward click is NOT treated as a page transition: the exact
      // target must become visible afterwards, unless the clicked control itself changes
      // the review fingerprint (a real semantic/right-edge Next action).
      if (!clicked.ok) {
        const tripWindow = await clickTripPaginatorWindowControl(win, project, logicalBeforePage);
        if (tripWindow.ok && tripWindow.actionKind === 'exact-page' && Number(tripWindow.pageNumber) === exactTripTarget) {
          clicked = tripWindow;
          selectionSource = 'trip-direct-child-exact';
        } else if (tripWindow.ok && tripWindow.actionKind === 'window-forward') {
          onProgress({
            stage:'pagination-recovery',
            message:`Target halaman ${exactTripTarget} belum terlihat. Menggeser jendela paginator Trip lalu mencari target exact ${exactTripTarget}…`,
            page,
            sitePage:logicalBeforePage,
            paginationDiagnostic:{
              adapter:'Trip',
              targetPage:exactTripTarget,
              action:'window-forward',
              controlText:tripWindow.controlText || '',
              numericPages:Array.isArray(tripWindow.numericPages) ? tripWindow.numericPages : []
            }
          });
          await interruptibleSleep(650, control);
          const afterWindow = await readPageState(win, project);
          const reviewContentChanged = pageContentFingerprint(afterWindow) !== pageContentFingerprint(before)
            && Number(afterWindow?.itemCount || 0) > 0;
          const windowLandedOnExactTarget = reviewContentChanged
            && positiveIntOrNull(afterWindow?.pageNumber) === exactTripTarget;
          if (windowLandedOnExactTarget) {
            // Rare variant: the window control itself also advances the review list.
            // This is accepted only when BOTH fresh content and the exact target page
            // are observed; fresh content alone is insufficient proof.
            clicked = { ...tripWindow, pageNumber:exactTripTarget, windowExpanded:true, windowLandedOnExactTarget:true };
            selectionSource = 'trip-window-landed-exact';
            onProgress({
              stage:'pagination-recovered',
              message:`Kontrol jendela paginator Trip langsung mencapai halaman ${exactTripTarget}; nomor halaman dan fingerprint review sama-sama terverifikasi.`,
              page,
              sitePage:exactTripTarget
            });
          } else {
            // An ellipsis/window control is never accepted as proof of current+1 merely
            // because it changed content. Poll briefly for the exact numeric target,
            // then click that target. This tolerates CSS/SPA animation without relaxing
            // the page-proof requirement.
            let exactRetry = { ok:false, candidateCount:0, reason:'trip-target-page-not-visible' };
            const exactWaitStarted = Date.now();
            do {
              exactRetry = await clickSelector(win, exactSelectors, {
                ...clickOptions,
                paginationType:'page',
                targetPage:exactTripTarget
              });
              if (exactRetry.ok && Number(exactRetry.pageNumber) === exactTripTarget) break;
              if (Date.now() - exactWaitStarted >= 2800) break;
              await interruptibleSleep(250, control);
            } while (true);
            if (exactRetry.ok && Number(exactRetry.pageNumber) === exactTripTarget) {
              clicked = { ...exactRetry, windowExpanded:true, windowControlText:tripWindow.controlText || '', windowChangedReviewContent:reviewContentChanged };
              selectionSource = 'trip-window-expand-exact';
              onProgress({
                stage:'pagination-recovered',
                message:`Jendela paginator Trip berhasil digeser; halaman ${exactTripTarget} ditemukan dan dipilih secara exact.`,
                page,
                sitePage:exactTripTarget
              });
            } else {
              clicked = {
                ...exactRetry,
                ok:false,
                candidateCount:Math.max(Number(exactRetry?.candidateCount || 0), Number(tripWindow?.candidateCount || 0)),
                reason:reviewContentChanged ? 'trip-window-changed-content-without-target' : 'trip-target-not-visible-after-window-shift',
                targetPage:exactTripTarget,
                numericPages:tripWindow.numericPages || []
              };
              tripWindowHardFailure = true;
            }
          }
        } else if (tripWindow.ok && (tripWindow.actionKind === 'semantic-next' || tripWindow.actionKind === 'right-edge-next')) {
          // Explicit/right-edge controls are allowed to transition review content
          // directly. Subsequent fingerprint verification still prevents a wrong page.
          clicked = tripWindow;
          selectionSource = tripWindow.actionKind === 'semantic-next' ? 'trip-semantic-next' : 'trip-right-edge-next';
        }
      }
    }

    if (!clicked.ok && !tripWindowHardFailure && primarySelectors.length) {
      clicked = await clickSelector(win, primarySelectors, { ...clickOptions, explicitSelection: true });
      if (clicked.ok) selectionSource = tripAdapter ? 'trip-selected-next' : 'selected';
    }
    // On Trip, stored alternatives such as "... ul a" are locator hints rather
    // than trusted controls. Do not execute them as a separate authoritative tier.
    if (!clicked.ok && !tripWindowHardFailure && storedAlternatives.length && !tripAdapter) {
      clicked = await clickSelector(win, storedAlternatives, { ...clickOptions, explicitSelection: true });
      if (clicked.ok) selectionSource = 'stored-alternative';
    }
    if (!clicked.ok && !tripWindowHardFailure) {
      const excluded = new Set([...primarySelectors, ...(tripAdapter ? [] : storedAlternatives)]);
      const fallbacks = selectors.filter(selector => !excluded.has(selector));
      clicked = await clickSelector(win, fallbacks, clickOptions);
      if (clicked.ok) selectionSource = tripAdapter ? 'trip-structural-next' : 'fallback';
    }
    clicked.selectionSource = selectionSource || 'none';
    if (!clicked.ok) {
      // Treat source end as confirmed only when the paginator itself exposes a
      // disabled Next control. A missing/unmatched control is a navigation error,
      // not evidence that the source ended; this avoids false completion on Agoda.
      const afterMiss = pagination.type === 'next' ? await readPageState(win, project) : before;
      if (pagination.type === 'next' && afterMiss.nextDisabled) {
        return { ok:false, code:'PAGINATION_END_REACHED', message:`Tidak ada halaman berikutnya${logicalBeforePage ? ` setelah halaman ${logicalBeforePage}` : ''}.`, ...clicked, transition:{ fromPage:logicalBeforePage, toPage:null, state:afterMiss } };
      }
      const detail = tripAdapter && exactTripTarget != null
        ? (clicked.reason === 'trip-target-not-visible-after-window-shift'
          ? `Target halaman ${exactTripTarget} belum muncul setelah jendela paginator Trip digeser; tidak ada kontrol lain yang diklik demi menjaga integritas data.`
          : clicked.reason === 'trip-window-changed-content-without-target'
            ? `Kontrol jendela paginator Trip mengubah konten, tetapi halaman target ${exactTripTarget} tidak dapat dibuktikan. Run dihentikan sebelum konten tersebut diekstrak.`
            : `${Number(clicked.candidateCount || 0).toLocaleString('id-ID')} elemen pagination diperiksa, tetapi target halaman ${exactTripTarget} tidak dapat diverifikasi secara aman.`)
        : (clicked.candidateCount ? `${clicked.candidateCount} kandidat ditemukan tetapi tidak dapat diklik.` : 'Tombol tidak ditemukan pada DOM aktif.');
      const selectorInfo = tripAdapter
        ? 'Adapter Trip mempertahankan checkpoint dan tidak menggunakan selector positional sebagai bukti Next.'
        : `Runner menggunakan kondisi tab aktif dan ${selectors.length} fallback selector; akhir sumber belum dapat dibuktikan.`;
      return { ok: false, code:'PAGINATION_FAILED', message: `${detail} ${selectorInfo}`, ...clicked, transition:{ fromPage:logicalBeforePage, toPage:null, state:afterMiss } };
    }
    onProgress({
      stage: 'pagination',
      message: `Pagination diklik${logicalBeforePage ? ` dari halaman ${logicalBeforePage}` : ''}; menunggu halaman baru stabil…`,
      page,
      sitePage: logicalBeforePage != null ? logicalBeforePage + 1 : null,
      selectorUsed: clicked.selectorUsed,
      selectionSource: clicked.selectionSource,
      paginationDiagnostic: {
        adapter: paginationAdapterLabel(before.url || project.startUrl || ''),
        targetPage: logicalBeforePage != null ? logicalBeforePage + 1 : null,
        observedBefore: positiveIntOrNull(before.pageNumber),
        clickedPage: positiveIntOrNull(clicked.pageNumber),
        controlText: clicked.controlText || '',
        semanticNext: Boolean(clicked.semanticNext),
        edgeAfterNumbers: Boolean(clicked.edgeAfterNumbers),
        rightmostAfterNumbers: Boolean(clicked.rightmostAfterNumbers),
        numericCluster: Boolean(clicked.numericCluster)
      }
    });
    let changed = await waitForStablePageChange(win, project, before, Math.max(15000, Math.min(60000, delayMs)), control, {
      currentSitePage: logicalBeforePage,
      knownContentFingerprints: knownContent
    });
    if (!changed.ok && logicalBeforePage != null && pagination.type === 'next') {
      const targetPage = Number(logicalBeforePage) + 1;
      const location = before.url || project.startUrl || '';
      const directRecoveryAllowed = supportsDirectPaginationRecovery(location);
      if (directRecoveryAllowed) {
        const recovery = await recoverPaginationToPage(
          win, project, targetPage, control, onProgress, page,
          `${paginationAdapterLabel(location)} belum membuktikan perubahan konten setelah tombol Next.`,
          { knownContentFingerprints:knownContent, requireFreshContent:true }
        );
        if (recovery.ok && pageContentFingerprint(recovery.state) !== pageContentFingerprint(before)) {
          changed = {
            ok:true,
            fromPage:logicalBeforePage,
            toPage:targetPage,
            state:recovery.state,
            elapsedMs:recovery.elapsedMs,
            recovered:true,
            recovery
          };
        }
      }
    }
    if (!changed.ok) {
      const pageInfo = logicalBeforePage ? ` Halaman sebelum klik ${logicalBeforePage}.` : '';
      const code = changed.code || (changed.reason === 'state-reset' ? 'PAGINATION_STATE_RESET' : changed.reason === 'empty-state' ? 'PAGINATION_EMPTY_STATE' : 'PAGINATION_FAILED');
      const detail = changed.message || `Tombol pagination dapat diklik tetapi halaman baru tidak terkonfirmasi stabil.${pageInfo}`;
      return { ok: false, code, message: detail, ...clicked, transition: changed };
    }
    onProgress({
      stage: 'pagination-confirmed',
      message: `Pagination terkonfirmasi${changed.fromPage && changed.toPage ? `: halaman ${changed.fromPage} → ${changed.toPage}` : ''}. Jeda ${(delayMs/1000).toLocaleString('id-ID')} detik sebelum langkah berikutnya…`,
      page,
      sitePage: changed.toPage ?? (logicalBeforePage != null ? logicalBeforePage + 1 : null),
      selectorUsed: clicked.selectorUsed
    });
    await interruptibleSleep(delayMs, control);
    // SPA frameworks may momentarily render the next page and then restore the old
    // paginator label. Re-read after the user-configured delay and use content
    // identity to distinguish a false label from a real rollback.
    const postDelay = await verifyPaginationAfterDelay(win, project, before, changed, control, onProgress, page, {
      currentSitePage: logicalBeforePage,
      knownContentFingerprints: knownContent
    });
    if (!postDelay.ok) {
      return {
        ok:false,
        code:postDelay.code || 'PAGINATION_STATE_RESET',
        message:postDelay.message || 'Halaman pagination tidak bertahan setelah jeda.',
        ...clicked,
        transition:changed,
        postDelay
      };
    }
    return {
      ok: true,
      ...clicked,
      fromPage: changed.fromPage ?? logicalBeforePage,
      toPage: postDelay.targetPage ?? changed.toPage,
      transition: changed,
      postDelay,
      recovered:Boolean(postDelay.recovered || changed.recovered),
      logicalByContent:Boolean(postDelay.logicalByContent || changed.logicalByContent)
    };
  }
  if (pagination.type === 'scroll') {
    onProgress({ stage: 'scrolling', message: `Scroll langkah ${page}…`, page });
    const ok = await scrollOnce(win, project, control);
    if (ok) {
      onProgress({ stage: 'pagination-confirmed', message: `Scroll menghasilkan data/posisi baru. Jeda ${(delayMs/1000).toLocaleString('id-ID')} detik sebelum langkah berikutnya…`, page });
      await interruptibleSleep(delayMs, control);
    }
    return ok ? { ok:true, message:'' } : { ok:false, code:'PAGINATION_END_REACHED', message:'Scroll tidak menghasilkan data/posisi baru; batas sumber telah tercapai.' };
  }
  return { ok: false, message: `Tipe pagination “${pagination.type}” tidak didukung.` };
}

async function waitForStablePageChange(win, project, beforeState, timeoutMs, control, options = {}) {
  const started = Date.now();
  const beforeKey = pageStateFingerprint(beforeState);
  const beforeContent = pageContentFingerprint(beforeState);
  const logicalBefore = positiveIntOrNull(options.currentSitePage) ?? positiveIntOrNull(beforeState?.pageNumber);
  const expectedNext = logicalBefore != null ? logicalBefore + 1 : null;
  const knownContent = contentFingerprintSet(options.knownContentFingerprints);
  const logicalContentSite = supportsLogicalContentPagination(beforeState?.url || project.startUrl || '');
  let stableKey = null;
  let stableCount = 0;
  let stableLogicalByContent = false;
  let lastState = beforeState;
  let sawReset = false;
  let sawEmpty = false;
  let resetPage = null;

  while (Date.now() - started < timeoutMs) {
    assertNotCanceled(control);
    if (control.pauseRequested) return { ok: false, reason: 'paused', code:'RUN_PAUSED', state: lastState };
    await interruptibleSleep(300, control);
    const now = await readPageState(win, project);
    lastState = now;
    if (now?.emptyReviewState || Number(now?.itemCount || 0) <= 0) {
      sawEmpty = true; stableKey = null; stableCount = 0; stableLogicalByContent = false; continue;
    }
    const nowKey = pageStateFingerprint(now);
    const nowContent = pageContentFingerprint(now);
    const hasObservedPage = now.pageNumber != null;
    const contentChanged = nowContent !== beforeContent;
    const itemsChanged = contentChanged;
    const freshLogicalContent = logicalContentSite
      && expectedNext != null
      && knownContent.size > 0
      && itemsChanged
      && nowContent !== beforeContent
      && !contentIsKnown(now, knownContent);
    if (hasObservedPage && logicalBefore != null && Number(now.pageNumber) < Number(logicalBefore) && !freshLogicalContent) {
      sawReset = true; resetPage = Number(now.pageNumber); stableKey = null; stableCount = 0; stableLogicalByContent = false; continue;
    }
    const pageChanged = hasObservedPage && expectedNext != null && Number(now.pageNumber) === expectedNext;
    const recordsStillPresent = Number(beforeState.itemCount || 0) > 0 ? Number(now.itemCount || 0) > 0 : true;
    const sameDocumentKind = (()=>{try{return new URL(now.url).hostname===new URL(beforeState.url).hostname;}catch{return true;}})();
    const qualifies = recordsStillPresent && sameDocumentKind && (
      expectedNext != null
        ? ((pageChanged && itemsChanged) || freshLogicalContent)
        : itemsChanged
    );
    if (!qualifies) { stableKey = null; stableCount = 0; stableLogicalByContent = false; continue; }
    const logicalByContent = freshLogicalContent && !pageChanged;
    const candidateKey = logicalByContent ? nowContent : nowKey;
    if (candidateKey === stableKey && logicalByContent === stableLogicalByContent) stableCount += 1;
    else { stableKey = candidateKey; stableCount = 1; stableLogicalByContent = logicalByContent; }
    if (stableCount >= 3) {
      await interruptibleSleep(350, control);
      const confirm = await readPageState(win, project);
      const confirmContent = pageContentFingerprint(confirm);
      const confirmItemsChanged = confirmContent !== beforeContent;
      const confirmPageOk = expectedNext == null || Number(confirm.pageNumber) === expectedNext;
      const confirmFreshLogical = logicalContentSite
        && expectedNext != null
        && knownContent.size > 0
        && confirmItemsChanged
        && confirmContent !== beforeContent
        && !contentIsKnown(confirm, knownContent);
      const confirmKey = stableLogicalByContent ? confirmContent : pageStateFingerprint(confirm);
      if (confirmKey === stableKey && (confirmPageOk || confirmFreshLogical) && !confirm.emptyReviewState && Number(confirm.itemCount || 0) > 0) {
        const state = confirmPageOk ? confirm : withLogicalSitePage(confirm, expectedNext, 'trusted-content-change');
        return {
          ok: true,
          fromPage: logicalBefore ?? beforeState.pageNumber,
          toPage: expectedNext ?? state.pageNumber,
          state,
          observedPage: positiveIntOrNull(confirm.pageNumber),
          logicalByContent:Boolean(!confirmPageOk && confirmFreshLogical),
          elapsedMs: Date.now() - started
        };
      }
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
    }
  }
  if (sawReset) {
    return { ok:false, reason:'state-reset', code:'PAGINATION_STATE_RESET', fromPage:logicalBefore ?? beforeState.pageNumber, toPage:resetPage, observedPage:resetPage, state:lastState, elapsedMs:Date.now()-started, message:`Pagination reset dari halaman ${logicalBefore ?? beforeState.pageNumber ?? '?'} ke ${resetPage ?? '?'}. Konten halaman baru tidak dapat dibuktikan.` };
  }
  if (sawEmpty) {
    const sourceLimited = /agoda\./i.test(String(lastState?.url || beforeState?.url || ''));
    return { ok:false, reason:'empty-state', code:sourceLimited ? 'SOURCE_LIMIT_REACHED' : 'PAGINATION_EMPTY_STATE', fromPage:logicalBefore ?? beforeState.pageNumber, toPage:lastState?.pageNumber, state:lastState, elapsedMs:Date.now()-started, message:sourceLimited ? `Agoda berhenti memberikan review setelah halaman ${logicalBefore ?? beforeState.pageNumber ?? '?'}. Data yang sudah terkumpul dipertahankan.` : `Setelah tombol Next diklik, panel review berada pada keadaan kosong terlalu lama. Halaman sebelumnya ${logicalBefore ?? beforeState.pageNumber ?? '?'}.` };
  }
  const repeatedKnownAtTimeout = expectedNext != null && knownContent.size > 0 && contentIsKnown(lastState, knownContent);
  const observedAtTimeout = positiveIntOrNull(lastState?.pageNumber);
  return {
    ok:false,
    reason:'timeout',
    code:repeatedKnownAtTimeout ? 'PAGINATION_CYCLE' : 'PAGINATION_FAILED',
    fromPage:logicalBefore ?? beforeState.pageNumber,
    toPage:observedAtTimeout,
    observedPage:observedAtTimeout,
    expectedPage:expectedNext,
    state:lastState,
    elapsedMs:Date.now()-started,
    message:repeatedKnownAtTimeout
      ? `Target halaman ${expectedNext} belum menampilkan review baru. ${observedAtTimeout != null ? `Paginator yang teramati masih halaman ${observedAtTimeout}. ` : ''}Konten aktif masih sama dengan halaman yang sudah diproses; data tidak diekstrak ulang.`
      : `Target halaman ${expectedNext ?? '?'} belum dapat diverifikasi setelah navigasi.${observedAtTimeout != null ? ` Paginator yang teramati: halaman ${observedAtTimeout}.` : ''}`
  };
}

async function replayPagination(win, project, count, delayMs, control, onProgress, startSitePage = 1) {
  let last = null;
  for (let i = 0; i < count; i++) {
    assertNotCanceled(control);
    if (control.pauseRequested) return { ok:false, code:'RUN_PAUSED', message:'Replay dijeda.', last };
    const from = Number(startSitePage) + i;
    onProgress({ stage: 'replaying', message: `Replay pagination ${i + 1}/${count} (halaman ${from} → ${from + 1})…`, page: i + 1, sitePage: from });
    const result = await advancePagination(win, project, delayMs, control, onProgress, i + 1, { currentSitePage: from });
    last = result;
    if (!result.ok) return { ok:false, code:result.code || 'RESUME_REPLAY_FAILED', message:result.message, last:result };
  }
  return { ok:true, last };
}

async function scrollOnce(win, project, control) {
  const pagination = project.pagination || {};
  const itemSelector = project.itemSelector || '*';
  const pauseMs = clamp(pagination.scrollDelayMs ?? pagination.delayMs ?? 800, 200, 10000);
  const before = await win.webContents.executeJavaScript(`(() => {
    const selector=${JSON.stringify(itemSelector)};
    const items=(()=>{try{return [...document.querySelectorAll(selector)];}catch{return [];}})();
    const candidates=[];const seen=new Set();
    const add=node=>{
      if(!node||seen.has(node))return;seen.add(node);
      const isDocument=node===document.scrollingElement;
      let style=null;try{style=isDocument?null:getComputedStyle(node);}catch{}
      const range=Math.max(0,Number(node.scrollHeight||0)-Number(node.clientHeight||0));
      const overflow=isDocument||/(?:auto|scroll|overlay)/i.test(String(style?.overflowY||''));
      if(range<24||!overflow)return;
      let visible=true;if(!isDocument){try{const rect=node.getBoundingClientRect();visible=rect.width>20&&rect.height>80&&rect.bottom>0&&rect.top<innerHeight;}catch{}}
      if(!visible)return;
      let contained=0;try{contained=isDocument?items.length:items.filter(item=>node.contains(item)).length;}catch{}
      const dialog=Boolean(node.matches?.('[role="dialog"],dialog,[class*="modal" i],[class*="popup" i],[class*="drawer" i]'));
      candidates.push({node,score:contained*10000+(dialog?5000:0)+Math.min(range,4000),contained,range,isDocument});
    };
    for(const item of items){let node=item.parentElement;for(let depth=0;node&&depth<14;depth++,node=node.parentElement)add(node);}
    document.querySelectorAll('[role="dialog"],dialog,[class*="modal" i],[class*="popup" i],[class*="drawer" i]').forEach(add);
    add(document.scrollingElement);
    candidates.sort((a,b)=>b.score-a.score);
    const choice=candidates[0]||{node:document.scrollingElement,isDocument:true,contained:items.length,range:0};
    const target=choice.node;window.__petikDataScrollTargetV1=target;
    const state={top:choice.isDocument?window.scrollY:Number(target.scrollTop||0),height:Number(target.scrollHeight||0),count:items.length,textLength:Number(document.body?.innerText?.length||0),internal:!choice.isDocument,contained:choice.contained};
    const destination=Math.max(0,Number(target.scrollHeight||0)-Number(target.clientHeight||0));
    if(choice.isDocument)window.scrollTo({top:destination,behavior:'auto'});else{try{target.scrollTo({top:destination,behavior:'auto'});}catch{target.scrollTop=destination;}}
    return state;
  })()`, true);
  await interruptibleSleep(pauseMs, control);
  const after = await win.webContents.executeJavaScript(`(() => ({
    top: window.__petikDataScrollTargetV1&&window.__petikDataScrollTargetV1!==document.scrollingElement
      ? Number(window.__petikDataScrollTargetV1.scrollTop||0) : Number(window.scrollY||0),
    height: Number((window.__petikDataScrollTargetV1||document.scrollingElement)?.scrollHeight||0),
    count: (()=>{try{return document.querySelectorAll(${JSON.stringify(itemSelector)}).length;}catch{return 0;}})(),
    textLength: Number((document.body?.innerText || '').length)
  }))()`, true);
  return after.height > before.height || after.top > before.top + 1 || after.count > before.count || after.textLength > before.textLength;
}

async function readPageState(win, project) {
  const itemSelector = project.itemSelector;
  const configuredKeyAttribute = project.itemKeyAttribute || project.itemMeta?.keyAttribute || null;
  const configuredIdentity = project.itemIdentity || project.itemMeta?.identity || null;
  const configuredPaginationSelectors = [...new Set([
    project.pagination?.selector,
    ...(Array.isArray(project.pagination?.selectors) ? project.pagination.selectors : [])
  ].map(value => String(value || '').trim()).filter(Boolean))];
  const configuredPaginationContext = String(project.pagination?.meta?.contextSelector || '').trim();
  const state = await win.webContents.executeJavaScript(String.raw`(() => {
    const itemSelector=${JSON.stringify(itemSelector)};
    const configuredKeyAttribute=${JSON.stringify(configuredKeyAttribute || '')};
    const configuredIdentity=${JSON.stringify(configuredIdentity || null)};
    const configuredPaginationSelectors=${JSON.stringify(configuredPaginationSelectors)};
    const configuredPaginationContext=${JSON.stringify(configuredPaginationContext)};
    const elementActuallyVisible=(el)=>{
      if(!el) return false;
      let node=el;
      while(node && node.nodeType===1){
        const st=getComputedStyle(node);
        if(st.display==='none' || st.visibility==='hidden' || Number(st.opacity||1)===0) return false;
        node=node.parentElement;
      }
      const r=el.getBoundingClientRect();
      if(!(r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth)) return false;
      const x=Math.min(innerWidth-1,Math.max(0,r.left+r.width/2));
      const y=Math.min(innerHeight-1,Math.max(0,r.top+r.height/2));
      const hit=document.elementFromPoint(x,y);
      return Boolean(hit && (hit===el || el.contains(hit)));
    };
    const elementRendered=(el)=>{
      if(!el)return false;let node=el;
      while(node&&node.nodeType===1){const st=getComputedStyle(node);if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity||1)===0||node.getAttribute?.('aria-hidden')==='true')return false;node=node.parentElement;}
      const rect=el.getBoundingClientRect();return rect.width>0&&rect.height>0;
    };
    const all=[...document.querySelectorAll(itemSelector)].filter(elementRendered);
    const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
    const parseJson=raw=>{try{return raw==null?null:JSON.parse(raw);}catch{return null;}};
    let keyAttr=configuredKeyAttribute || '';
    let identity=configuredIdentity || null;
    if(!keyAttr&&!identity&&all.length>=2){
      for(const attr of ['data-review-id','data-comment-id','data-writing-id','data-submit-id','data-item-id','data-record-id','data-product-id','data-id','data-key','id']){const vals=all.map(x=>x.getAttribute(attr)).filter(Boolean);if(vals.length/Math.max(1,all.length)>=.8&&new Set(vals).size>=2){keyAttr=attr;break;}}
      if(!keyAttr){
        const findJson=(root)=>{const wanted=new Set(['writingid','reviewid','review_id','submitid','submit_id','commentid','comment_id']);const walk=(obj,path=[],depth=0)=>{if(obj==null||depth>6)return null;if(Array.isArray(obj)){for(let i=0;i<Math.min(obj.length,20);i++){const h=walk(obj[i],[...path,String(i)],depth+1);if(h)return h;}return null;}if(typeof obj!=='object')return null;for(const [k,v] of Object.entries(obj)){const n=String(k).toLowerCase().replace(/[^a-z0-9_]/g,'');if(wanted.has(n)&&(typeof v==='string'||typeof v==='number'))return {path:[...path,k].join('.'),value:v};}for(const [k,v] of Object.entries(obj)){if(v&&typeof v==='object'){const h=walk(v,[...path,k],depth+1);if(h)return h;}}return null;};for(const a of [...root.attributes]){const raw=String(a.value||'').trim();if(raw.length<2||raw.length>25000||(!raw.startsWith('{')&&!raw.startsWith('[')))continue;const h=walk(parseJson(raw));if(h)return {mode:'containerJsonAttribute',attribute:a.name,jsonPath:h.path};}return null;};
        const ds=all.map(findJson).filter(Boolean);if(ds.length/Math.max(1,all.length)>=.6){const groups=new Map();for(const d of ds){const k=[d.mode,d.attribute,d.jsonPath].join('|');groups.set(k,(groups.get(k)||0)+1);}const b=[...groups.entries()].sort((a,b)=>b[1]-a[1])[0];if(b){const [mode,attribute,jsonPath]=b[0].split('|');identity={mode,attribute,jsonPath};}}
      }
    }
    const rootKey=(item)=>{if(keyAttr)return item.getAttribute(keyAttr);if(!identity)return null;if(identity.mode==='containerAttribute')return item.getAttribute(identity.attribute||'');if(identity.mode==='containerJsonAttribute')return getPath(parseJson(item.getAttribute(identity.attribute||'')),identity.jsonPath||'');return null;};
    const reviewIdentityValue=review=>{
      if(!review||typeof review!=='object')return null;
      for(const key of ['reviewId','review_id','writingid','writingId','commentId','comment_id','submitId','submit_id']){const value=review[key];if(value!=null&&(typeof value==='string'||typeof value==='number')&&String(value).trim())return value;}
      for(const holder of ['review','comment','ugc','content']){const nested=review[holder];if(!nested||typeof nested!=='object'||Array.isArray(nested))continue;for(const key of ['reviewId','review_id','writingid','writingId','commentId','comment_id','submitId','submit_id']){const value=nested[key];if(value!=null&&(typeof value==='string'||typeof value==='number')&&String(value).trim())return value;}}
      const directId=review.id;
      const hasReviewShape=['reviewContentText','reviewOriginalText','reviewText','reviewScore','rating','score','reviewTimestamp','reviewDate'].some(key=>review[key]!=null)||(typeof review.content==='string'&&review.content.trim().length>=8);
      return hasReviewShape&&directId!=null&&String(directId).trim()?directId:null;
    };
    const scanReactValue=(value,depth=0,seenObjects=new WeakSet())=>{
      if(value==null||depth>6||typeof value!=='object')return null;
      if(seenObjects.has(value))return null;seenObjects.add(value);
      for(const key of ['submitId','submit_id','reviewId','review_id','writingId','writingid','commentId','comment_id']){const direct=value[key];if(direct!=null&&(typeof direct==='string'||typeof direct==='number')&&String(direct).trim())return direct;}
      if(Array.isArray(value)){for(const item of value.slice(0,40)){const hit=scanReactValue(item,depth+1,seenObjects);if(hit!=null)return hit;}return null;}
      let traversed=0;for(const [key,next] of Object.entries(value)){if(++traversed>90)break;if(/^(?:return|child|sibling|stateNode|alternate|_debugOwner|_owner)$/i.test(key))continue;if(next&&typeof next==='object'){const hit=scanReactValue(next,depth+1,seenObjects);if(hit!=null)return hit;}}
      return null;
    };
    const sourceNativeReviewId=root=>{
      if(!root)return null;
      const directAttrs=['data-review-id','data-comment-id','data-writing-id','data-submit-id'];
      for(const attr of directAttrs){const value=root.getAttribute?.(attr);if(value!=null&&String(value).trim())return String(value).trim();}
      try{const child=root.querySelector('[data-review-id],[data-comment-id],[data-writing-id],[data-submit-id]');if(child){for(const attr of directAttrs){const value=child.getAttribute(attr);if(value!=null&&String(value).trim())return String(value).trim();}}}catch{}
      let nodes=[root];try{nodes.push(...[...root.querySelectorAll('*')].slice(0,140));}catch{}
      for(const node of nodes){for(const attr of [...(node.attributes||[])]){const raw=String(attr.value||'').trim();if(raw.length<2||raw.length>30000||(!raw.startsWith('{')&&!raw.startsWith('[')))continue;const value=reviewIdentityValue(parseJson(raw));if(value!=null&&String(value).trim())return String(value).trim();}}
      for(const node of nodes.slice(0,80)){let reactKeys=[];try{reactKeys=Object.keys(node).filter(key=>/^__reactProps\$|^__reactFiber\$|^__reactInternalInstance\$/i.test(key)).slice(0,4);}catch{}for(const key of reactKeys){let holder=null;try{holder=node[key];}catch{}if(!holder)continue;const candidates=/^__reactFiber\$/i.test(key)?[holder.memoizedProps,holder.pendingProps]:[holder];for(const candidate of candidates){const value=scanReactValue(candidate);if(value!=null&&String(value).trim())return String(value).trim();}}}
      return null;
    };
    let keys=[];let nativeKeys=[];const seen=new Set();const unique=[];
    for(const item of all){const nativeKey=sourceNativeReviewId(item);const key=nativeKey||rootKey(item);if(key!=null&&String(key)!==''&&seen.has(String(key)))continue;if(key!=null&&String(key)!==''){seen.add(String(key));keys.push(String(key));if(nativeKey!=null&&String(nativeKey)!=='')nativeKeys.push(String(nativeKey));}unique.push(item);}
    // If React/DOM does not expose enough IDs, use only the newest response batch
    // when its native-ID cardinality exactly matches the rendered review-card count.
    // Exact cardinality avoids guessing among accumulated or nested historical data.
    if(nativeKeys.length<Math.max(1,Math.ceil(unique.length*.8))&&unique.length){
      try{
        const batches=Array.isArray(window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__)?window.__PETIKDATA_REVIEW_CAPTURE_BATCHES__:[];
        const recent=[...batches].reverse().find(batch=>Date.now()-Number(batch?.capturedAt||0)<60000&&Array.isArray(batch?.reviewIds)&&new Set(batch.reviewIds.map(String)).size===unique.length);
        if(recent){const batchKeys=[...new Set(recent.reviewIds.map(String))];if(batchKeys.length===unique.length){nativeKeys=batchKeys;keys=batchKeys;}}
      }catch{}
    }
    const numericValue=el=>{
      if(!el)return null;
      const carrier=el.closest?.('[data-element-page-number],[data-testid="page-number-pagination"]')||el;
      const attr=carrier?.getAttribute?.('data-element-page-number');
      const raw=String(carrier?.innerText||carrier?.textContent||'').trim();
      const textValue=/^\d{1,6}$/.test(raw)?Number(raw):null;
      const attrValue=attr!=null&&String(attr).trim()!==''?Number(attr):null;
      // Prefer the visible absolute page label over an internal/local slot index.
      const value=Number.isFinite(textValue)?textValue:attrValue;
      return Number.isFinite(value)?value:null;
    };
    const activeToken=el=>{
      if(!el)return false;
      let nested=[];try{nested=[...el.querySelectorAll('button,[role="button"],a')];}catch{}
      const nodes=[el,...nested];
      return nodes.some(node=>{
        const aria=String(node.getAttribute?.('aria-current')||'').toLowerCase();
        const selected=String(node.getAttribute?.('aria-selected')||'').toLowerCase();
        const dataActive=String(node.getAttribute?.('data-active')||node.getAttribute?.('data-selected')||'').toLowerCase();
        const tokens=[...(node.classList||[])].map(String);
        const cls=tokens.some(value=>/(?:^|[-_])(active|current|selected)(?:__|[-_]|$)/i.test(value))&&!tokens.some(value=>/(?:^|[-_])inactive(?:__|[-_]|$)/i.test(value));
        let disabled=false;try{disabled=Boolean(node.matches?.(':disabled')||node.disabled);}catch{}
        return aria==='page'||aria==='true'||selected==='true'||dataActive==='true'||cls||(disabled&&numericValue(node)!=null);
      });
    };
    let pageNumber=null;
    let pageNumberSource='';
    const siteHost=String(location.hostname||'').toLowerCase();
    const isAgoda=/(^|\.)agoda\./i.test(siteHost);
    const isTrip=/(?:^|\.)trip\.com$/i.test(siteHost);
    let agodaPageControls=[];

    if(isAgoda){
      const roots=[...document.querySelectorAll('.Review-paginator,[data-element-name*="review-paginator" i]')].filter(elementRendered);
      const rawControls=[];
      for(const root of roots){
        try{if(root.matches?.('[data-element-name="review-paginator-step"],[data-element-page-number]'))rawControls.push(root);}catch{}
        try{rawControls.push(...root.querySelectorAll('[data-element-name="review-paginator-step"],[data-element-page-number]'));}catch{}
      }
      agodaPageControls=[...new Set(rawControls)].filter(el=>numericValue(el)!=null&&elementRendered(el));
      const visible=agodaPageControls.filter(elementActuallyVisible);
      const pool=visible.length?visible:agodaPageControls;
      const active=pool.find(activeToken)||agodaPageControls.find(activeToken)||null;
      if(active){
        pageNumber=numericValue(active);
        pageNumberSource='agoda-active-step';
      }else if(pool.length){
        // Agoda builds differ in how the active page is marked. When semantic
        // state is absent, use a unique visual signature only inside the review
        // paginator; never inspect unrelated numeric controls on the page.
        const visual=pool.map(el=>{
          const target=el.querySelector?.('button,[role="button"],a')||el;
          const st=getComputedStyle(target);
          const signature=[st.backgroundColor,st.color,st.fontWeight,st.borderColor,st.borderWidth,st.boxShadow].join('|');
          const bg=String(st.backgroundColor||'');
          const bgVisible=bg&&!/rgba?\(0,\s*0,\s*0(?:,\s*0)?\)|transparent/i.test(bg);
          const weight=Number(st.fontWeight)||0;
          const border=parseFloat(st.borderWidth)||0;
          const shadow=String(st.boxShadow||'')!=='none';
          return {el,signature,score:(bgVisible?400:0)+(weight>=600?120:0)+(border>0?80:0)+(shadow?60:0)};
        });
        const freq=new Map();for(const item of visual)freq.set(item.signature,(freq.get(item.signature)||0)+1);
        const distinct=visual.filter(item=>freq.get(item.signature)===1&&item.score>0).sort((a,b)=>b.score-a.score);
        if(distinct.length===1){pageNumber=numericValue(distinct[0].el);pageNumberSource='agoda-visual-active';}
        if(pageNumber==null){
          const values=[...new Set(pool.map(numericValue).filter(Number.isFinite))];
          if(values.length===1){pageNumber=values[0];pageNumberSource='agoda-single-state';}
        }
      }
    }

    // Generic aria/data-current markers are useful for many sites, but on Agoda
    // the document also contains unrelated numeric controls. Scoping Agoda above
    // prevents those controls from falsely reporting page 1 after navigation.
    if(pageNumber==null&&!isAgoda&&!isTrip){
      const explicitCurrent=[...document.querySelectorAll('[aria-current="page"],[aria-current="true"],[aria-selected="true"],[data-active="true"],[data-selected="true"]')].filter(el=>numericValue(el)!=null&&elementRendered(el));
      if(explicitCurrent.length){pageNumber=numericValue(explicitCurrent[0]);pageNumberSource='explicit-current';}
    }
    const tiketPageControls=[...document.querySelectorAll('[data-testid="page-number-pagination"]')].filter(el=>numericValue(el)!=null && elementRendered(el));
    if(pageNumber==null && tiketPageControls.length){
      // Tiket sering menyimpan state aktif hanya melalui CSS-module. Pertama
      // cari perbedaan visual yang unik; bila tidak ada marker semantik, gunakan
      // pusat kelompok angka berurutan sebagai fallback untuk halaman dalam.
      const current=tiketPageControls.find(activeToken);
      if(current){pageNumber=numericValue(current);pageNumberSource='tiket-active-step';}
      if(pageNumber==null){
        const visual=tiketPageControls.map(el=>{
          const target=el.querySelector?.('button,[role="button"],a')||el;
          const st=getComputedStyle(target);
          const signature=[st.backgroundColor,st.color,st.fontWeight,st.borderColor,st.borderWidth,st.boxShadow].join('|');
          const bg=String(st.backgroundColor||'');
          const bgVisible=bg&&!/rgba?\(0,\s*0,\s*0(?:,\s*0)?\)|transparent/i.test(bg);
          const weight=Number(st.fontWeight)||0;
          const border=parseFloat(st.borderWidth)||0;
          const shadow=String(st.boxShadow||'')!=='none';
          return {el,signature,score:(bgVisible?400:0)+(weight>=600?120:0)+(border>0?80:0)+(shadow?60:0)};
        });
        const freq=new Map();for(const item of visual)freq.set(item.signature,(freq.get(item.signature)||0)+1);
        const distinct=visual.filter(item=>freq.get(item.signature)===1&&item.score>0).sort((a,b)=>b.score-a.score);
        if(distinct.length===1){pageNumber=numericValue(distinct[0].el);pageNumberSource='tiket-visual-active';}
      }
      if(pageNumber==null){
        const values=[...new Set(tiketPageControls.map(numericValue).filter(Number.isFinite))].sort((a,b)=>a-b);
        const groups=[];let group=[];
        for(const value of values){if(!group.length||value===group[group.length-1]+1)group.push(value);else{groups.push(group);group=[value];}}if(group.length)groups.push(group);
        const best=groups.sort((a,b)=>b.length-a.length)[0]||[];
        const hasGap=values.length>best.length && values.length>=5;
        if(hasGap&&best.length>=3){pageNumber=best[Math.floor(best.length/2)];pageNumberSource='tiket-sequence-center';}
      }
    }
    // Trip.com sering memakai class CSS-module tanpa nama semantik. Selain root
    // pagination yang eksplisit, infer cluster angka dari tombol yang dipilih
    // pengguna. Ini membuat state page tetap terbaca walau contextSelector lama
    // kosong seperti pada snapshot Trip v1.0.15.
    let tripPageControls=[];
    let tripNextControls=[];
    if(isTrip){
      const clickableSelector='button,a,[role="button"],[role="link"]';
      const directUnits=root=>{
        if(!root)return [];
        const candidates=[];
        const add=list=>{if(!list)return;const units=[...list.children].filter(elementRendered);if(units.length>=3)candidates.push(units);};
        if(/^(UL|OL)$/.test(root.tagName||''))add(root);
        try{for(const list of root.querySelectorAll(':scope > ul,:scope > ol'))add(list);}catch{}
        if(!candidates.length){const direct=[...root.children].filter(elementRendered);if(direct.length>=3)candidates.push(direct);}
        if(!candidates.length){try{for(const list of root.querySelectorAll('ul,ol'))add(list);}catch{}}
        candidates.sort((a,b)=>b.filter(el=>numericValue(el)!=null).length-a.filter(el=>numericValue(el)!=null).length||a.length-b.length);
        return candidates[0]||[];
      };
      const controlsIn=root=>{
        const units=directUnits(root);
        if(units.filter(el=>numericValue(el)!=null).length>=2)return units;
        try{return [...root.querySelectorAll(clickableSelector)].filter(elementRendered);}catch{return[];}
      };
      const numericIn=root=>controlsIn(root).filter(el=>numericValue(el)!=null);
      const roots=new Set([...document.querySelectorAll('nav,[class*="paginat" i],[data-testid*="paginat" i],[data-test*="paginat" i],[aria-label*="paginat" i]')].filter(elementRendered));
      if(configuredPaginationContext){try{document.querySelectorAll(configuredPaginationContext).forEach(node=>{if(elementRendered(node))roots.add(node);});}catch{}}
      const safeConfigured=configuredPaginationSelectors.filter(selector=>! /^(?:a|button|li|span|\[role=["']?(?:button|link)["']?\])$/i.test(String(selector||'').replace(/\s+/g,'')));
      const selectedNodes=[];
      for(const selector of safeConfigured){try{document.querySelectorAll(selector).forEach(node=>{if(elementRendered(node))selectedNodes.push(node);});}catch{}}
      const addNumericAncestor=node=>{
        let walk=node;
        for(let depth=0;walk&&walk!==document.body&&depth<8;depth+=1,walk=walk.parentElement){
          const numeric=numericIn(walk);
          const total=controlsIn(walk);
          if(numeric.length>=2&&total.length<=30){roots.add(walk);break;}
        }
      };
      selectedNodes.forEach(addNumericAncestor);
      // Trip frequently attaches click handlers to <li> itself. Include direct list
      // items as first-class paginator units instead of assuming every control is an
      // <a>/<button> descendant.
      const globalNumeric=[...document.querySelectorAll('ul > li,ol > li,'+clickableSelector)].filter(el=>numericValue(el)!=null&&elementRendered(el)).slice(0,220);
      for(const node of globalNumeric){let walk=node.parentElement;for(let depth=0;walk&&walk!==document.body&&depth<5;depth+=1,walk=walk.parentElement){const numeric=numericIn(walk),total=controlsIn(walk);if(numeric.length>=2&&total.length<=24){roots.add(walk);break;}}}
      const reviewAnchor=unique.length?unique[unique.length-1]:null;
      const nextSemantic='[aria-label*="next" i],[aria-label*="berikut" i],[aria-label*="selanjut" i],[title*="next" i],[title*="berikut" i],[data-testid*="pagination-next" i],[data-test*="pagination-next" i],[class*="pagination-next" i],a[rel="next"]';
      const clusters=[...roots].map(root=>{
        const allControls=controlsIn(root);
        const numeric=allControls.filter(el=>numericValue(el)!=null);
        if(numeric.length<2)return null;
        const numericIndexes=allControls.map((el,index)=>numericValue(el)!=null?index:-1).filter(index=>index>=0);
        const lastNumeric=Math.max(...numericIndexes);
        const edgeAfter=allControls.filter((el,index)=>index>lastNumeric&&numericValue(el)==null);
        const semanticNext=allControls.filter(el=>{try{return el.matches(nextSemantic)||Boolean(el.querySelector?.(nextSemantic));}catch{return false;}});
        const next=[...new Set([...semanticNext,...edgeAfter])];
        const configuredHit=selectedNodes.some(node=>root===node||root.contains(node))||Boolean(configuredPaginationContext&&(()=>{try{return [...document.querySelectorAll(configuredPaginationContext)].some(node=>node===root||node.contains(root)||root.contains(node));}catch{return false;}})());
        let proximity=0;
        if(reviewAnchor){try{const rr=root.getBoundingClientRect(),ir=reviewAnchor.getBoundingClientRect();const distance=Math.abs(rr.top-ir.bottom);proximity=Math.max(0,500-Math.min(500,distance));}catch{}}
        const score=numeric.length*140+(configuredHit?2000:0)+(next.length?650:0)+proximity-(allControls.length>16?(allControls.length-16)*25:0);
        return {root,numeric,next,score};
      }).filter(Boolean).sort((a,b)=>b.score-a.score);
      const best=clusters[0]||null;
      tripPageControls=best?.numeric||[];
      tripNextControls=best?.next||[];
      if(pageNumber==null&&tripPageControls.length){
        const current=tripPageControls.find(activeToken);
        if(current){pageNumber=numericValue(current);pageNumberSource='trip-active-step';}
        if(pageNumber==null){
          const visual=tripPageControls.map(el=>{
            const st=getComputedStyle(el);
            const signature=[st.backgroundColor,st.color,st.fontWeight,st.borderColor,st.borderWidth,st.boxShadow].join('|');
            const bg=String(st.backgroundColor||'');
            const bgVisible=bg&&!/rgba?\(0,\s*0,\s*0(?:,\s*0)?\)|transparent/i.test(bg);
            const weight=Number(st.fontWeight)||0;
            const border=parseFloat(st.borderWidth)||0;
            const shadow=String(st.boxShadow||'')!=='none';
            return {el,signature,score:(bgVisible?400:0)+(weight>=600?120:0)+(border>0?80:0)+(shadow?60:0)};
          });
          const freq=new Map();for(const item of visual)freq.set(item.signature,(freq.get(item.signature)||0)+1);
          const distinct=visual.filter(item=>freq.get(item.signature)===1&&item.score>0).sort((a,b)=>b.score-a.score);
          if(distinct.length===1){pageNumber=numericValue(distinct[0].el);pageNumberSource='trip-visual-active';}
        }
      }
    }
    const numericPageControls=isAgoda
      ? agodaPageControls
      : [...document.querySelectorAll('[data-element-page-number],[data-testid="page-number-pagination"],[data-element-name="review-paginator-step"]')];
    const allNumericPages=[...numericPageControls,...tripPageControls].map(numericValue).filter(Number.isFinite);
    const uniqueNumericPages=[...new Set(allNumericPages)];
    const lastPageNumber=uniqueNumericPages.length?Math.max(...uniqueNumericPages):null;
    const nextSelectors='[data-testid="chevron-right-pagination"],[data-testid*="pagination-next" i],[data-testid*="next-pagination" i],[data-testid*="pagination-right" i],[data-element-name*="paginator-next" i],[data-element-name*="pagination-next" i],[aria-label*="next" i],[aria-label*="berikut" i],[aria-label*="selanjut" i],a[rel="next"]';
    const semanticNextControls=[...document.querySelectorAll(nextSelectors)];
    const nextControls=(isAgoda
      ? [...document.querySelectorAll('.Review-paginator [data-element-name*="paginator-next" i],.Review-paginator [data-element-name*="pagination-next" i],.Review-paginator [aria-label*="next" i],.Review-paginator [aria-label*="berikut" i],.Review-paginator [aria-label*="selanjut" i]')]
      : isTrip
        ? [...new Set([...tripNextControls,...semanticNextControls])]
        : semanticNextControls).filter(elementRendered);
    const disabledControl=el=>{const node=el.closest?.('button,a,[role="button"],[role="link"]')||el;const aria=String(node.getAttribute?.('aria-disabled')||'').toLowerCase();const cls=[...(node.classList||[])].join(' ');let disabled=false;try{disabled=Boolean(node.matches?.(':disabled')||node.disabled);}catch{}return disabled||aria==='true'||/(?:^|[-_])disabled(?:__|[-_]|$)/i.test(cls);};
    const configuredNextControls=[];
    for(const selector of configuredPaginationSelectors){try{for(const el of document.querySelectorAll(selector)){if(elementRendered(el))configuredNextControls.push(el);}}catch{}}
    const uniqueConfiguredNext=[...new Set(configuredNextControls)];
    const configuredNextAvailable=uniqueConfiguredNext.some(el=>!disabledControl(el));
    const configuredNextDisabled=uniqueConfiguredNext.length>0&&!configuredNextAvailable;
    const nextAvailable=nextControls.some(el=>!disabledControl(el));
    const nextDisabled=nextControls.length>0&&!nextAvailable;
    // lastPageNumber is only the largest number currently rendered in the paginator
    // window. It is informational, not terminal evidence. A source is considered at
    // the last page only when Next is explicitly present and disabled.
    const atLastPage=pageNumber!=null&&nextDisabled;
    const bodyText=String(document.body?.innerText||'').replace(/\s+/g,' ').trim().toLowerCase();
    const emptyReviewState=/(tidak ada ulasan yang sesuai|no reviews? match|no reviews? found|tidak ada review|no review available)/i.test(bodyText);
    const loadingState=[...document.querySelectorAll('[aria-busy="true"],[data-testid*="loading" i],[class*="loading" i],[class*="spinner" i]')].some(elementRendered);
    const samples=unique.slice(0,30).map(x=>(x.innerText||x.textContent||'').replace(/\s+/g,' ').trim().slice(0,600));
    return {
      url: location.href,
      title: document.title,
      pageNumber,
      pageNumberSource,
      lastPageNumber,
      numericPageControlCount: uniqueNumericPages.length,
      nextAvailable,
      nextDisabled,
      nextControlCount: nextControls.length,
      configuredNextAvailable,
      configuredNextDisabled,
      configuredNextControlCount: uniqueConfiguredNext.length,
      atLastPage,
      emptyReviewState,
      loadingState,
      keyAttribute:keyAttr||null,
      identity:identity||null,
      itemCount:unique.length,
      rawItemCount:all.length,
      itemKeys:keys,
      nativeItemKeys:nativeKeys,
      itemIdentityStrength:nativeKeys.length>=Math.max(1,Math.ceil(unique.length*.8))?'source-native':(keys.length?'configured-or-dom':'text-only'),
      itemIdentityCoverage:unique.length?nativeKeys.length/unique.length:0,
      itemSignature: keys.length ? keys.join('|') : samples.join('|'),
      textSignature:samples.join('|')
    };
  })()`, true);
  return state || { url: '', title: '', pageNumber: null, lastPageNumber: null, numericPageControlCount: 0, nextControlCount: 0, configuredNextControlCount: 0, nextDisabled: false, configuredNextDisabled: false, itemCount: 0, rawItemCount: 0, itemKeys: [], nativeItemKeys: [], itemIdentityStrength: 'none', itemIdentityCoverage: 0, itemSignature: '', textSignature: '' };
}

function pageStateFingerprint(state) {
  const payload = [
    state?.url || '',
    state?.pageNumber ?? '',
    state?.itemCount ?? 0,
    state?.itemSignature || state?.textSignature || ''
  ].join('|');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function pageContentFingerprint(state) {
  // Source-native review IDs are stronger than visible text. This matters on Tiket,
  // where consecutive historical pages can contain five visually identical cards
  // (same reviewer/date/rating, no comment) while each review still has a different
  // submitId/reviewId. Only fall back to visible text when native identity coverage
  // is insufficient.
  const nativeKeys = Array.isArray(state?.nativeItemKeys) ? state.nativeItemKeys.filter(Boolean).map(String) : [];
  const itemCount = Number(state?.itemCount || 0);
  const nativeCoverage = Number(state?.itemIdentityCoverage || (itemCount ? nativeKeys.length / itemCount : 0));
  const nativeStrong = state?.itemIdentityStrength === 'source-native' && nativeKeys.length > 0 && nativeCoverage >= 0.8;
  if (nativeStrong) return nativePageFingerprint(nativeKeys, itemCount);
  const stableContent = String(state?.textSignature || '').trim() || String(state?.itemSignature || '').trim();
  const payload = ['text', itemCount, stableContent].join('|');
  return `txt:${crypto.createHash('sha1').update(payload).digest('hex')}`;
}

function tripRecordFreshness(state = {}, previousItemKeys = []) {
  const currentKeys = Array.isArray(state?.itemKeys) ? state.itemKeys.filter(Boolean).map(String) : [];
  const previous = new Set((Array.isArray(previousItemKeys) ? previousItemKeys : []).filter(Boolean).map(String));
  const logicalCount = Math.max(0, Number(state?.itemCount || 0));
  const rawCount = Math.max(logicalCount, Number(state?.rawItemCount || logicalCount));
  const identityComparable = previous.size > 0 && currentKeys.length > 0;
  if (!identityComparable) {
    return {
      identityComparable: false,
      logicalCount,
      rawCount,
      freshCount: logicalCount,
      staleCount: 0,
      unresolvedCount: Math.max(0, logicalCount - currentKeys.length),
      freshKeys: currentKeys.slice(),
      staleKeys: []
    };
  }
  const freshKeys = [];
  const staleKeys = [];
  for (const key of currentKeys) {
    if (previous.has(key)) staleKeys.push(key);
    else freshKeys.push(key);
  }
  return {
    identityComparable: true,
    logicalCount,
    rawCount,
    freshCount: freshKeys.length,
    staleCount: staleKeys.length,
    unresolvedCount: Math.max(0, logicalCount - currentKeys.length),
    freshKeys,
    staleKeys
  };
}

async function stabilizeTripRecordPopulation(win, project, initialState, options = {}) {
  const control = options.control || {};
  const timeoutMs = clamp(options.timeoutMs ?? 7600, 1800, 10000);
  const minStableMs = clamp(options.minStableMs ?? 2600, 1200, Math.max(1200, timeoutMs - 300));
  const staleGraceMs = clamp(options.staleGraceMs ?? 6200, minStableMs, Math.max(minStableMs, timeoutMs - 300));
  const previousItemKeys = Array.isArray(options.previousItemKeys) ? options.previousItemKeys : [];
  const expectedPage = positiveIntOrNull(initialState?.pageNumber);
  const started = Date.now();
  const initialDiagnostic = tripRecordFreshness(initialState, previousItemKeys);
  let bestState = initialState;
  let bestDiagnostic = initialDiagnostic;
  let bestFreshCount = Number(initialDiagnostic.freshCount || 0);
  let bestLogicalCount = Number(initialState?.itemCount || 0);
  let lastKey = '';
  let stableCount = 0;
  let lastGrowthAt = started;

  while (Date.now() - started < timeoutMs) {
    assertNotCanceled(control);
    if (control.pauseRequested) break;
    await interruptibleSleep(320, control);
    const state = await readPageState(win, project);
    if (!state || state.loadingState || state.emptyReviewState) {
      stableCount = 0;
      continue;
    }
    const pageNumber = positiveIntOrNull(state.pageNumber);
    if (expectedPage != null && pageNumber != null && pageNumber !== expectedPage) {
      stableCount = 0;
      continue;
    }
    const logicalCount = Number(state.itemCount || 0);
    if (logicalCount <= 0) {
      stableCount = 0;
      continue;
    }

    const diagnostic = tripRecordFreshness(state, previousItemKeys);
    const freshCount = Number(diagnostic.freshCount || 0);
    const improvesFresh = freshCount > bestFreshCount;
    const improvesLogicalAtSameFresh = freshCount === bestFreshCount && logicalCount > bestLogicalCount;
    if (improvesFresh || improvesLogicalAtSameFresh) {
      bestFreshCount = freshCount;
      bestLogicalCount = logicalCount;
      bestState = state;
      bestDiagnostic = diagnostic;
      stableCount = 0;
      lastKey = '';
      lastGrowthAt = Date.now();
    } else if (freshCount === bestFreshCount && logicalCount === bestLogicalCount) {
      bestState = state;
      bestDiagnostic = diagnostic;
    }

    const identityKey = diagnostic.identityComparable
      ? diagnostic.freshKeys.slice().sort().join('|')
      : pageContentFingerprint(state);
    const key = `${freshCount}|${logicalCount}|${identityKey}`;
    if (freshCount === bestFreshCount && logicalCount === bestLogicalCount && key === lastKey) stableCount += 1;
    else if (freshCount === bestFreshCount && logicalCount === bestLogicalCount) { lastKey = key; stableCount = 1; }
    else stableCount = 0;

    const elapsed = Date.now() - started;
    const sinceGrowth = Date.now() - lastGrowthAt;
    // Halaman pendek Trip hanya dianggap stabil setelah populasi *record baru*
    // berulang konsisten. Waktu minimum sengaja mendekati jeda pagination agar
    // node stale sempat diganti oleh card baru tanpa melakukan scroll/klik/reload.
    const staleStillRendered = Number(bestDiagnostic?.staleCount || 0) > 0;
    // Bila node halaman sebelumnya masih terlihat, jangan menganggap populasi baru
    // selesai hanya karena hitungannya diam sebentar. Beri grace period khusus agar
    // virtualized/stale card Trip sempat diganti oleh record halaman aktif.
    const staleGraceSatisfied = !staleStillRendered || elapsed >= staleGraceMs;
    if (stableCount >= 4 && elapsed >= minStableMs && sinceGrowth >= 900 && staleGraceSatisfied) break;
  }
  return {
    state: bestState,
    diagnostic: bestDiagnostic,
    initialCount: Number(initialState?.itemCount || 0),
    finalCount: Number(bestState?.itemCount || bestLogicalCount || 0),
    initialFreshCount: Number(initialDiagnostic.freshCount || 0),
    finalFreshCount: Number(bestDiagnostic?.freshCount || bestFreshCount || 0),
    grew: Number(bestDiagnostic?.freshCount || 0) > Number(initialDiagnostic.freshCount || 0),
    elapsedMs: Date.now() - started
  };
}

async function stabilizeReadablePage(win, project, options = {}) {
  const expectedSitePage = positiveIntOrNull(options.expectedSitePage);
  const previousSitePage = positiveIntOrNull(options.previousSitePage);
  const knownContent = contentFingerprintSet(options.knownContentFingerprints);
  const timeoutMs = clamp(options.timeoutMs ?? 10000, 2500, 30000);
  const control = options.control || {};
  const started = Date.now();
  let stableKey = null;
  let stableCount = 0;
  let stableLogicalByContent = false;
  let lastState = null;
  let sawEmpty = false;
  let sawLoading = false;
  let sawReset = false;
  let resetPage = null;

  while (Date.now() - started < timeoutMs) {
    assertNotCanceled(control);
    if (control.pauseRequested) return { ok:false, code:'RUN_PAUSED', message:'Run dijeda saat menunggu halaman stabil.', state:lastState };
    const state = await readPageState(win, project);
    lastState = state;
    const itemCount = Number(state?.itemCount || 0);
    if (state?.emptyReviewState || itemCount <= 0) {
      sawEmpty = sawEmpty || Boolean(state?.emptyReviewState || itemCount <= 0);
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
      await interruptibleSleep(350, control);
      continue;
    }
    if (state?.loadingState) {
      sawLoading = true;
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
      await interruptibleSleep(350, control);
      continue;
    }

    const logicalContentSite = supportsLogicalContentPagination(state?.url || project.startUrl || '');
    const observedMismatch = expectedSitePage != null && state?.pageNumber != null && Number(state.pageNumber) !== expectedSitePage;
    const contentFingerprint = pageContentFingerprint(state);
    const repeatedKnownContent = expectedSitePage != null && expectedSitePage > 1 && knownContent.size > 0 && contentIsKnown(state, knownContent);
    const freshLogicalContent = logicalContentSite
      && expectedSitePage != null
      && expectedSitePage > 1
      && knownContent.size > 0
      && !contentIsKnown(state, knownContent);

    if (repeatedKnownContent && !freshLogicalContent) {
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
      await interruptibleSleep(350, control);
      continue;
    }

    if (observedMismatch && !freshLogicalContent) {
      if (Number(state.pageNumber) < expectedSitePage || (previousSitePage != null && Number(state.pageNumber) < previousSitePage)) {
        sawReset = true; resetPage = Number(state.pageNumber);
      }
      stableKey = null; stableCount = 0; stableLogicalByContent = false;
      await interruptibleSleep(350, control);
      continue;
    }

    const logicalByContent = Boolean(observedMismatch && freshLogicalContent);
    const effectiveState = logicalByContent ? withLogicalSitePage(state, expectedSitePage, 'trusted-content-stable') : state;
    const key = logicalByContent ? contentFingerprint : pageStateFingerprint(effectiveState);
    if (key === stableKey && logicalByContent === stableLogicalByContent) stableCount += 1;
    else { stableKey = key; stableCount = 1; stableLogicalByContent = logicalByContent; }
    if (stableCount >= 3) {
      return { ok:true, state:effectiveState, logicalByContent, elapsedMs:Date.now()-started };
    }
    await interruptibleSleep(300, control);
  }

  if (sawReset) {
    return {
      ok:false,
      code:'PAGINATION_STATE_RESET',
      message:`State pagination berubah mundur${resetPage != null ? ` ke halaman ${resetPage}` : ''}${expectedSitePage != null ? ` saat halaman ${expectedSitePage} diharapkan` : ''}.`,
      state:lastState, expectedSitePage, detectedSitePage:resetPage
    };
  }
  if (sawEmpty) {
    return {
      ok:false,
      code:/agoda\./i.test(String(lastState?.url||'')) ? 'SOURCE_LIMIT_REACHED' : 'PAGINATION_EMPTY_STATE',
      message:/agoda\./i.test(String(lastState?.url||''))
        ? `Sumber Agoda tidak lagi memberikan record review stabil${expectedSitePage != null ? ` saat halaman ${expectedSitePage} diminta` : ''}. Data yang sudah terkumpul dipertahankan sebagai hasil parsial dari sumber.`
        : `Panel review berada pada keadaan kosong terlalu lama${expectedSitePage != null ? ` saat halaman ${expectedSitePage} diharapkan` : ''}. Data tidak dibaca agar empty-state sementara tidak dianggap halaman valid.`,
      state:lastState, expectedSitePage
    };
  }
  const lastContentFingerprint = lastState ? pageContentFingerprint(lastState) : '';
  const repeatedKnownAtTimeout = expectedSitePage != null && expectedSitePage > 1 && knownContent.size > 0 && contentIsKnown(lastState, knownContent);
  return {
    ok:false,
    code:repeatedKnownAtTimeout ? 'PAGINATION_CYCLE' : (sawLoading?'PAGE_TIMEOUT':'PAGINATION_STATE_UNSTABLE'),
    message:repeatedKnownAtTimeout
      ? `Target halaman ${expectedSitePage} belum menampilkan review baru.${positiveIntOrNull(lastState?.pageNumber) != null ? ` Paginator yang teramati masih halaman ${positiveIntOrNull(lastState?.pageNumber)}.` : ''} Konten aktif sama dengan halaman yang sudah diproses; data tidak diekstrak ulang.`
      : (sawLoading?'Panel review masih memuat dan tidak menjadi stabil dalam batas waktu.':'Keadaan halaman tidak menjadi stabil dalam batas waktu.'),
    state:lastState, expectedSitePage
  };
}

async function recoverTransientReviewPanel(win, project, control, recordLog) {
  let host='';
  try { host=new URL(String(win.webContents.getURL?.()||project.startUrl||'')).hostname.toLowerCase(); } catch {}
  const agoda = /(^|\.)agoda\./.test(host);
  const trip = /(^|\.)trip\.com$/.test(host);
  if (!agoda && !trip) return { attempted:false, recovered:false };
  const before = await readPageState(win, project);
  if (!before?.emptyReviewState && Number(before?.itemCount||0)>0) return { attempted:false, recovered:true, state:before };

  const wake = await win.webContents.executeJavaScript(`(() => {
    const itemSelector=${JSON.stringify(String(project.itemSelector || ''))};
    const contextSelector=${JSON.stringify(String(project.pagination?.meta?.contextSelector || ''))};
    const paginationSelectors=${JSON.stringify([
      project.pagination?.selector,
      ...(Array.isArray(project.pagination?.selectors) ? project.pagination.selectors : [])
    ].map(value=>String(value||'').trim()).filter(Boolean))};
    const isTrip=${JSON.stringify(trip)};
    const norm=v=>String(v||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const safeOne=selector=>{try{return selector?document.querySelector(selector):null;}catch{return null;}};
    let anchor=safeOne(itemSelector)||safeOne(contextSelector);
    if(!anchor){for(const selector of paginationSelectors){anchor=safeOne(selector);if(anchor)break;}}
    if(!anchor){
      const headings=[...document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')];
      anchor=headings.find(el=>/(review|reviews|ulasan|komentar)/i.test(String(el.innerText||el.textContent||'')))||null;
    }
    if(anchor){try{anchor.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});}catch{}}
    try{window.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('scroll'));}catch{}

    const labels=isTrip
      ? ['all reviews','semua ulasan','clear all filters','hapus semua filter']
      : ['hapus semua filter','clear all filters','all reviews','semua ulasan'];
    const controls=[...document.querySelectorAll('button,[role="button"],a')];
    const reviewShell='[role="dialog"],dialog,[data-testid*="review" i],[data-test*="review" i],[class*="review" i],[class*="comment" i]';
    let target=null;
    for(const control of controls){
      const label=norm(control.innerText||control.textContent||control.getAttribute?.('aria-label'));
      if(!labels.includes(label))continue;
      let scoped=false;try{scoped=Boolean(control.closest(reviewShell));}catch{}
      if(scoped||/clear all filters|hapus semua filter/.test(label)){target=control;break;}
    }
    let clicked=false;
    if(target){try{target.scrollIntoView({block:'center',behavior:'auto'});}catch{}try{target.click();clicked=true;}catch{}}
    return {anchored:Boolean(anchor),clicked};
  })()`, true).catch(()=>({anchored:false,clicked:false}));

  if (wake?.clicked) {
    recordLog?.(`Pemulihan ${trip ? 'Trip' : 'Agoda'}: empty-state terdeteksi; kontrol All Reviews/clear filter dicoba sebelum resume.`);
  } else if (wake?.anchored) {
    recordLog?.(`Pemulihan ${trip ? 'Trip' : 'Agoda'}: empty-state terdeteksi; area review/pagination dibangunkan dan diverifikasi ulang.`);
  }
  await interruptibleSleep(wake?.clicked ? 1200 : 700, control);
  const after = await stabilizeReadablePage(win, project, { timeoutMs:6000, control });
  return { attempted:true, recovered:Boolean(after.ok), state:after.state || before, action:wake };
}

async function restoreResumePosition({ worker, project, runStore, checkpointStep, checkpointSitePage, checkpointCompleted, useCurrentPage, delayMs, control, onProgress, recordLog }) {
  const state = runStore?.state || {};
  const targetSitePage = checkpointCompleted
    ? checkpointSitePage
    : (positiveIntOrNull(state.expectedSitePage) ?? checkpointSitePage);
  if (positiveIntOrNull(targetSitePage) == null || Number(targetSitePage) <= 1) {
    if (checkpointCompleted && project.pagination?.type !== 'none') {
      const advanced = await advancePagination(worker, project, Math.min(delayMs, 1500), control, onProgress, checkpointStep, {
        currentSitePage: positiveIntOrNull(targetSitePage) ?? 1,
        knownContentFingerprints: state.contentFingerprints
      });
      if (!advanced.ok) {
        if (isTerminalPaginationCode(advanced.code)) return { ok:true, sourceEndReached:true, code:advanced.code, message:advanced.message || 'Sumber sudah berada di halaman terakhir.', advanced };
        return { ok:false, code:advanced.code || 'RESUME_ADVANCE_FAILED', message:advanced.message, advanced };
      }
      runStore?.checkpoint({ currentPage:checkpointStep+1, currentStep:checkpointStep+1, pageCompleted:false, expectedSitePage:advanced.toPage || 2, paginationRecoveryCount:Number(state.paginationRecoveryCount||0)+1 });
    }
    return { ok:true, recovered:false, targetSitePage:targetSitePage || 1 };
  }

  onProgress({ stage:'replaying', message:`Memverifikasi posisi browser terhadap checkpoint halaman ${targetSitePage}…`, page:checkpointStep, sitePage:targetSitePage });
  let current = await readPageState(worker, project);
  if (current?.emptyReviewState || Number(current?.itemCount || 0) <= 0) {
    const recoveredPanel = await recoverTransientReviewPanel(worker, project, control, recordLog);
    if (recoveredPanel?.recovered && recoveredPanel.state) current = recoveredPanel.state;
  }
  let actualPage = positiveIntOrNull(current?.pageNumber);
  let currentContent = pageContentFingerprint(current);
  if (actualPage == null && Array.isArray(state.pageHistory)) {
    const history = [...state.pageHistory].reverse();
    const match = history.find(entry => entry?.contentFingerprint === currentContent && positiveIntOrNull(entry?.sitePage) != null);
    if (match) actualPage = Number(match.sitePage);
    else if (Array.isArray(current?.itemKeys) && current.itemKeys.length) {
      const currentKeys = new Set(current.itemKeys.map(String));
      let best = null;
      for (const entry of history) {
        if (positiveIntOrNull(entry?.sitePage) == null || !Array.isArray(entry?.itemKeys) || !entry.itemKeys.length) continue;
        const overlap = entry.itemKeys.reduce((sum, key) => sum + (currentKeys.has(String(key)) ? 1 : 0), 0);
        const score = overlap / Math.max(1, Math.min(currentKeys.size, entry.itemKeys.length));
        if (!best || score > best.score) best = { score, sitePage:Number(entry.sitePage) };
      }
      if (best && best.score >= 0.8) actualPage = best.sitePage;
    }
  }

  // Checkpoint yang sudah selesai boleh dikenali juga dari fingerprint konten.
  let atCompletedCheckpoint = Boolean(checkpointCompleted && state.lastPageContentFingerprint && currentContent === state.lastPageContentFingerprint);

  // Trip/Agoda kadang kehilangan marker nomor halaman ketika panel review sedang
  // transisi. Jangan langsung menganggap posisi resume tidak diketahui. Target
  // checkpoint sudah merupakan informasi tepercaya, jadi coba kontrol nomor halaman
  // tersebut secara langsung dan verifikasi hasilnya dari page marker atau konten baru.
  if (!atCompletedCheckpoint && actualPage == null && supportsDirectPaginationRecovery(worker.webContents.getURL())) {
    recordLog?.(`Pemulihan checkpoint: nomor halaman aktif tidak terbaca; mencoba target ${targetSitePage} secara langsung.`);
    const recoveredUnknown = await recoverPaginationToPage(
      worker,
      project,
      Number(targetSitePage),
      control,
      onProgress,
      checkpointStep,
      'Coba Lagi tidak dapat membaca nomor halaman aktif.',
      { knownContentFingerprints:state.contentFingerprints }
    );
    if (recoveredUnknown?.ok) {
      current = recoveredUnknown.state;
      actualPage = positiveIntOrNull(current?.pageNumber) ?? Number(targetSitePage);
      currentContent = pageContentFingerprint(current);
      atCompletedCheckpoint = Boolean(checkpointCompleted && state.lastPageContentFingerprint && currentContent === state.lastPageContentFingerprint);
      recordLog?.(`Pemulihan checkpoint: target halaman ${targetSitePage} berhasil diverifikasi meskipun marker awal tidak terbaca.`);
    }
  }

  if (!atCompletedCheckpoint && actualPage !== Number(targetSitePage)) {
    if (actualPage == null) {
      return { ok:false, code:'RESUME_POSITION_UNKNOWN', message:`Posisi browser tidak dapat dipetakan ke checkpoint halaman ${targetSitePage} dan recovery langsung tidak berhasil. Buka kembali panel review/paginator yang benar lalu coba lagi.`, targetSitePage, current };
    }
    if (actualPage > Number(targetSitePage)) {
      return { ok:false, code:'RESUME_POSITION_AHEAD', message:`Browser berada di halaman ${actualPage}, melewati checkpoint ${targetSitePage}. Pemulihan otomatis dihentikan agar tidak melompati data.`, actualPage, targetSitePage };
    }
    const remaining = Number(targetSitePage) - actualPage;
    let directRecovered = null;
    if (supportsDirectPaginationRecovery(worker.webContents.getURL())) {
      directRecovered = await recoverPaginationToPage(
        worker,
        project,
        Number(targetSitePage),
        control,
        onProgress,
        checkpointStep,
        `Coba Lagi memulihkan checkpoint dari halaman ${actualPage}.`,
        { knownContentFingerprints:state.contentFingerprints }
      );
    }
    if (directRecovered?.ok) {
      recordLog?.(`Pemulihan checkpoint: navigasi langsung berhasil ${actualPage} → ${targetSitePage}.`);
      current = directRecovered.state;
    } else {
      recordLog?.(`Pemulihan checkpoint: browser berada di halaman ${actualPage}; replay ${remaining} perpindahan menuju halaman ${targetSitePage}.`);
      onProgress({ stage:'replaying', message:`Memulihkan posisi ${actualPage} → ${targetSitePage} (${remaining} perpindahan)…`, page:checkpointStep, sitePage:actualPage });
      const replayDelay = clamp(Math.min(delayMs, 1200), 350, 1500);
      const replayed = await replayPagination(worker, project, remaining, replayDelay, control, onProgress, actualPage);
      if (!replayed.ok) return { ok:false, code:replayed.code || 'RESUME_REPLAY_FAILED', message:replayed.message || `Replay berhenti sebelum halaman ${targetSitePage}.`, targetSitePage, actualPage, replayed };
      current = await readPageState(worker, project);
    }
    actualPage = positiveIntOrNull(current?.pageNumber);
    if (actualPage != null && actualPage !== Number(targetSitePage)) {
      return { ok:false, code:'RESUME_RESTORE_MISMATCH', message:`Pemulihan selesai tetapi browser berada di halaman ${actualPage}, bukan checkpoint ${targetSitePage}.`, actualPage, targetSitePage };
    }
  }

  runStore?.checkpoint({
    confirmedSitePage: checkpointCompleted ? Number(targetSitePage) : (state.confirmedSitePage ?? null),
    expectedSitePage: Number(targetSitePage),
    paginationRecoveryCount:Number(state.paginationRecoveryCount||0)+1,
    lastMessage:`Posisi browser dipulihkan ke halaman ${targetSitePage}.`
  });

  if (checkpointCompleted) {
    onProgress({ stage:'replaying', message:`Checkpoint halaman ${targetSitePage} sudah tersimpan; berpindah ke halaman berikutnya…`, page:checkpointStep, sitePage:targetSitePage });
    const advanced = await advancePagination(worker, project, Math.min(delayMs, 1500), control, onProgress, checkpointStep, {
      currentSitePage: Number(targetSitePage),
      knownContentFingerprints: state.contentFingerprints
    });
    if (!advanced.ok) {
      if (isTerminalPaginationCode(advanced.code)) return { ok:true, sourceEndReached:true, code:advanced.code, message:advanced.message || 'Checkpoint sudah berada di halaman terakhir.', advanced };
      return { ok:false, code:advanced.code || 'RESUME_ADVANCE_FAILED', message:advanced.message || 'Tidak dapat berpindah dari checkpoint yang sudah selesai.', advanced };
    }
    runStore?.checkpoint({
      currentPage:checkpointStep+1,
      currentStep:checkpointStep+1,
      pageCompleted:false,
      expectedSitePage:positiveIntOrNull(advanced.toPage) ?? Number(targetSitePage)+1,
      currentUrl:worker.webContents.getURL()
    });
  }
  return { ok:true, recovered:true, targetSitePage, actualPage };
}

async function pageFingerprint(win, itemSelector, itemKeyAttribute = null) {
  // Backward-compatible helper used by older tests/callers.
  const project = { itemSelector, itemKeyAttribute, itemMeta: itemKeyAttribute ? { keyAttribute: itemKeyAttribute } : null };
  return pageStateFingerprint(await readPageState(win, project));
}

async function withRetry(fn, retries, delayMs, onProgress, label) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      onProgress({ stage: 'retry', message: `Gagal ${label}; mencoba lagi ${attempt + 1}/${retries}…` });
      await sleep(Math.min(delayMs * (attempt + 1), 10000));
    }
  }
  throw lastError;
}

async function interruptibleSleep(ms, control) {
  let remaining = ms;
  while (remaining > 0) {
    assertNotCanceled(control);
    if (control.pauseRequested) return;
    const chunk = Math.min(200, remaining);
    await sleep(chunk);
    remaining -= chunk;
  }
}

function assertNotCanceled(control) {
  if (control.cancelRequested) {
    const error = new Error('Run canceled');
    error.code = 'RUN_CANCELED';
    throw error;
  }
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

module.exports = {
  runProject,
  validateProject,
  transformRow,
  hasMissingRequired,
  projectForRun,
  readSourceContext,
  expandTruncatedContent,
  truncationMetadata,
  paginationSelectors,
  __test: {
    readPageState,
    waitForStablePageChange,
    stabilizeReadablePage,
    stabilizeTripRecordPopulation,
    tripRecordFreshness,
    pageContentFingerprint,
    contentIsKnown,
    nativePageFingerprint,
    resumeNativePageFingerprints,
    supportsDirectPaginationRecovery,
    supportsLogicalContentPagination,
    primaryPaginationSelectors,
    storedPaginationAlternativeSelectors,
    isTripPaginationSource,
    isWeakTripStoredSelector,
    paginationPageNumberSelectors,
    clickSelector,
    clickTripPaginatorWindowControl
  }
};
