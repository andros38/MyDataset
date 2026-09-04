const $ = id => document.getElementById(id);
const appApi = window.mydataset || window.petikdata || window.crawlstudio || window.crawlloom;
const AcquisitionPolicy = window.MyDatasetAcquisitionPolicy;
let browser = $('browser');
const BROWSER_ZOOM_PRESETS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
const DEFAULT_HOME_URL = 'https://www.google.com/';

const state = {
  pickTarget: null,
  lastPicked: null,
  containerCandidates: [],
  selectedContainerCandidate: null,
  pendingPagination: null,
  results: [],
  datasetRows: { clean: [], duplicates: [], raw: [] },
  datasetCounts: { clean: 0, duplicates: 0, raw: 0, exactDuplicates: 0, possibleDuplicates: 0, text: 0, withoutText: 0, nativeReviewIds: 0, syntheticReviewIds: 0, missingReviewIds: 0 },
  activeDataset: 'clean',
  duplicateViewMode: 'list',
  duplicateAuditFilter: 'all',
  duplicateAuditSearch: '',
  duplicateDecisions: {},
  processLogMode: 'summary',
  processLogRaw: '',
  liveRunRefreshTimer: null,
  liveRunRefreshBusy: false,
  liveRunRefreshQueued: false,
  liveRunRefreshLastAt: 0,
  browserMonitorTimer: null,
  browserMonitorBusy: false,
  browserMonitorLastFrameAt: 0,
  processDetailsReturnView: 'dataView',
  dataColumnMode: 'compact',
  previewRows: [],
  showingPreview: false,
  projectPath: null,
  activeRunDir: null,
  activeCombinedDir: null,
  activeCombinedManifest: null,
  historyMode: 'sessions',
  selectedSessionDirs: new Set(),
  combinedBaseDir: null,
  combinedBaseName: '',
  pendingRunDir: null,
  runViewSnapshot: null,
  recoverableRun: null,
  running: false,
  autosaveTimer: null,
  fieldQualityTimer: null,
  fieldDialogRevision: 0,
  transientVisualRevision: 0,
  fieldPreviewMatches: 0,
  fieldPreviewTotal: 0,
  fieldPreviewAmbiguous: 0,
  fieldPreviewMismatched: 0,
  fieldExpectedSignature: '',
  fieldCandidateSelectors: [],
  fieldTargetMeta: null,
  fieldInitialValidation: null,
  fieldPreviewFallbackUsed: false,
  fieldPreviewError: '',
  previewDiagnostics: [],
  detectedContainerIdentity: null,
  pendingInferredContainer: null,
  browserMarkerRevision: 0,
  browserReady: false,
  activeView: 'browserView',
  flowMode: 'project',
  flowController: null,
  flowDirty: true,
  appearance: { theme: 'system', uiScale: 110, textSize: 'normal' },
  runtimeFlow: createRuntimeFlow(),
  importedSourceUrl: '',
  stagedNetworkImport: null,
  flowRenderedSignature: '',
  flowViewVisited: false,
  pickSession: 0,
  browserTabs: [],
  activeBrowserTabId: '',
  browserLoadProgressTimer: null,
  browserProfile: null,
  browserSourceClaimSuspended: false,
  lastRunBrowserActivity: null,
  reviewSubjectDirtySinceNavigation: false,
  tripDomPaginationFailureCount: 0,
  project: createDefaultProject()
};

let paths;

const SITE_PROFILE_DEFS = Object.freeze({
  auto: { label: 'Pilih website', help: 'Pilih website sesuai metode akuisisi.' },
  tiket: {
    label: 'Tiket',
    help: 'Tiket dapat diproses melalui HAR / Network atau Halaman Web / DOM.'
  },
  agoda: {
    label: 'Agoda',
    help: 'Agoda dapat diproses melalui HAR / Network atau Halaman Web / DOM.'
  },
  traveloka: {
    label: 'Traveloka',
    help: 'Traveloka didukung melalui HAR / Network menggunakan file HAR Chrome.'
  },
  trip: {
    label: 'Trip',
    help: 'Trip: HAR / Network adalah jalur utama untuk multipage; DOM dipertahankan sebagai best effort untuk preview, eksperimen selector, dan validasi manual.'
  },
  booking: {
    label: 'Booking',
    help: 'Booking diproses melalui HAR / Network menggunakan GraphQL ReviewList.'
  },
  generic: {
    label: 'Situs belum didukung',
    help: 'HAR / Network mendukung Traveloka, Tiket, Agoda, Trip, dan Booking. DOM mendukung Tiket, Agoda, dan Trip.'
  }
});

const ACQUISITION_DEFS = Object.freeze({
  dom: { label: 'Halaman Web / DOM', help: 'Ambil review langsung dari halaman untuk Tiket, Agoda, atau Trip. HAR / Network tetap direkomendasikan untuk pengambilan skala besar.' },
  'network-json': { label: 'HAR / Network', help: 'Impor HAR dari Traveloka, Tiket, Agoda, Trip, atau Booking.' }
});

function acquisitionMethodForSite(siteProfile = state.project.siteProfile || 'auto') {
  const site = AcquisitionPolicy?.normalizedSite(siteProfile, { url: currentBrowserUrl() || state.project.startUrl || state.project.source?.sourceUrl || '' }) || effectiveSiteProfile();
  return AcquisitionPolicy?.methodForSite(site) || 'network-json';
}

function resolvedAcquisitionMethod() {
  return AcquisitionPolicy?.normalizedMethod(state.project.acquisition?.method || 'network-json') || 'network-json';
}

function isGenericProjectName(value = '') {
  return /^(?:proyek baru|new project|proyek|project)$/i.test(String(value || '').trim());
}

function unifiedProjectIdentity(project = state.project) {
  const name = String(project?.name || '').trim();
  if (name && !isGenericProjectName(name)) return name;
  return String(project?.reviewSubject || project?.source?.objectName || '').trim();
}

function setUnifiedProjectIdentity(value, { manual = false, detectedBy = '', syncInput = true } = {}) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean || isGenericProjectName(clean)) {
    state.project.name = 'Proyek Baru';
    state.project.reviewSubject = '';
    if (!state.project.source) state.project.source = { ...createDefaultProject().source };
    if (state.project.source.detectedBy === 'manual' || manual) state.project.source.objectName = '';
    state.project.nameAuto = !manual;
    state.reviewSubjectDirtySinceNavigation = false;
    return '';
  }
  state.project.name = clean;
  state.project.reviewSubject = clean; // legacy compatibility; UI exposes one identity only.
  state.project.source = { ...(state.project.source || {}), objectName: clean, detectedBy: detectedBy || (manual ? 'manual' : state.project.source?.detectedBy || 'project') };
  state.project.nameAuto = !manual;
  state.reviewSubjectDirtySinceNavigation = manual;
  if (syncInput && $('projectName')) $('projectName').value = clean;
  return clean;
}

function createDefaultProject() {
  return {
    version: 23,
    name: 'Proyek Baru',
    nameAuto: true,
    reviewSubject: '',
    dataTarget: 'reviews',
    acquisition: { method: 'network-json', scope: 'all', limit: 5, lastDomScope: null },
    mode: 'quick',
    siteProfile: 'auto',
    startUrl: '',
    source: { objectName: '', siteName: '', sourceUrl: '', canonicalUrl: '', actualUrl: '', identityUrl: '', objectId: '', entityType: '', importSourceType: '', detectedBy: 'unknown' },
    itemSelector: '',
    itemMeta: null,
    itemKeyAttribute: null,
    itemIdentity: null,
    itemMode: 'auto',
    itemLocked: false,
    fields: [],
    beforeActions: [],
    pagination: { type: 'none', lastType: 'next', selector: '', selectors: [], meta: null, maxPages: 5, delayMs: 3000, scrollDelayMs: 800 },
    crawl: { scope: 'same-host', maxDepth: 2, maxUrls: 100, include: '', exclude: '' },
    settings: { timeoutMs: 30000, retryCount: 3, browserZoomPercent: 100 }
  };
}

function createBrowserTabRecord(view, url = '', title = '') {
  const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return { id, view, url: String(url || ''), title: title || 'Tab Baru', loading: false, loadText: 'Siap', progress: 0 };
}

function browserTabById(tabId = state.activeBrowserTabId) {
  return state.browserTabs.find(tab => tab.id === tabId) || state.browserTabs[0] || null;
}

function browserTitleFromUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return 'Tab Baru';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'file:') return decodeURIComponent(parsed.pathname.split(/[\\/]/).pop() || 'File lokal');
    return parsed.hostname.replace(/^www\./, '') || raw.slice(0, 40);
  } catch {
    return raw.slice(0, 40);
  }
}

function setActiveBrowserView(view) {
  browser = view || browser;
  try { applyBrowserZoom(); } catch {}
}

function renderBrowserTabs() {
  const root = $('browserTabs');
  if (!root) return;
  root.innerHTML = '';
  for (const tab of state.browserTabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `browser-tab${tab.loading ? ' loading' : ''}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', tab.id === state.activeBrowserTabId ? 'true' : 'false');
    button.title = tab.url || tab.title || 'Tab Baru';
    button.innerHTML = `<span class="browser-tab-site" aria-hidden="true"></span><span class="browser-tab-title">${escapeHtml(tab.title || browserTitleFromUrl(tab.url))}</span><span class="browser-tab-close close-x" title="Tutup tab">×</span>`;
    button.addEventListener('click', event => {
      if (event.target?.classList?.contains('browser-tab-close')) {
        event.stopPropagation();
        closeBrowserTab(tab.id);
      } else {
        selectBrowserTab(tab.id);
      }
    });
    root.appendChild(button);
  }
  const active = browserTabById();
  if ($('closeBrowserTabBtn')) $('closeBrowserTabBtn').disabled = state.browserTabs.length <= 1;
  if ($('browserLoadText')) $('browserLoadText').textContent = active?.loadText || 'Siap';
  const loading = $('browserLoadState');
  if (loading) {
    loading.classList.toggle('loading', Boolean(active?.loading));
    loading.classList.toggle('done', !active?.loading && Number(active?.progress || 0) >= 100);
    loading.classList.toggle('idle', !active?.loading && Number(active?.progress || 0) < 100);
  }
  if ($('browserLoadBar')) $('browserLoadBar').style.width = `${Math.max(0, Math.min(100, Number(active?.progress || 0)))}%`;
}

function updateBrowserTab(tabId, patch = {}) {
  const tab = browserTabById(tabId);
  if (!tab) return;
  Object.assign(tab, patch);
  if (patch.url && !patch.title) tab.title = browserTitleFromUrl(patch.url);
  renderBrowserTabs();
}

// Electron does not expose a trustworthy byte-level page-load percentage.  The
// browser monitor therefore uses lifecycle progress: navigation starts low,
// advances while Chromium is still loading, moves forward at DOM ready, and
// completes only after the active document finishes/stops loading.  This keeps
// the indicator alive without pretending to measure downloaded bytes.
const BROWSER_LOAD_TIMERS = new Map();

function stopBrowserLoadProgress(tabId) {
  const timer = BROWSER_LOAD_TIMERS.get(tabId);
  if (timer) clearInterval(timer);
  BROWSER_LOAD_TIMERS.delete(tabId);
}

function startBrowserLoadProgress(tabId, { label = 'Memuat halaman…', start = 10 } = {}) {
  stopBrowserLoadProgress(tabId);
  const tab = browserTabById(tabId);
  const existing = Number(tab?.progress || 0);
  const initial = tab?.loading && existing < 100 ? Math.max(existing, Number(start || 0)) : Number(start || 0);
  updateBrowserTab(tabId, { loading: true, loadText: label, progress: Math.min(initial, 88) });
  const timer = setInterval(() => {
    const current = browserTabById(tabId);
    if (!current || !current.loading) {
      stopBrowserLoadProgress(tabId);
      return;
    }
    const value = Number(current.progress || 0);
    const step = value < 32 ? 4 : value < 58 ? 2.5 : value < 76 ? 1.4 : 0.7;
    const next = Math.min(88, value + step);
    if (next > value) updateBrowserTab(tabId, { progress: next });
  }, 260);
  BROWSER_LOAD_TIMERS.set(tabId, timer);
}

function advanceBrowserLoadProgress(tabId, progress, label) {
  const tab = browserTabById(tabId);
  if (!tab) return;
  const next = Math.max(Number(tab.progress || 0), Number(progress || 0));
  updateBrowserTab(tabId, { ...(label ? { loadText: label } : {}), progress: Math.min(94, next) });
}

function finishBrowserLoadProgress(tabId, label = 'Halaman aktif selesai dimuat') {
  stopBrowserLoadProgress(tabId);
  updateBrowserTab(tabId, { loading: false, loadText: label, progress: 0 });
}

function selectBrowserTab(tabId) {
  const tab = browserTabById(tabId);
  if (!tab) return;
  state.activeBrowserTabId = tab.id;
  document.querySelectorAll('.managed-webview').forEach(view => view.classList.toggle('active', view === tab.view));
  setActiveBrowserView(tab.view);
  if ($('urlInput')) $('urlInput').value = tab.url || state.project.startUrl || '';
  state.runtimeFlow.currentUrl = tab.url || state.runtimeFlow.currentUrl || '';
  renderBrowserTabs();
  renderBrowserAccessNotice(state.runtimeFlow.accessStatus);
  renderBrowserMarkers();
}

function bindBrowserEvents(view, tabId) {
  if (!view || view.__petikdataBound) return;
  view.__petikdataBound = true;
  view.addEventListener('ipc-message', event => {
    if (event.channel === 'open-tab-request') {
      const url = String(event.args?.[0]?.url || '').trim();
      if (/^https?:\/\//i.test(url)) {
        createBrowserTab(url, { active: true });
        setStatus('Halaman detail dibuka di tab MyDataset baru.');
      }
      return;
    }
    if (event.channel !== 'element-picked' || !state.pickTarget || tabId !== state.activeBrowserTabId) return;
    handlePickedElement(event.args[0]);
  });
  view.addEventListener('dom-ready', async () => {
    advanceBrowserLoadProgress(tabId, 66, 'Menyiapkan halaman…');
    if (tabId === state.activeBrowserTabId) {
      state.browserReady = true;
      applyBrowserZoom();
      await keepLiveBrowserResponsive();
    }
  });
  view.addEventListener('did-start-loading', () => {
    startBrowserLoadProgress(tabId, { label: 'Memuat halaman…', start: 10 });
    if (tabId !== state.activeBrowserTabId) return;
    $('browserEmpty')?.classList.add('hidden');
    state.browserReady = false;
    state.runtimeFlow.accessStatus = 'checking';
    renderBrowserAccessNotice('checking');
    renderFlowCanvas();
  });
  view.addEventListener('did-fail-load', event => {
    const activeUrl = browserTabById(tabId)?.url || '';
    const failure = appApi.classifyLoadFailure?.({
      errorCode: event?.errorCode,
      errorDescription: event?.errorDescription,
      validatedURL: event?.validatedURL,
      isMainFrame: event?.isMainFrame
    }, activeUrl) || { actionable: event?.isMainFrame !== false };
    if (!failure.actionable) return;
    const label = failure.reason === 'dns' ? 'Alamat tidak ditemukan (DNS)' : 'Halaman gagal dimuat';
    stopBrowserLoadProgress(tabId);
    updateBrowserTab(tabId, { loading: false, loadText: label, progress: 100 });
    if (tabId !== state.activeBrowserTabId) return;
    state.runtimeFlow.accessStatus = 'network-error';
    renderBrowserAccessNotice('network-error');
    if (failure.reason === 'dns') setStatus('Domain utama tidak dapat ditemukan. Periksa alamat/Internet. Error subframe atau resource pihak ketiga tidak lagi dianggap kegagalan halaman.');
    renderFlowCanvas();
  });
  view.addEventListener('did-stop-loading', () => {
    const tab = browserTabById(tabId);
    if (!tab || !/^https?:\/\//i.test(tab.url || '')) return;
    // did-stop-loading is the most reliable final fallback for SPAs. Preserve a
    // real top-level failure, but clear stale failure text if DOM was usable.
    const failed = /^(?:Gagal memuat|Alamat tidak ditemukan|Halaman gagal dimuat)/i.test(tab.loadText || '');
    if (failed) {
      stopBrowserLoadProgress(tabId);
      if (tabId === state.activeBrowserTabId && state.browserReady) finishBrowserLoadProgress(tabId, 'Halaman siap');
      return;
    }
    finishBrowserLoadProgress(tabId, 'Halaman aktif selesai dimuat');
    if (state.running && tabId === state.activeBrowserTabId) syncBrowserRunActivity(state.lastRunBrowserActivity);
  });
  view.addEventListener('did-navigate', event => handleBrowserNavigation(tabId, event?.url));
  view.addEventListener('did-navigate-in-page', event => handleBrowserNavigation(tabId, event?.url, { inPage: true }));
  view.addEventListener('page-title-updated', event => {
    const tab = browserTabById(tabId);
    const title = String(event?.title || '').trim();
    if (tab && title) updateBrowserTab(tabId, { title: title.slice(0, 80) });
  });
  view.addEventListener('did-finish-load', async () => {
    finishBrowserLoadProgress(tabId, 'Halaman aktif selesai dimuat');
    if (state.running && tabId === state.activeBrowserTabId) syncBrowserRunActivity(state.lastRunBrowserActivity);
    if (tabId !== state.activeBrowserTabId) return;
    state.browserReady = true;
    state.runtimeFlow.accessStatus = await detectAccessState();
    renderBrowserAccessNotice(state.runtimeFlow.accessStatus);
    applyBrowserZoom();
    updateSiteProfileFromUrl({ silent: true });
    if (state.project.itemSelector) updateContainerQuality();
    if (!state.running && !state.browserSourceClaimSuspended) await refreshSourceIdentity({ claimPage: true, silent: true });
    renderBrowserMarkers();
    renderFlowCanvas();
  });
}

function httpHost(value) {
  try { const url = new URL(String(value || '')); return /^https?:$/i.test(url.protocol) ? url.hostname.toLowerCase() : ''; } catch { return ''; }
}

function resetExtractionDesignForSourceChange() {
  const hadDesign = Boolean(state.project.fields?.length || state.project.itemSelector || state.project.pagination?.selector);
  state.project.fields = [];
  state.project.itemSelector = '';
  state.project.itemMeta = null;
  state.project.itemKeyAttribute = null;
  state.project.itemIdentity = null;
  state.project.itemMode = 'auto';
  state.project.itemLocked = false;
  state.detectedContainerIdentity = null;
  state.pendingInferredContainer = null;
  state.pendingPagination = null;
  state.previewRows = [];
  state.previewDiagnostics = [];
  state.showingPreview = false;
  if (state.project.pagination) {
    state.project.pagination.selector = '';
    state.project.pagination.selectors = [];
    state.project.pagination.meta = {};
  }
  clearBrowserHighlights();
  renderFields();
  renderPagination();
  updateContainerQuality();
  return hadDesign;
}

function captureDatasetView() {
  return {
    activeRunDir: state.activeRunDir,
    activeCombinedDir: state.activeCombinedDir,
    results: Array.isArray(state.results) ? [...state.results] : [],
    datasetRows: {
      clean: [...(state.datasetRows?.clean || [])],
      duplicates: [...(state.datasetRows?.duplicates || [])],
      raw: [...(state.datasetRows?.raw || [])]
    },
    datasetCounts: { ...(state.datasetCounts || {}) },
    activeDataset: state.activeDataset || 'clean',
    showingPreview: Boolean(state.showingPreview),
    previewRows: [...(state.previewRows || [])]
  };
}

function restoreDatasetView(snapshot) {
  if (!snapshot) return;
  state.activeRunDir = snapshot.activeRunDir || null;
  state.activeCombinedDir = snapshot.activeCombinedDir || null;
  state.results = [...(snapshot.results || [])];
  state.datasetRows = {
    clean: [...(snapshot.datasetRows?.clean || [])],
    duplicates: [...(snapshot.datasetRows?.duplicates || [])],
    raw: [...(snapshot.datasetRows?.raw || [])]
  };
  state.datasetCounts = { ...(snapshot.datasetCounts || { clean: 0, duplicates: 0, raw: 0, exactDuplicates: 0, possibleDuplicates: 0, text: 0, withoutText: 0, nativeReviewIds: 0, syntheticReviewIds: 0, missingReviewIds: 0 }) };
  state.activeDataset = snapshot.activeDataset || 'clean';
  state.showingPreview = Boolean(snapshot.showingPreview);
  state.previewRows = [...(snapshot.previewRows || [])];
  updateDatasetUi();
  renderResults();
}

function reconcileProjectWithNavigation(nextUrl) {
  const nextHost = httpHost(nextUrl);
  if (!nextHost) return;
  const previousUrl = state.project.source?.sourceUrl || state.project.source?.actualUrl || state.project.startUrl || '';
  const previousHost = httpHost(previousUrl);
  if (previousHost && previousHost !== nextHost) {
    const designReset = resetExtractionDesignForSourceChange();
    const preservedIdentity = state.project.nameAuto === false ? unifiedProjectIdentity() : '';
    state.project.source = { ...createDefaultProject().source, actualUrl: nextUrl };
    if (preservedIdentity) {
      state.project.name = preservedIdentity;
      state.project.reviewSubject = preservedIdentity;
      state.project.source.objectName = preservedIdentity;
      state.project.source.detectedBy = 'manual';
      state.reviewSubjectDirtySinceNavigation = true;
    } else {
      state.project.name = 'Proyek Baru';
      state.project.reviewSubject = '';
      state.reviewSubjectDirtySinceNavigation = false;
      if ($('projectName')) $('projectName').value = state.project.name;
    }
    state.importedSourceUrl = '';
    if (designReset) setStatus('Sumber website berubah. Rancangan field lama dilepas agar selector situs sebelumnya tidak ikut dipakai. Dataset run sebelumnya tetap tersimpan di Riwayat.');
  }
  const detected = detectSiteProfileFromUrl(nextUrl);
  if (detected && detected !== 'generic') state.project.siteProfile = detected;
}

function handleBrowserNavigation(tabId, url, { inPage = false } = {}) {
  const safeUrl = String(url || '');
  updateBrowserTab(tabId, { url: safeUrl, loadText: inPage ? 'Halaman berubah' : 'Berpindah halaman' });
  advanceBrowserLoadProgress(tabId, inPage ? 72 : 28);
  if (tabId !== state.activeBrowserTabId) return;
  $('urlInput').value = safeUrl;
  state.runtimeFlow.currentUrl = safeUrl;
  if (state.browserSourceClaimSuspended && !state.running) {
    renderActivePageSourceStatus('');
    renderSourceIdentity();
    renderFlowCanvas();
    return;
  }
  if (!inPage) reconcileProjectWithNavigation(safeUrl);
  if (!state.running && /^(?:https?:|file:)/i.test(safeUrl)) {
    const normalizedHome = DEFAULT_HOME_URL.replace(/\/$/, '');
    const normalizedSafe = String(safeUrl || '').replace(/\/$/, '');
    const passiveHome = normalizedSafe === normalizedHome && isGenericProjectName(state.project.name) && !state.project.fields?.length && !state.project.source?.importedSnapshot;
    if (!passiveHome) {
      state.project.startUrl = safeUrl;
      scheduleAutosave();
      updateSiteProfileFromUrl({ silent: true });
      if (inPage) setTimeout(() => refreshSourceIdentity({ claimPage: true, silent: true }), 250);
    }
  }
  renderFlowCanvas();
}

function createBrowserTab(url = '', { active = true, title = '' } = {}) {
  const stack = $('webviewStack');
  if (!stack) return null;
  const view = document.createElement('webview');
  view.className = 'managed-webview';
  view.setAttribute('partition', 'persist:crawlstudio-session');
  // Popup creation is permitted at the <webview> layer only so the main-process
  // setWindowOpenHandler can inspect it. The handler still denies the popup and
  // forwards trusted HTTP(S) destinations into a managed MyDataset tab.
  view.setAttribute('allowpopups', '');
  view.setAttribute('webpreferences', 'backgroundThrottling=no');
  if (paths?.webviewPreload) view.setAttribute('preload', `file://${paths.webviewPreload.replace(/\\/g, '/')}`);
  stack.appendChild(view);
  const tab = createBrowserTabRecord(view, url, title || browserTitleFromUrl(url));
  state.browserTabs.push(tab);
  bindBrowserEvents(view, tab.id);
  if (active) selectBrowserTab(tab.id);
  if (url) {
    try { view.src = url; } catch {}
  }
  renderBrowserTabs();
  return tab;
}

function closeBrowserTab(tabId = state.activeBrowserTabId) {
  stopBrowserLoadProgress(tabId);
  if (state.browserTabs.length <= 1) {
    const tab = browserTabById(tabId);
    if (tab?.view) {
      try { tab.view.src = DEFAULT_HOME_URL; } catch {}
    }
    updateBrowserTab(tab?.id, { url: DEFAULT_HOME_URL, title: 'Google', loading: true, loadText: 'Memuat halaman…', progress: 10 });
    return;
  }
  const index = state.browserTabs.findIndex(tab => tab.id === tabId);
  if (index < 0) return;
  const [tab] = state.browserTabs.splice(index, 1);
  try { tab.view.remove(); } catch {}
  const next = state.browserTabs[Math.min(index, state.browserTabs.length - 1)];
  selectBrowserTab(next?.id);
  renderBrowserTabs();
}

function initBrowserTabs() {
  const first = createBrowserTabRecord(browser, DEFAULT_HOME_URL, 'Google');
  state.browserTabs = [first];
  state.activeBrowserTabId = first.id;
  browser.classList.add('managed-webview', 'active');
  bindBrowserEvents(browser, first.id);
  selectBrowserTab(first.id);
  if ($('urlInput')) $('urlInput').value = DEFAULT_HOME_URL;
  $('browserEmpty')?.classList.add('hidden');
  try { browser.src = DEFAULT_HOME_URL; } catch {}
  appApi.onBrowserNewTabRequest?.(payload => {
    const url = String(payload?.url || '').trim();
    if (!url) return;
    createBrowserTab(url, { active: true });
    setStatus(`Tab baru dibuka di MyDataset: ${url.slice(0, 90)}`);
  });
}

const FLOW_STAGE_META = Object.freeze({
  idle:{label:'Menunggu',color:'#718097'},starting:{label:'Menyiapkan',color:'#8b7cff'},loading:{label:'Membuka halaman',color:'#29a8e8'},
  'access-guard':{label:'Memeriksa akses',color:'#e4a83b'},'access-required':{label:'Butuh akses manual',color:'#e4a83b'},crawling:{label:'Menjelajah URL',color:'#ef8548'},discovering:{label:'Mencari URL',color:'#ef8548'},
  expanding:{label:'Membuka komentar',color:'#a56cff'},extracting:{label:'Mengambil field',color:'#a56cff'},normalizing:{label:'Membersihkan nilai',color:'#ed6fa8'},
  deduplicating:{label:'Memeriksa duplikat',color:'#4f86ff'},checkpoint:{label:'Menyimpan hasil',color:'#4f86ff'},pagination:{label:'Pindah halaman',color:'#ef8548'},
  'pagination-confirmed':{label:'Halaman berubah',color:'#ef8548'},'pagination-recovery':{label:'Memulihkan pagination',color:'#ef8548'},'pagination-recovered':{label:'Pagination pulih',color:'#ef8548'},'pagination-end':{label:'Akhir pagination',color:'#ef8548'},scrolling:{label:'Menggulir halaman',color:'#ef8548'},replaying:{label:'Memulihkan proses',color:'#ef8548'},
  retry:{label:'Mencoba ulang',color:'#e4a83b'},exporting:{label:'Mengekspor hasil',color:'#27bb7d'},done:{label:'Selesai',color:'#27bb7d'},partial:{label:'Berhenti parsial',color:'#e4a83b'},error:{label:'Gagal',color:'#eb5f6c'}
});

function createRuntimeFlow() {
  return { rows:0,duplicates:0,possibleDuplicates:0,validationWarnings:0,runStatus:'Idle',accessStatus:'unknown',currentUrl:'',stage:'idle',lastOperationalStage:'',failureStage:'',completedStages:[],trace:[],started:false,startedAt:0,running:false,page:0,message:'' };
}

function beginRuntimeFlow(message='Menyiapkan runner dan penyimpanan bertahap…') {
  state.runtimeFlow=createRuntimeFlow();
  advanceRuntimeFlow({stage:'starting',message,page:0});
  state.runtimeFlow.running=true;
  state.runtimeFlow.startedAt=Date.now();
  renderFlowMonitor();
}

async function keepCompletedFlowVisible(minimumMs = 650) {
  const startedAt = Number(state.runtimeFlow?.startedAt || 0);
  if (!startedAt) return;
  const remaining = Math.max(0, Number(minimumMs || 0) - (Date.now() - startedAt));
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

function failureStageForCode(code = '', fallback = '') {
  const value = String(code || '').toUpperCase();
  if (/^PAGINATION_/.test(value)) return 'pagination';
  if (/^RESUME_|CHECKPOINT|RESTORE/.test(value)) return 'replaying';
  if (/ACCESS|CAPTCHA|BLOCKED|FORBIDDEN/.test(value)) return 'access-guard';
  if (/DOM_|SELECTOR|STRUCTURE/.test(value)) return 'extracting';
  if (/JSON|RESPONSE|FILE_READ|NO_REVIEW/.test(value)) return 'loading';
  return String(fallback || 'starting');
}

function advanceRuntimeFlow(payload={}) {
  const flow=state.runtimeFlow;
  const next=String(payload.stage||flow.stage||'idle');
  const terminal=new Set(['retry','access-required','error','partial','done']);
  const previous=String(flow.stage||'idle');
  if(next!==previous && previous!=='idle' && !terminal.has(previous) && !flow.completedStages.includes(previous)) flow.completedStages.push(previous);
  if(next==='done' && !flow.completedStages.includes('done')) flow.completedStages.push('done');
  const failureCode = payload?.failure?.code || payload?.code || '';
  if(next==='error' || next==='partial') {
    flow.failureStage = failureStageForCode(failureCode, flow.lastOperationalStage || previous || 'starting');
    if (flow.failureStage) flow.lastOperationalStage = flow.failureStage;
  } else if(!terminal.has(next)&&next!=='idle') {
    flow.lastOperationalStage=next;
    flow.failureStage='';
  }
  flow.stage=next;flow.started=next!=='idle';flow.running=!['done','partial','error','idle'].includes(next);
  flow.message=String(payload.message||flow.message||'');
  if(payload.page!=null)flow.page=Number(payload.page)||0;
  if(payload.itemsCollected!=null)flow.rows=Number(payload.itemsCollected)||0;
  if(payload.duplicatesSkipped!=null)flow.duplicates=Number(payload.duplicatesSkipped)||0;
  if(payload.possibleDuplicates!=null)flow.possibleDuplicates=Number(payload.possibleDuplicates)||0;
  if(payload.currentUrl)flow.currentUrl=payload.currentUrl;
  if(payload.visitedUrls!=null)flow.visitedUrls=Number(payload.visitedUrls)||0;
  if(payload.queuedUrls!=null)flow.queuedUrls=Number(payload.queuedUrls)||0;
  const last=flow.trace[flow.trace.length-1];
  if(!last||last.stage!==next||last.message!==flow.message){
    const traceItem={stage:next,message:flow.message,time:new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})};
    flow.trace.push(traceItem);
    flow.trace=flow.trace.slice(-12);
    appendProcessLog(traceItem.stage, traceItem.message, traceItem.time);
  }
  renderFlowMonitor();
}

function appendProcessLog(stage, message, time = '') {
  const box = $('logBox');
  if (!box) return;
  const raw = String(message || '').replace(/\s+/g, ' ').trim();
  if (!raw) return;
  const stageMeta = FLOW_STAGE_META[String(stage || '')] || { label: String(stage || 'Proses') };
  const stamp = String(time || new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' }));
  const line = `[${stamp}] ${stageMeta.label} — ${raw}`;
  const lines = String(box.textContent || '').split('\n').filter(Boolean);
  if (lines[lines.length - 1] === line) return;
  lines.push(line);
  // Batasi log live agar renderer tetap ringan pada run yang sangat panjang.
  box.textContent = lines.slice(-1500).join('\n');
  box.scrollTop = box.scrollHeight;
}

function mergeProcessLogs(finalLogs = [], error = '') {
  const box = $('logBox');
  if (!box) return;
  const existing = String(box.textContent || '').split('\n').map(v => v.trim()).filter(Boolean);
  const incoming = [...(finalLogs || []), ...(error ? [error] : [])].map(v => String(v || '').trim()).filter(Boolean);
  const merged = [];
  const seen = new Set();
  for (const line of [...existing, ...incoming]) {
    if (seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
  }
  box.textContent = merged.join('\n');
  box.scrollTop = box.scrollHeight;
}

const FAILURE_STAGE_LABELS = Object.freeze({
  starting:'Persiapan run',loading:'Membuka halaman','access-guard':'Pemeriksaan akses',expanding:'Membuka teks',extracting:'Ekstraksi data',normalizing:'Normalisasi',deduplicating:'Deduplikasi',checkpoint:'Checkpoint',pagination:'Navigasi halaman','pagination-confirmed':'Konfirmasi halaman','pagination-recovery':'Pemulihan pagination','pagination-recovered':'Konfirmasi pemulihan','pagination-end':'Akhir pagination',scrolling:'Scroll',replaying:'Pemulihan checkpoint',discovering:'Penemuan URL',crawling:'Crawler',exporting:'Ekspor'
});

function classifyAcquisitionFailure(message = '', stage = '', method = resolvedAcquisitionMethod()) {
  const text = String(message || '').toLowerCase();
  const currentStage = String(stage || state.runtimeFlow.lastOperationalStage || state.runtimeFlow.stage || 'starting');
  let code = method === 'network-json' ? 'RESPONSE_PARSE_FAILED' : 'INTERNAL_ERROR';
  let causes = method === 'network-json'
    ? ['File HAR tidak lengkap atau rusak.', 'Struktur response review berubah.', 'File bukan HAR Chrome Traveloka, Tiket, Agoda, Trip, atau Booking yang didukung.']
    : ['Koneksi atau halaman tidak merespons.', 'Struktur halaman berubah.', 'Akses situs membatasi browser atau selector tidak lagi cocok.'];
  if (/timeout|timed out|batas waktu/.test(text)) { code='PAGE_TIMEOUT'; causes=['Koneksi internet lambat atau terputus.','Server website terlalu lambat merespons.','Situs menahan atau membatasi request otomatis.']; }
  else if (/challenge|captcha|verifikasi manusia|bot|access.*restrict|menolak browser|blocked|forbidden|403/.test(text)) { code='ACCESS_BLOCKED'; causes=['Situs meminta verifikasi manusia.','Situs mendeteksi atau membatasi browser otomatis.','Sesi/cookie belum memenuhi persyaratan akses.']; }
  else if (/state pagination.*mundur|pagination.*reset|keadaan review yang sama|checkpoint.*posisi|resume.*posisi/.test(text)) { code='PAGINATION_STATE_RESET'; causes=['Komponen review situs kembali ke halaman/keadaan lama setelah navigasi.','SPA melakukan render ulang atau reset paginator secara asynchronous.','Posisi browser tidak lagi sama dengan checkpoint terakhir.']; }
  else if (/keadaan kosong|empty-state|panel review.*kosong/.test(text)) { code='PAGINATION_EMPTY_STATE'; causes=['Panel review sedang berada pada state kosong/transisi.','Response halaman berikutnya belum selesai dirender.','Situs mereset filter/paginator sementara setelah navigasi.']; }
  else if (/posisi browser.*checkpoint|posisi browser tidak dapat|pemulihan.*checkpoint|resume_position/.test(text)) { code='RESUME_POSITION_UNKNOWN'; causes=['Posisi tab aktif tidak dapat dicocokkan dengan checkpoint.','Paginator/DOM berubah setelah proses berhenti.','Buka kembali panel review yang sama lalu gunakan Coba Lagi.']; }
  else if (/extractor menghasilkan 0|dom memuat .* record tetapi/.test(text)) { code='DOM_EXTRACTION_EMPTY'; causes=['Container review masih ada tetapi node field tidak dapat dibaca.','DOM situs berubah setelah render ulang.','Selector field perlu diverifikasi ulang sebelum melanjutkan.']; }
  else if (/counter.*drift|batas langkah.*paginator/.test(text)) { code='PAGINATION_COUNTER_DRIFT'; causes=['Counter internal dan halaman situs tidak sinkron.','Posisi browser berubah saat retry atau render ulang.','Run dihentikan untuk mencegah status selesai yang keliru.']; }
  else if (/pagination|halaman.*sama|tidak dapat berpindah|tombol.*tidak ditemukan|cycle/.test(text)) { code='PAGINATION_FAILED'; causes=['Tombol halaman berikutnya berubah atau tidak ditemukan.','Halaman tidak benar-benar berubah setelah navigasi.','Situs menggunakan pola pagination berbeda dari konfigurasi proyek.']; }
  else if (/selector|elemen.*tidak ditemukan|container|field.*tidak/.test(text)) { code='DOM_STRUCTURE_CHANGED'; causes=['Struktur DOM website berubah.','Selector field/container tidak lagi cocok.','Halaman yang terbuka berbeda dari halaman saat field dipilih.']; }
  else if (/invalid json|json.*parse|unexpected token|response.*parse/.test(text)) { code='INVALID_JSON'; causes=['Isi file bukan JSON yang valid.','Response tersimpan tidak lengkap.','Format response berubah.']; }
  else if (/getreviews|internalreview|no.*review|tidak.*review|0 review/.test(text) && method === 'network-json') { code='NO_REVIEW_RESPONSE'; causes=['HAR tidak memuat response review yang didukung.','Pagination review belum dijalankan atau response body tidak tersimpan.','Ekspor ulang HAR dengan opsi Save all as HAR with content.']; }
  else if (/file.*tidak|read|enoent|tersedia/.test(text)) { code='FILE_READ_ERROR'; causes=['File dipindahkan atau dihapus setelah dipilih.','Aplikasi tidak dapat membaca lokasi file.','File sedang terkunci atau rusak.']; }
  return { code, stage: failureStageForCode(code, currentStage), causes };
}

function showAcquisitionFailureDialog({ message, stage, code, causes, details = null, collected = 0, runDir = '', method = resolvedAcquisitionMethod(), partial = false } = {}) {
  const dialog = $('acquisitionFailureDialog');
  const classified = classifyAcquisitionFailure(message, stage, method);
  const finalCode = code || classified.code;
  const finalStage = failureStageForCode(finalCode, stage || classified.stage);
  let finalCauses = Array.isArray(causes) && causes.length ? causes : classified.causes;
  const tripDomPaginationFailure = method === 'dom' && effectiveSiteProfile() === 'trip' && /^PAGINATION_/.test(String(finalCode || '').toUpperCase());
  if (tripDomPaginationFailure && String(finalCode || '').toUpperCase() === 'PAGINATION_FAILED') {
    finalCauses = [
      'Target halaman berikutnya belum muncul pada jendela paginator Trip atau belum dapat dibuktikan sebagai kontrol yang aman.',
      'Paginator Trip dapat menggeser rentang nomor halaman melalui kontrol ellipsis/window sebelum nomor target tersedia.',
      'Runner mempertahankan checkpoint dan menolak selector positional yang tidak dapat diverifikasi agar data halaman yang salah tidak ikut tersimpan.'
    ];
  }
  if (tripDomPaginationFailure) state.tripDomPaginationFailureCount = Number(state.tripDomPaginationFailureCount || 0) + 1;
  const recommendTripHar = tripDomPaginationFailure && state.tripDomPaginationFailureCount >= 2;
  if (!dialog?.showModal) return Promise.resolve('stop');
  $('failureDialogTitle').textContent = partial ? 'Pengambilan data berhenti sebelum selesai' : 'Pengambilan data mengalami kegagalan';
  $('failureDialogMethod').textContent = `${ACQUISITION_DEFS[method]?.label || method} · ${SITE_PROFILE_DEFS[effectiveSiteProfile()]?.label || effectiveSiteProfile()}`;
  $('failureDialogStage').textContent = FAILURE_STAGE_LABELS[finalStage] || FLOW_STAGE_META[finalStage]?.label || finalStage || 'Proses';
  $('failureDialogCode').textContent = finalCode;
  $('failureDialogCollected').textContent = `${Number(collected || 0).toLocaleString('id-ID')} record`;
  $('failureDialogMessage').textContent = String(message || 'Proses tidak dapat dilanjutkan.');
  $('failureDialogCauses').innerHTML = finalCauses.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const expectedPage = details?.expectedSitePage ?? details?.targetSitePage ?? details?.maxPages ?? null;
  const detectedPage = details?.detectedSitePage ?? details?.sitePage ?? details?.actualPage ?? null;
  const pageDetail = expectedPage != null || detectedPage != null
    ? ` Posisi situs${detectedPage != null ? ` terdeteksi di halaman ${detectedPage}` : ''}${expectedPage != null ? `; target/checkpoint ${expectedPage}` : ''}.` : '';
  $('failureDialogCheckpoint').textContent = runDir
    ? `Data yang sudah berhasil disimpan tetap aman pada checkpoint/riwayat.${pageDetail} “Coba Lagi” akan memverifikasi posisi browser dan memulihkannya sebelum ekstraksi dilanjutkan.`
    : method === 'network-json'
      ? 'File yang sudah dipilih tetap tersedia untuk dicoba lagi. Data run yang sempat tersimpan tidak dihapus.'
      : 'Jika belum ada checkpoint, “Coba Lagi” akan mengulangi tahap yang dapat dijalankan kembali.';
  const recommendation = $('failureDialogRecommendation');
  if (recommendation) {
    recommendation.classList.toggle('hidden', !recommendTripHar);
    recommendation.innerHTML = recommendTripHar
      ? `<b>Rekomendasi: gunakan HAR / Network untuk Trip multipage.</b><span>Pagination DOM Trip gagal ${Number(state.tripDomPaginationFailureCount).toLocaleString('id-ID')} kali pada sesi ini. Adapter <code>trip-getHotelCommentInfo</code> menggunakan pagination API yang deterministik; DOM tetap dapat dipakai untuk preview dan validasi manual.</span>`
      : '';
  }
  try { if (dialog.open) dialog.close(); } catch {}
  dialog.showModal();
  return new Promise(resolve => {
    const finish = action => {
      $('failureRetryBtn').onclick = null; $('failureStopBtn').onclick = null;
      try { dialog.close(); } catch {}
      appendProcessLog('error', action === 'retry' ? 'Pengguna memilih Coba Lagi.' : 'Pengguna memilih Hentikan Proses. Data yang sudah tersimpan dipertahankan.');
      resolve(action);
    };
    $('failureRetryBtn').onclick = () => finish('retry');
    $('failureStopBtn').onclick = () => finish('stop');
  });
}

function flowProgressUnit() {
  const method = resolvedAcquisitionMethod();
  const site = effectiveSiteProfile();
  if (method === 'network-json') return site === 'traveloka' ? 'Respons' : 'Halaman';
  return 'Halaman';
}

function renderFlowMonitor() {
  const flow=state.runtimeFlow;const network=resolvedAcquisitionMethod()==='network-json';const baseMeta=FLOW_STAGE_META[flow.stage]||{label:flow.stage||'Berjalan',color:'var(--accent)'};const meta=network&&flow.stage==='loading'?{...baseMeta,label:'Membaca HAR'}:network&&flow.stage==='extracting'?{...baseMeta,label:'Mengekstrak review'}:network&&flow.stage==='normalizing'?{...baseMeta,label:'Memvalidasi sumber'}:baseMeta;
  const panel=$('flowLivePanel');if(panel){panel.classList.toggle('running',Boolean(flow.running));panel.classList.toggle('error',flow.stage==='error');panel.classList.toggle('complete',flow.stage==='done');}
  const statusColor=flow.stage==='error'?'var(--danger)':(flow.running?'var(--success)':'var(--accent)');
  if($('flowLiveStageBadge')){$('flowLiveStageBadge').textContent=meta.label;$('flowLiveStageBadge').style.borderColor=statusColor;$('flowLiveStageBadge').style.color=statusColor;}
  if($('flowLiveMessage'))$('flowLiveMessage').textContent=flow.message||'Jalankan proyek untuk melihat setiap tahap bergerak pada peta.';
  const progressUnit = flowProgressUnit();
  if($('flowLivePageLabel')) $('flowLivePageLabel').textContent = progressUnit;
  if($('flowLivePage'))$('flowLivePage').textContent=flow.page?Number(flow.page).toLocaleString('id-ID'):'–';
  if($('flowLiveRows'))$('flowLiveRows').textContent=Number(flow.rows||0).toLocaleString('id-ID');
  if($('flowLiveDuplicates'))$('flowLiveDuplicates').textContent=Number(flow.duplicates||0).toLocaleString('id-ID');
  if($('flowLivePossible'))$('flowLivePossible').textContent=Number(flow.possibleDuplicates||0).toLocaleString('id-ID');
  const stageFraction={idle:0,starting:.05,loading:.13,'access-guard':.2,'access-required':.2,expanding:.3,extracting:.48,normalizing:.62,deduplicating:.76,checkpoint:.9,pagination:.94,'pagination-confirmed':.98,'pagination-recovery':.95,'pagination-recovered':.98,'pagination-end':.99,scrolling:.94,discovering:.82,crawling:.15,exporting:.96,done:1,partial:1,error:1}[flow.stage]??.5;
  const max=state.project.mode==='crawl'?Math.max(1,Number(state.project.crawl?.maxUrls||1)):state.project.mode==='multipage'?Math.max(1,Number(state.project.pagination?.maxPages||1)):1;
  const page=Math.max(1,Number(flow.page||1));const progress=flow.stage==='done'?100:Math.max(0,Math.min(100,((page-1+stageFraction)/max)*100));
  if($('flowLiveProgressBar'))$('flowLiveProgressBar').style.width=`${progress}%`;
  const tabDot=$('flowTabLiveDot');if(tabDot){tabDot.classList.toggle('running',Boolean(flow.running));tabDot.classList.toggle('error',flow.stage==='error');}
  const shortcut=$('openFlowMonitorBtn');if(shortcut)shortcut.classList.toggle('running',Boolean(flow.running));
  if($('flowShortcutText'))$('flowShortcutText').textContent=flow.started?`${meta.label}${flow.page?` · ${progressUnit.toLowerCase()} ${flow.page}`:''}`:'Belum ada proses aktif';
}

(async function init() {
  paths = await appApi.getPaths();
  try {
    const info = await appApi.getAppInfo();
    if (info?.name) {
      document.title = info.name;
      if ($('brandName')) $('brandName').textContent = info.name;
    }
    if ($('brandMeta')) $('brandMeta').textContent = `Ahmad Asyhari · v${info?.version || '1.1.6'}`;
    if ($('aboutVersion')) $('aboutVersion').textContent = `${info?.version || '1.1.6'}`;
  } catch {}
  try {
    state.browserProfile = await appApi.getBrowserProfile?.();
    renderBrowserProfileBadge();
  } catch {}
  browser.setAttribute('preload', `file://${paths.webviewPreload.replace(/\\/g, '/')}`);
  initBrowserTabs();
  syncViewScopedPanels();
  loadAppearance();
  wireEvents();
  restoreWorkspacePanelState();
  initFlowCanvas();
  renderFlowMonitor();
  renderProject();
  syncDataViewControls();
  switchWorkspaceView('browserView');
  appApi.onRunProgress(handleRunProgress);
  appApi.onMenuCommand(handleMenuCommand);
  renderHistoryWorkspace();
})()

function positionBrowserToolsPopover() {
  const trigger = $('browserToolsBtn');
  const popover = $('browserToolsPopover');
  const area = $('browserView');
  if (!trigger || !popover || !area || popover.classList.contains('hidden')) return;

  const triggerRect = trigger.getBoundingClientRect();
  const areaRect = area.getBoundingClientRect();
  const width = popover.offsetWidth || 272;
  const height = popover.offsetHeight || 120;
  const gutter = 8;

  // Keep the floating menu inside the center browser workspace. The toolbar itself
  // scrolls horizontally, so the menu must not participate in that overflow context.
  let left = triggerRect.right - areaRect.left - width;
  left = Math.max(gutter, Math.min(left, areaRect.width - width - gutter));

  let top = triggerRect.bottom - areaRect.top + 6;
  if (top + height > areaRect.height - gutter) {
    top = triggerRect.top - areaRect.top - height - 6;
  }
  top = Math.max(gutter, Math.min(top, areaRect.height - height - gutter));

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function setBrowserToolsPopover(open) {
  const trigger = $('browserToolsBtn');
  const popover = $('browserToolsPopover');
  if (!trigger || !popover) return;
  const next = Boolean(open);
  trigger.setAttribute('aria-expanded', String(next));
  popover.classList.toggle('hidden', !next);
  if (next) requestAnimationFrame(positionBrowserToolsPopover);
}

function toggleBrowserToolsPopover() {
  const trigger = $('browserToolsBtn');
  setBrowserToolsPopover(trigger?.getAttribute('aria-expanded') !== 'true');
}

function wireEvents() {
  document.addEventListener('click', event => {
    const menu = $('projectMenu');
    if (menu?.open && !menu.contains(event.target)) menu.open = false;
    const toolsButton = $('browserToolsBtn');
    const toolsPopover = $('browserToolsPopover');
    if (toolsButton?.getAttribute('aria-expanded') === 'true' && !toolsButton.contains(event.target) && !toolsPopover?.contains(event.target)) {
      setBrowserToolsPopover(false);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('browserToolsBtn')?.getAttribute('aria-expanded') === 'true') {
      setBrowserToolsPopover(false);
      $('browserToolsBtn')?.focus();
    }
  });
  $('browserToolsBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    toggleBrowserToolsPopover();
  });
  $('browserToolsPopover')?.addEventListener('click', event => event.stopPropagation());
  document.querySelector('.browser-toolbar')?.addEventListener('scroll', () => {
    if ($('browserToolsBtn')?.getAttribute('aria-expanded') === 'true') positionBrowserToolsPopover();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if ($('browserToolsBtn')?.getAttribute('aria-expanded') === 'true') positionBrowserToolsPopover();
  });
  $('goBtn')?.addEventListener('click', navigateFromInput);
  $('urlInput')?.addEventListener('keydown', event => { if (event.key === 'Enter') navigateFromInput(); });
  $('urlInput')?.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    try { $('urlInput').focus({ preventScroll: true }); } catch { $('urlInput').focus(); }
    const request = appApi.showUrlContextMenu?.();
    request?.catch?.(error => setStatus(`Menu edit URL tidak dapat dibuka: ${error.message}`));
  });
  $('backBtn')?.addEventListener('click', () => browser.canGoBack() && browser.goBack());
  $('forwardBtn')?.addEventListener('click', () => browser.canGoForward() && browser.goForward());
  $('reloadBtn')?.addEventListener('click', () => browser.reload());
  $('retryBrowserAccessBtn')?.addEventListener('click', () => {
    renderBrowserAccessNotice('checking');
    try { browser.reloadIgnoringCache(); } catch { browser.reload(); }
  });
  $('openSystemBrowserBtn')?.addEventListener('click', async () => {
    const target = currentBrowserUrl();
    try {
      await appApi.openExternalUrl(target);
      setStatus('Halaman dibuka di browser sistem. MyDataset tidak melewati pembatasan akses situs.');
    } catch (error) { setStatus(`Browser sistem tidak dapat dibuka: ${error.message}`); }
  });
  $('openChromeCurrentBtn')?.addEventListener('click', openCurrentPageInChrome);
  $('openChromeAccessBtn')?.addEventListener('click', openCurrentPageInChrome);
  $('browserZoomSelect')?.addEventListener('change', () => setBrowserZoom(Number($('browserZoomSelect').value), true));
  $('zoomOutBtn')?.addEventListener('click', () => stepBrowserZoom(-1));
  $('zoomInBtn')?.addEventListener('click', () => stepBrowserZoom(1));
  $('newBrowserTabBtn')?.addEventListener('click', () => createBrowserTab(DEFAULT_HOME_URL, { active: true, title: 'Google' }));
  $('closeBrowserTabBtn')?.addEventListener('click', () => closeBrowserTab());

  document.querySelectorAll('.workspace-tab').forEach(btn => btn.addEventListener('click', () => switchWorkspaceView(btn.dataset.view)));
  $('managePreparationBtn')?.addEventListener('click', () => switchWorkspaceView('browserView'));
  $('manageFlowBtn')?.addEventListener('click', () => switchWorkspaceView('flowView', { focusLive: state.running }));
  $('startAcquisitionBtn')?.addEventListener('click', startAcquisition);
  $('processDetailsBtn')?.addEventListener('click', () => openProcessDetails('dataView'));
  $('processDetailsFromFlowBtn')?.addEventListener('click', () => openProcessDetails('flowView'));
  $('processDetailsBackBtn')?.addEventListener('click', () => switchWorkspaceView(state.processDetailsReturnView || 'dataView'));
  $('duplicateListBtn')?.addEventListener('click', () => setDuplicateViewMode('list'));
  $('duplicateMapBtn')?.addEventListener('click', () => setDuplicateViewMode('map'));
  document.querySelectorAll('[data-duplicate-filter]').forEach(button => button.addEventListener('click', () => setDuplicateAuditFilter(button.dataset.duplicateFilter || 'all')));
  $('duplicateAuditSearch')?.addEventListener('input', () => { state.duplicateAuditSearch = String($('duplicateAuditSearch').value || '').trim().toLocaleLowerCase('id-ID'); refreshDuplicateAuditView(); });
  $('processLogSummaryBtn')?.addEventListener('click', () => setProcessLogMode('summary'));
  $('processLogTechnicalBtn')?.addEventListener('click', () => setProcessLogMode('technical'));
  window.addEventListener('mydataset:flow-action', event => {
    if (event?.detail?.action === 'duplicates-map') openPotentialDuplicateAudit();
  });
  $('projectMode')?.addEventListener('change', () => applyProjectMode($('projectMode').value, { userInitiated: true }));
  $('acquisitionMethod')?.addEventListener('change', async () => {
    const method = AcquisitionPolicy?.normalizedMethod($('acquisitionMethod').value || 'network-json') || 'network-json';
    const previousMethod = resolvedAcquisitionMethod();
    const previousAcquisition = { ...(state.project.acquisition || {}) };
    const previousPagination = { ...createDefaultProject().pagination, ...(state.project.pagination || {}) };
    state.project.acquisition = { ...previousAcquisition, method };
    state.project.pagination = previousPagination;

    if (method === 'network-json') {
      // Simpan preferensi DOM terakhir sebelum mode Network mengambil alih UI.
      // Nilai ini dipulihkan jika pengguna kembali ke DOM, sehingga project lama
      // tidak kehilangan batas/jeda/paginator yang memang sengaja disimpan.
      if (previousMethod === 'dom') {
        state.project.acquisition.lastDomScope = previousAcquisition.scope || 'multiple';
        state.project.acquisition.lastDomLimit = Math.max(1, Number(previousAcquisition.limit || previousPagination.maxPages || 5));
        state.project.pagination.lastDomMaxPages = previousPagination.maxPages ?? state.project.acquisition.lastDomLimit;
        state.project.pagination.lastDomDelayMs = Math.max(250, Number(previousPagination.delayMs || 3000));
        state.project.pagination.lastDomPaginationType = ['next','loadMore','scroll'].includes(previousPagination.type)
          ? previousPagination.type
          : (['next','loadMore','scroll'].includes(previousPagination.lastType) ? previousPagination.lastType : 'next');
      }
      state.project.acquisition.scope = 'all';
      const currentSite = AcquisitionPolicy?.normalizedSite(state.project.siteProfile || '', { url: state.project.startUrl || state.project.source?.sourceUrl || '' }) || '';
      const allowed = AcquisitionPolicy?.allowedSites('network-json') || ['traveloka','tiket','agoda','trip','booking'];
      if (!allowed.includes(currentSite)) state.project.siteProfile = 'auto';
      resetExtractionDesignForSourceChange();
      state.project.mode = 'quick';
      state.project.pagination.type = 'none';
    } else if (previousMethod === 'network-json') {
      await clearStagedNetworkImport({ silent: true });
      const hasSavedDomPreferences = Boolean(previousAcquisition.lastDomScope);
      if (hasSavedDomPreferences) {
        state.project.acquisition.scope = previousAcquisition.lastDomScope;
        state.project.acquisition.limit = Math.max(1, Number(previousAcquisition.lastDomLimit || previousAcquisition.limit || 5));
        state.project.pagination.maxPages = previousPagination.lastDomMaxPages ?? state.project.acquisition.limit;
        state.project.pagination.delayMs = Math.max(250, Number(previousPagination.lastDomDelayMs || previousPagination.delayMs || 3000));
        state.project.pagination.lastType = ['next','loadMore','scroll'].includes(previousPagination.lastDomPaginationType)
          ? previousPagination.lastDomPaginationType
          : (['next','loadMore','scroll'].includes(previousPagination.lastType) ? previousPagination.lastType : 'next');
      } else {
        // Default DOM baru: workflow multipage kecil untuk verifikasi awal.
        state.project.acquisition.scope = 'multiple';
        state.project.acquisition.limit = 5;
        state.project.pagination.maxPages = 5;
        state.project.pagination.delayMs = 3000;
        state.project.pagination.lastType = 'next';
      }
      const currentSite = AcquisitionPolicy?.normalizedSite(state.project.siteProfile || '', { url: state.project.startUrl || state.project.source?.sourceUrl || '' }) || '';
      const allowedDom = AcquisitionPolicy?.allowedSites('dom') || ['tiket','agoda','trip'];
      if (!allowedDom.includes(currentSite)) {
        state.project.siteProfile = 'auto';
        state.project.startUrl = '';
        state.project.source = { ...createDefaultProject().source, objectName: unifiedProjectIdentity(), detectedBy: state.project.nameAuto === false ? 'manual' : 'project' };
      }
    } else {
      state.project.acquisition.scope = state.project.acquisition.scope || 'multiple';
    }
    syncLegacyModeFromAcquisition(); renderSiteProfile(); renderAcquisition(); scheduleAutosave(); renderFlowCanvas();
  });
  $('acquisitionScope')?.addEventListener('change', () => { state.project.acquisition = state.project.acquisition || {}; state.project.acquisition.scope = $('acquisitionScope').value || 'current'; syncLegacyModeFromAcquisition(); renderAcquisition(); scheduleAutosave(); renderFlowCanvas(); });
  $('acquisitionLimit')?.addEventListener('change', () => { state.project.acquisition = state.project.acquisition || {}; state.project.acquisition.limit = Math.max(1, Number($('acquisitionLimit').value) || 5); syncLegacyModeFromAcquisition(); renderAcquisition(); scheduleAutosave(); renderFlowCanvas(); });
  $('dataTarget')?.addEventListener('change', () => { state.project.dataTarget = $('dataTarget').value || 'reviews'; scheduleAutosave(); });
  $('toggleLeftPanelBtn')?.addEventListener('click', () => toggleWorkspacePanel('left'));
  $('toggleRightPanelBtn')?.addEventListener('click', () => toggleWorkspacePanel('right'));
  $('siteProfile')?.addEventListener('change', async () => {
    const selected = $('siteProfile').value || 'auto';
    if (selected === 'auto') return;
    const method = resolvedAcquisitionMethod();
    if (!(AcquisitionPolicy?.isCombinationAllowed(method, selected) ?? (method === 'network-json' && ['traveloka','tiket','agoda','trip','booking'].includes(selected)))) {
      renderSiteProfile();
      return setStatus(method === 'dom' ? 'DOM mendukung Tiket, Agoda, dan Trip.' : 'HAR / Network mendukung Traveloka, Tiket, Agoda, Trip, dan Booking.');
    }
    const previous = state.project.siteProfile || 'auto';
    state.project.siteProfile = selected;
    if (previous !== selected) resetExtractionDesignForSourceChange();
    renderSiteProfile(); renderAcquisition(); scheduleAutosave(); updateFieldPreview(); renderFlowCanvas();
  });
  ['crawlScope','crawlDepth','crawlMaxUrls','crawlInclude','crawlExclude'].forEach(id => $(id)?.addEventListener('change', () => { syncProjectInputs(); renderProjectMode(); scheduleAutosave(); renderFlowCanvas(); }));
  $('crawlInclude')?.addEventListener('input', () => { syncProjectInputs(); scheduleAutosave(); });
  $('crawlExclude')?.addEventListener('input', () => { syncProjectInputs(); scheduleAutosave(); });

  $('pickItemBtn')?.addEventListener('click', () => startPick('item'));
  $('pickFieldBtn')?.addEventListener('click', () => startPick('field'));
  $('pickPaginationBtn')?.addEventListener('click', () => startPick('pagination'));
  $('previewBtn')?.addEventListener('click', previewCurrentPage);
  $('dataPreviewBtn')?.addEventListener('click', previewCurrentPage);
  $('dataExportBtn')?.addEventListener('click', () => exportData('csv', 'canonical', 'clean'));
  $('dataExportStandardBtn')?.addEventListener('click', () => exportData('csv', 'native', 'raw'));
  $('dataExportXlsxBtn')?.addEventListener('click', () => exportData('xlsx', 'canonical', 'clean'));
  $('toggleColumnsBtn')?.addEventListener('click', () => setDataDatasetMode(state.activeDataset === 'clean' ? 'raw' : 'clean'));
  $('dataExportBundleBtn')?.addEventListener('click', exportAllDatasets);
  $('useActivePageBtn')?.addEventListener('click', () => refreshSourceIdentity({ claimPage: true, userInitiated: true }));
  $('refreshSourceBtn')?.addEventListener('click', () => refreshSourceIdentity({ claimPage: true, userInitiated: true }));
  $('networkSourceUrl')?.addEventListener('input', () => {
    syncNetworkSourceUrlFromInput({ validate: false });
    scheduleAutosave();
  });
  $('networkSourceUrl')?.addEventListener('change', () => {
    syncNetworkSourceUrlFromInput({ validate: true, announce: true });
    scheduleAutosave();
    renderFlowCanvas();
  });

  $('paginationType')?.addEventListener('change', () => {
    state.project.pagination.type = $('paginationType').value;
    if (state.project.pagination.type !== 'none') state.project.pagination.lastType = state.project.pagination.type;
    if (!['next', 'loadMore'].includes(state.project.pagination.type)) {
      state.project.pagination.selector = '';
      state.project.pagination.selectors = [];
      state.project.pagination.meta = null;
    }
    if (state.project.pagination.type !== 'none' && state.project.mode !== 'multipage') {
      applyProjectMode('multipage', { userInitiated: true });
      return;
    }
    renderPagination(); renderProjectMode(); scheduleAutosave(); renderFlowCanvas();
  });
  ['maxPages', 'delayMs', 'timeoutMs', 'retryCount'].forEach(id => $(id).addEventListener('change', () => { syncProjectInputs(); renderProjectMode(); scheduleAutosave(); renderFlowCanvas(); }));
  $('projectName')?.addEventListener('input', () => {
    // Do not rewrite the input value while the user is typing. Rewriting a trimmed
    // value here removed the trailing space immediately, making multi-word titles
    // impossible to enter naturally.
    setUnifiedProjectIdentity($('projectName').value, { manual: true, detectedBy: 'manual', syncInput: false });
    renderSourceIdentity();
    scheduleAutosave();
  });
  $('projectName')?.addEventListener('blur', () => {
    // Normalize repeated/leading/trailing whitespace only after editing is finished.
    setUnifiedProjectIdentity($('projectName').value, { manual: true, detectedBy: 'manual', syncInput: true });
    renderSourceIdentity();
    scheduleAutosave();
  });

  $('saveAsBtn')?.addEventListener('click', () => { closeProjectMenu(); saveProject(true); });
  $('resetBtn')?.addEventListener('click', () => { closeProjectMenu(); openResetDialog('results'); });
  $('newProjectBtn')?.addEventListener('click', () => { closeProjectMenu(); openResetDialog('project'); });
  $('openBtn')?.addEventListener('click', () => { closeProjectMenu(); openProject(); });
  $('topWorkspaceBtn')?.addEventListener('click', () => { closeProjectMenu(); appApi.openWorkspace(state.project.name); });
  $('pauseBtn')?.addEventListener('click', pauseRun);
  $('exportCsvBtn')?.addEventListener('click', () => exportData('csv', 'canonical', 'clean'));
  $('exportStandardCsvBtn')?.addEventListener('click', () => exportData('csv', 'native', 'raw'));
  $('exportStandardXlsxBtn')?.addEventListener('click', () => exportData('xlsx', 'canonical', 'clean'));
  $('exportJsonBtn')?.addEventListener('click', () => exportData('json', 'canonical', 'clean'));
  $('exportLogBtn')?.addEventListener('click', exportLog);
  $('exportBundleBtn')?.addEventListener('click', exportAllDatasets);
  $('openResultFolderBtn')?.addEventListener('click', openResultLocation);
  $('workspaceBtn')?.addEventListener('click', () => appApi.openWorkspace(state.project.name));
  $('refreshRunsBtn')?.addEventListener('click', showRunsDialog);
  $('openFlowMonitorBtn')?.addEventListener('click', () => switchWorkspaceView('flowView',{focusLive:true}));
  $('importNetworkJsonBtn')?.addEventListener('click', () => { setBrowserToolsPopover(false); focusNetworkJsonUpload(); });
  $('importBlockedNetworkJsonBtn')?.addEventListener('click', focusNetworkJsonUpload);
  $('dataImportNetworkJsonBtn')?.addEventListener('click', focusNetworkJsonUpload);
  $('stageNetworkFilesBtn')?.addEventListener('click', stageNetworkJsonFiles);
  $('harInspectorChooseBtn')?.addEventListener('click', stageNetworkJsonFiles);
  $('clearNetworkStageBtn')?.addEventListener('click', () => clearStagedNetworkImport());
  $('processNetworkFilesBtn')?.addEventListener('click', processStagedNetworkJson);
  $('resultDataTab')?.addEventListener('click', () => selectResultPane('data'));
  $('resultLogTab')?.addEventListener('click', () => selectResultPane('log'));
  $('closeRunsBtn')?.addEventListener('click', () => $('runsDialog').close());

  $('containerDialog')?.addEventListener('close', () => {
    const accepted = $('containerDialog').returnValue === 'default';
    if (accepted) applySelectedContainer();
    clearBrowserHighlights();
    renderBrowserMarkers();
  });

  $('fieldExtractInput')?.addEventListener('change', () => { updateFieldExtractionControls(); updateFieldPreview(); });
  $('fieldAttributeInput')?.addEventListener('input', () => updateFieldPreview());
  $('fieldJsonPathInput')?.addEventListener('input', () => updateFieldPreview());
  $('fieldNameInput')?.addEventListener('input', () => { clearTimeout(state.fieldQualityTimer); state.fieldQualityTimer = setTimeout(updateFieldPreview, 160); });
  $('fieldSelectorInput')?.addEventListener('input', () => { clearTimeout(state.fieldQualityTimer); state.fieldQualityTimer = setTimeout(updateFieldPreview, 220); });
  $('fieldDialog')?.addEventListener('close', async () => {
    const accepted = $('fieldDialog').returnValue === 'default' && state.lastPicked;
    // Invalidate every async preview that belongs to this dialog before touching the
    // browser. Without this guard, a late preview could repaint blue candidate outlines
    // after Batal / Esc / full reset had already cleared them.
    state.fieldDialogRevision += 1;
    clearTimeout(state.fieldQualityTimer);
    state.fieldQualityTimer = null;
    if (accepted) addFieldFromDialog();
    state.lastPicked = null; state.pendingInferredContainer = null; state.fieldCandidateSelectors = []; state.fieldTargetMeta = null; state.fieldExpectedSignature = ''; state.fieldInitialValidation = null; state.fieldPreviewFallbackUsed = false; state.fieldPreviewError = '';
    await clearBrowserHighlights();
    renderBrowserMarkers();
  });

  $('paginationDialog')?.addEventListener('close', () => {
    const accepted = $('paginationDialog').returnValue === 'default' && state.pendingPagination;
    if (accepted) applyPendingPagination();
    state.pendingPagination = null; clearBrowserHighlights();
  });
  document.querySelectorAll('input[name="resetScope"]').forEach(input => input.addEventListener('change', updateResetDialogState));
  $('resetDialog')?.addEventListener('close', async () => { if ($('resetDialog').returnValue === 'confirm') await applyResetSelection(); });

  $('flowZoomOutBtn')?.addEventListener('click', () => state.flowController?.zoomOut());
  $('flowZoomInBtn')?.addEventListener('click', () => state.flowController?.zoomIn());
  $('flowFollowBtn')?.addEventListener('click', () => state.flowController?.setViewMode?.('focus'));
  $('flowOverviewBtn')?.addEventListener('click', () => state.flowController?.setViewMode?.('overview'));
  $('flowFitBtn')?.addEventListener('click', () => state.flowController?.fit());
  $('flowResetLayoutBtn')?.addEventListener('click', () => state.flowController?.resetLayout());
  $('flowDetailBtn')?.addEventListener('click', () => { const on=$('flowDetailBtn').dataset.on!=='true'; $('flowDetailBtn').dataset.on=String(on); $('flowDetailBtn').classList.toggle('active',on); state.flowController?.setTechnical(on); });
  $('flowInspectorClose')?.addEventListener('click', () => $('flowInspector').classList.add('hidden'));
  $('historyRefreshBtn')?.addEventListener('click', renderHistoryWorkspace);
  $('historyClearBtn')?.addEventListener('click', clearHistoryWorkspace);
  $('historySessionsBtn')?.addEventListener('click', () => setHistoryMode('sessions'));
  $('historyCombinedBtn')?.addEventListener('click', () => setHistoryMode('combined'));
  $('combineSessionsBtn')?.addEventListener('click', combineSelectedSessions);
  $('dataSourceBtn')?.addEventListener('click', openCurrentDataSource);
  $('dataFolderBtn')?.addEventListener('click', openCurrentDataFolder);

  $('applyAppearanceBtn')?.addEventListener('click', () => { saveAppearanceFromDialog(); $('appearanceDialog').close(); });
  $('aboutCloseBtn')?.addEventListener('click', () => $('aboutDialog').close());
  $('guideCloseBtn')?.addEventListener('click', () => $('guideDialog')?.close());
  $('guideCloseTopBtn')?.addEventListener('click', () => $('guideDialog')?.close());
  $('flowGuideCloseBtn')?.addEventListener('click', () => $('flowGuideDialog')?.close());
  $('flowGuideCloseTopBtn')?.addEventListener('click', () => $('flowGuideDialog')?.close());
  document.querySelectorAll('.guide-card').forEach(card => {
    const buttons = [...card.querySelectorAll('.guide-nav [data-guide-target]')];
    buttons.forEach(btn => btn.addEventListener('click', () => {
      buttons.forEach(item => item.classList.toggle('active', item === btn));
      const target = card.querySelector(`#${btn.dataset.guideTarget}`);
      target?.scrollIntoView({behavior:'smooth',block:'start'});
    }));
  });
  $('dataCompactModeBtn')?.addEventListener('click', () => setDataDatasetMode('clean'));
  $('dataFullModeBtn')?.addEventListener('click', () => setDataDatasetMode('raw'));
  $('dataDuplicateModeBtn')?.addEventListener('click', () => setDataDatasetMode('duplicates'));
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => { if(state.appearance.theme==='system') applyAppearance(); });
}

function clampBrowserZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(50, Math.min(200, Math.round(n)));
}

function nearestZoomPreset(value) {
  const current = clampBrowserZoom(value);
  return BROWSER_ZOOM_PRESETS.reduce((best, item) => Math.abs(item - current) < Math.abs(best - current) ? item : best, 100);
}

function applyBrowserZoom() {
  const percent = clampBrowserZoom(state.project.settings?.browserZoomPercent ?? 100);
  const select = $('browserZoomSelect');
  if (select) select.value = String(BROWSER_ZOOM_PRESETS.includes(percent) ? percent : nearestZoomPreset(percent));
  try {
    if (typeof browser.setZoomFactor === 'function') browser.setZoomFactor(percent / 100);
  } catch (error) {
    console.warn('Browser zoom belum dapat diterapkan:', error?.message || error);
  }
}

function setBrowserZoom(percent, persist = false) {
  const normalized = nearestZoomPreset(percent);
  state.project.settings = state.project.settings || {};
  state.project.settings.browserZoomPercent = normalized;
  $('browserZoomSelect').value = String(normalized);
  try {
    if (typeof browser.setZoomFactor === 'function') browser.setZoomFactor(normalized / 100);
  } catch (error) {
    setStatus(`DPI/Zoom belum dapat diterapkan: ${error.message}`);
    return;
  }
  if (persist) {
    scheduleAutosave();
    setStatus(`DPI/Zoom halaman diatur ke ${normalized}%.`);
  }
}

function stepBrowserZoom(direction) {
  const current = nearestZoomPreset(state.project.settings?.browserZoomPercent ?? 100);
  let index = BROWSER_ZOOM_PRESETS.indexOf(current);
  if (index < 0) index = BROWSER_ZOOM_PRESETS.indexOf(100);
  index = Math.max(0, Math.min(BROWSER_ZOOM_PRESETS.length - 1, index + direction));
  setBrowserZoom(BROWSER_ZOOM_PRESETS[index], true);
}

function humanRunStatus(status) {
  const map = {
    created: 'Siap', running: 'Berjalan', resuming: 'Melanjutkan',
    paused: 'Dijeda', interrupted: 'Terputus', stopped: 'Dihentikan / Parsial',
    failed: 'Gagal', abandoned: 'Ditinggalkan', completed: 'Selesai', completed_partial: 'Selesai — HAR parsial', completed_source_limit: 'Selesai pada batas sumber', completed_step_limit: 'Selesai sesuai batas langkah'
  };
  return map[status] || status || 'Idle';
}

function runAcquisitionLabel(run = {}) {
  const method = AcquisitionPolicy?.normalizedMethod(run.acquisitionMethod || run.acquisition?.method || (run.ingestionMode === 'network-json' ? 'network-json' : 'dom')) || 'dom';
  return AcquisitionPolicy?.labelForMethod(method) || (method === 'network-json' ? 'HAR / Network' : 'Halaman Web / DOM');
}

function runSiteLabel(run = {}) {
  const site = AcquisitionPolicy?.normalizedSite(run.siteProfile || '', { url: run.sourceUrl || run.currentUrl || '' }) || '';
  return AcquisitionPolicy?.labelForSite(site) || run.siteName || 'Website';
}

function chooseRecoverableRun(runs) {
  const recoverable = new Set(['paused', 'interrupted', 'failed']);
  const sorted = [...(Array.isArray(runs) ? runs : [])].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const latestByProject = new Map();
  for (const run of sorted) {
    const key = String(run.projectSlug || run.projectName || 'project').trim().toLowerCase();
    if (!latestByProject.has(key)) latestByProject.set(key, run);
  }
  return [...latestByProject.values()]
    .filter(run => recoverable.has(run.status))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

async function loadRecoveryState() {
  const recovery = await appApi.getRecovery();
  const autosave = recovery?.autosave;
  const runs = Array.isArray(recovery?.runs) ? recovery.runs : [];
  state.recoverableRun = chooseRecoverableRun(runs);
  renderRecoveryCard();

  if (autosave?.project && isMeaningfulProject(autosave.project)) {
    state.pendingAutosave = autosave;
    $('autosaveRecoveryText').textContent = `${autosave.project.name || 'Proyek'} · autosave ${formatDate(autosave.savedAt)}`;
    $('recoveryDialog').showModal();
  }
}

function isMeaningfulProject(project) {
  return Boolean(project.startUrl || project.itemSelector || (project.fields && project.fields.length) || project.name !== 'Proyek Baru');
}

function restoreAutosave(autosave) {
  state.project = normalizeProject(autosave.project);
  state.projectPath = autosave.projectPath || null;
  state.showingPreview = false;
  state.previewRows = [];
  renderProject();
  loadProjectPage(state.project);
  const migration = state.project.migrationNotice;
  if (migration) {
    state.project.migrationNotice = '';
    setStatus(`Autosave dipulihkan dan diperbarui: ${migration}`);
  } else setStatus(`Autosave dipulihkan dari ${formatDate(autosave.savedAt)}.`);
  $('autosaveState').textContent = 'Autosave dipulihkan';
}

// v0.89: wizard acquisition lama (auto/snapshot/site-first) dihapus.
// Persiapan sekarang menjadi satu-satunya source of truth untuk Metode → Website.

function navigateFromInput() {
  let url = $('urlInput').value.trim();
  if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  navigate(url, { updateStartUrl: true });
}

function navigate(url, { updateStartUrl = true } = {}) {
  state.browserSourceClaimSuspended = false;
  stopPick();
  clearBrowserHighlights();
  if (updateStartUrl) {
    state.project.startUrl = url;
    state.project.source = { ...(state.project.source || {}), actualUrl: url, importedSnapshot: false };
    scheduleAutosave();
  }
  $('urlInput').value = url;
  updateBrowserTab(state.activeBrowserTabId, { url, title: browserTitleFromUrl(url) });
  startBrowserLoadProgress(state.activeBrowserTabId, { label: 'Membuka halaman…', start: 8 });
  try { browser.src = url; } catch {}
  $('browserEmpty').classList.add('hidden');
  updateSiteProfileFromUrl({ silent: true });
}

function loadProjectPage(project=state.project) {
  const source=project?.source||{};
  const snapshotUrl=source.importedSnapshot&&/^file:\/\//i.test(String(source.actualUrl||''))?String(source.actualUrl):'';
  if(snapshotUrl){
    stopPick();clearBrowserHighlights();
    updateBrowserTab(state.activeBrowserTabId, { url: snapshotUrl, title: browserTitleFromUrl(project.startUrl || source.sourceUrl || snapshotUrl) });
    startBrowserLoadProgress(state.activeBrowserTabId, { label: 'Memuat snapshot…', start: 8 });
    try { browser.src=snapshotUrl; } catch {}
    $('urlInput').value=project.startUrl||source.sourceUrl||'';
    $('browserEmpty').classList.add('hidden');
    updateSiteProfileFromUrl({ silent: true });
    return;
  }
  if(project?.startUrl)navigate(project.startUrl,{updateStartUrl:false});
}

function closeProjectMenu() {
  if ($('projectMenu')) $('projectMenu').open = false;
}

function activePageDisplayLabel(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'file:') return 'Snapshot lokal';
    return parsed.hostname.replace(/^www\./i, '') || raw;
  } catch { return raw; }
}

function renderActivePageSourceStatus(url = '') {
  const status = $('activePageSourceStatus');
  if (!status) return;
  const active = String(url || state.project.startUrl || '').trim();
  if (!active) {
    status.textContent = 'Gunakan halaman browser yang sedang terbuka sebagai sumber proyek.';
    status.classList.remove('is-set');
    return;
  }
  status.textContent = `Sumber halaman: ${activePageDisplayLabel(active)}`;
  status.title = active;
  status.classList.add('is-set');
}

async function collectSourceSignals() {
  return browser.executeJavaScript(`(() => {
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
    const canonicalUrl=meta('meta[name="petikdata-source-url"]')||meta('link[rel="canonical"]','href')||meta('meta[property="og:url"]');
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
      metaNames:[meta('meta[property="og:title"]'),meta('meta[name="twitter:title"]'),meta('meta[itemprop="name"]')].filter(Boolean),
      headings:[...document.querySelectorAll('h1,h2,[data-testid*="hotel-name" i],[data-testid*="property-name" i]')]
        .map(node=>(node.textContent||'').trim()).filter(Boolean).slice(0,15)
    };
  })()`, true);
}

async function refreshSourceIdentity({ claimPage = false, silent = false, userInitiated = false } = {}) {
  if (userInitiated) state.browserSourceClaimSuspended = false;
  if (claimPage && state.browserSourceClaimSuspended && !userInitiated) {
    renderActivePageSourceStatus('');
    renderSourceIdentity();
    return null;
  }
  let currentUrl = '';
  try { currentUrl = browser.getURL?.() || ''; } catch {}
  currentUrl = currentUrl || $('urlInput')?.value?.trim() || '';
  if (!/^(?:https?:|file:)/i.test(currentUrl) || currentUrl === 'about:blank') {
    if (!silent) setStatus('Buka halaman terlebih dahulu, lalu gunakan halaman aktif.');
    renderActivePageSourceStatus('');
    renderSourceIdentity();
    return null;
  }

  const detectedSite = detectSiteProfileFromUrl(currentUrl);
  if (claimPage && detectedSite === 'traveloka' && resolvedAcquisitionMethod() === 'dom') {
    state.project.acquisition = { ...(state.project.acquisition || {}), method: 'network-json', scope: 'all' };
    state.project.siteProfile = 'traveloka';
    state.project.startUrl = '';
    renderAcquisition(); renderSiteProfile(); renderFlowCanvas(); scheduleAutosave();
    if (!silent) setStatus('Traveloka menggunakan HAR / Network.');
    return null;
  }
  if (claimPage && ['tiket','agoda','trip'].includes(detectedSite) && resolvedAcquisitionMethod() === 'dom') {
    state.project.siteProfile = detectedSite;
    renderSiteProfile();
  }

  // "Gunakan Halaman Aktif" harus tetap bekerja meskipun metadata halaman tidak dapat
  // dibaca atau adapter situs belum mengenali halaman tersebut.
  if (claimPage) {
    const preservedIdentity = state.project.nameAuto === false ? unifiedProjectIdentity() : '';
    const previousSource = state.project.source || {};
    const fallbackSiteName = activePageDisplayLabel(currentUrl);
    state.project.startUrl = currentUrl;
    state.project.source = {
      ...createDefaultProject().source,
      ...previousSource,
      actualUrl: currentUrl,
      sourceUrl: currentUrl,
      canonicalUrl: previousSource.canonicalUrl || currentUrl,
      siteName: previousSource.siteName || fallbackSiteName,
      detectedBy: preservedIdentity ? 'manual' : (previousSource.detectedBy || 'page')
    };
    if (preservedIdentity) {
      state.project.source.objectName = preservedIdentity;
      state.project.reviewSubject = preservedIdentity;
    }
    if ($('urlInput')) $('urlInput').value = currentUrl;
    if (isNetworkJsonSourceMode() && $('networkSourceUrl')) $('networkSourceUrl').value = currentUrl;
    renderNetworkSourceUrlField();
    renderActivePageSourceStatus(currentUrl);
    renderSourceIdentity();
    scheduleAutosave();
  }

  const card = $('sourceIdentityCard');
  card?.classList.add('is-detecting');
  if ($('sourceIdentityStatus')) $('sourceIdentityStatus').textContent = 'Membaca halaman…';
  try {
    const signals = await collectSourceSignals();
    let context = null;
    try {
      context = await appApi.identifySource({ ...(signals || {}), url: signals?.url || currentUrl });
    } catch {
      context = null;
    }

    const manualIdentity = state.project.nameAuto === false ? unifiedProjectIdentity() : '';
    const activeUrl = context?.sourceUrl || context?.actualUrl || signals?.url || currentUrl;
    const fallbackSiteName = activePageDisplayLabel(activeUrl);
    state.project.source = {
      ...createDefaultProject().source,
      ...(state.project.source || {}),
      ...(context || {}),
      actualUrl: context?.actualUrl || signals?.url || currentUrl,
      sourceUrl: context?.sourceUrl || activeUrl,
      canonicalUrl: context?.canonicalUrl || signals?.canonicalUrl || activeUrl,
      siteName: context?.siteName || state.project.source?.siteName || fallbackSiteName
    };

    if (manualIdentity) {
      state.project.source.objectName = manualIdentity;
      state.project.source.detectedBy = 'manual';
      state.project.reviewSubject = manualIdentity;
    } else if (context?.objectName) {
      setUnifiedProjectIdentity(context.objectName, { manual: false, detectedBy: context.detectedBy || 'page' });
    }

    if (claimPage && activeUrl) {
      state.project.startUrl = activeUrl;
      if ($('urlInput')) $('urlInput').value = activeUrl;
      if (isNetworkJsonSourceMode() && $('networkSourceUrl')) $('networkSourceUrl').value = activeUrl;
      renderNetworkSourceUrlField();
      renderActivePageSourceStatus(activeUrl);
    }
    renderSourceIdentity();
    scheduleAutosave();
    if (!silent) {
      setStatus(context?.objectName
        ? `Halaman aktif ditetapkan untuk “${context.objectName}”. URL run dan identitas ekspor sudah diselaraskan.`
        : `Halaman aktif sudah digunakan sebagai sumber: ${fallbackSiteName}.`);
    }
    return context || { sourceUrl: activeUrl, actualUrl: activeUrl, siteName: fallbackSiteName };
  } catch (error) {
    // Claim halaman tidak dibatalkan hanya karena pemeriksaan metadata gagal.
    if ($('sourceIdentityStatus')) $('sourceIdentityStatus').textContent = claimPage ? 'URL aktif digunakan' : 'Deteksi gagal';
    renderSourceIdentity();
    renderActivePageSourceStatus(claimPage ? currentUrl : '');
    if (!silent) {
      setStatus(claimPage
        ? `Halaman aktif digunakan sebagai sumber. Metadata tambahan tidak dapat dibaca: ${error.message}`
        : `Identitas halaman tidak dapat dibaca: ${error.message}`);
    }
    return claimPage ? { sourceUrl: currentUrl, actualUrl: currentUrl, siteName: activePageDisplayLabel(currentUrl) } : null;
  } finally {
    card?.classList.remove('is-detecting');
  }
}

function renderSourceIdentity() {
  const source = state.project.source || {};
  const card = $('sourceIdentityCard');
  if (!card) return;
  const identityName = unifiedProjectIdentity();
  const hasObject = Boolean(identityName || source.objectName);
  const methodLabels = {
    'structured-data': 'metadata terstruktur', url: 'identitas URL', 'page-metadata': 'metadata halaman',
    heading: 'judul halaman', title: 'judul tab', project: 'proyek', manual: 'manual', 'network-import': 'impor network', 'network-import+url': 'network + URL', unknown: 'belum dideteksi'
  };
  card.classList.toggle('is-empty', !hasObject);
  $('sourceObjectName').textContent = identityName || source.objectName || 'Objek belum dikenali';
  const expectedSite = effectiveSiteProfile();
  const sourceCandidate = String(source.sourceUrl || source.actualUrl || '');
  const candidateSite = /^https?:\/\//i.test(sourceCandidate) ? detectSiteProfileFromUrl(sourceCandidate) : '';
  const safeSourceUrl = /^https?:\/\//i.test(sourceCandidate) && (expectedSite === 'generic' || expectedSite === 'auto' || candidateSite === expectedSite) ? sourceCandidate : '';
  $('sourceSiteName').textContent = hasObject
    ? (source.siteName || SITE_PROFILE_DEFS[expectedSite]?.label || 'Situs')
    : 'Buka halaman atau pilih file sumber.';
  $('sourceIdentityStatus').textContent = methodLabels[source.detectedBy] || methodLabels.unknown;
}

async function startPick(target) {
  if (!browser.src) return setStatus('Buka sebuah halaman terlebih dahulu.');
  if (!isNetworkJsonSourceMode() && effectiveSiteProfile() === 'generic') {
    return setStatus('Website ini belum didukung untuk pemilihan field visual. MyDataset saat ini difokuskan pada Tiket, Agoda, Traveloka, Trip, dan Booking.');
  }
  if (!window.CrawlPagePicker) return setStatus('Komponen picker tidak termuat. Muat ulang MyDataset lalu coba lagi.');
  if (target === 'pagination' && state.project.mode !== 'multipage') applyProjectMode('multipage');

  // Cancel a previous picker before installing a new overlay.
  if (state.pickTarget) stopPick();
  clearBrowserHighlights();
  state.pickTarget = target;
  const session = ++state.pickSession;
  $('modePill').textContent = target === 'item' ? 'Atur batas record' : target === 'field' ? 'Pilih data' : 'Pilih navigasi';
  $('modePill').classList.add('selecting');
  setStatus(target === 'field' ? 'Klik data yang ingin diambil. MyDataset akan mencari batas satu record secara otomatis…' : 'MyDataset sedang memasang lapisan pemilih di atas halaman…');

  try {
    const result = await browser.executeJavaScript(window.CrawlPagePicker.buildPickScript(target, target === 'field' ? state.project.itemSelector : ''), true);
    if (session !== state.pickSession || state.pickTarget !== target) return;
    if (result?.cancelled) {
      stopPick({ cancelOverlay: false });
      setStatus('Pemilihan dibatalkan.');
      return;
    }
    if (!result?.selector) throw new Error('Elemen tidak dapat dibaca dari halaman.');
    await handlePickedElement(result);
  } catch (error) {
    if (session !== state.pickSession) return;
    state.pickTarget = null;
    $('modePill').textContent = 'Mode Jelajah';
    $('modePill').classList.remove('selecting');
    setStatus(`Picker gagal dipasang: ${error?.message || error}. Coba muat ulang halaman lalu ulangi pemilihan.`);
  }
}

function stopPick({ cancelOverlay = true } = {}) {
  state.pickTarget = null;
  state.pickSession += 1;
  if (cancelOverlay && window.CrawlPagePicker) {
    try { browser.executeJavaScript(window.CrawlPagePicker.buildCancelScript(), true).catch(() => {}); } catch {}
  }
  // Also turn off the old preload picker if an older page still has it active.
  try { browser.send('host-message', { type: 'selection-mode', enabled: false }); } catch {}
  $('modePill').textContent = 'Mode Jelajah';
  $('modePill').classList.remove('selecting');
}

function clearBrowserHighlights() {
  const revision = ++state.transientVisualRevision;
  if (window.CrawlPagePicker) {
    try {
      return browser.executeJavaScript(window.CrawlPagePicker.buildHighlightScript({ type: 'clear', revision }), true)
        .catch(() => { try { browser.send('host-message', { type: 'clear-highlights' }); } catch {} });
    } catch {}
  }
  try { browser.send('host-message', { type: 'clear-highlights' }); } catch {}
  return Promise.resolve(0);
}

async function clearAllBrowserVisuals() {
  // Any in-flight field preview or highlight belongs to the old visual session from
  // this point forward. Invalidate it before asking the page to clean itself.
  state.fieldDialogRevision += 1;
  clearTimeout(state.fieldQualityTimer);
  state.fieldQualityTimer = null;
  const transientRevision = ++state.transientVisualRevision;
  state.browserMarkerRevision += 1;
  const revision = state.browserMarkerRevision;
  let cleared = false;
  if (window.CrawlPagePicker?.buildClearVisualsScript) {
    try {
      await browser.executeJavaScript(window.CrawlPagePicker.buildClearVisualsScript({ revision, transientRevision }), true);
      cleared = true;
    } catch {}
  }
  // Preload v0.12-v0.22 maintained a second highlight store. Always clear it too so
  // projects upgraded in-place cannot leave outlines behind after a full reset.
  try { browser.send('host-message', { type: 'selection-mode', enabled: false }); } catch {}
  try { browser.send('host-message', { type: 'clear-highlights' }); } catch {}
  return cleared;
}

function highlightInBrowser(payload) {
  const revision = ++state.transientVisualRevision;
  const markedPayload = { ...payload, revision };
  if (window.CrawlPagePicker) {
    try {
      browser.executeJavaScript(window.CrawlPagePicker.buildHighlightScript(markedPayload), true)
        .catch(() => {
          // Fallback is intentionally only used for current calls. Page-side revision
          // protection handles the normal path and prevents stale highlights.
          if (revision !== state.transientVisualRevision) return;
          try {
            if (payload.type === 'selector') browser.send('host-message', { type: 'highlight-selector', selector: payload.selector, color: payload.color });
            else if (payload.type === 'relative') browser.send('host-message', { type: 'highlight-relative', rootSelector: payload.rootSelector, fieldSelector: payload.fieldSelector, color: payload.color });
          } catch {}
        });
      return revision;
    } catch {}
  }
  return revision;
}

function renderBrowserMarkers() {
  if (!window.CrawlPagePicker?.buildProjectMarkersScript || !browser.src) return;
  const revision = ++state.browserMarkerRevision;
  const rootSelector = state.project.itemSelector || '';
  const payload = rootSelector
    ? { type: 'project', revision, rootSelector, itemKeyAttribute: state.project.itemKeyAttribute || '', itemIdentity: state.project.itemIdentity || state.project.itemMeta?.identity || null, fields: state.project.fields.map(field => ({
        name: field.name, selector: field.selector, selectors: field.selectors,
        expectedSignature: field.expectedSignature || '', targetTag: field.targetTag || '', targetClasses: field.targetClasses || [], semanticRole: field.semanticRole || ''
      })) }
    : { type: 'clear', revision };
  try { browser.executeJavaScript(window.CrawlPagePicker.buildProjectMarkersScript(payload), true).catch(() => {}); } catch {}
}

async function handlePickedElement(info) {
  const target = state.pickTarget;
  stopPick();
  if (!target) return;

  if (target === 'item') return openContainerDialog(info);
  if (target === 'pagination') return openPaginationDialog(info);
  return openFieldDialog(info);
}

async function openContainerDialog(info) {
  state.lastPicked = info;
  let candidates = Array.isArray(info.containerCandidates) ? info.containerCandidates : [];
  if (!candidates.length) {
    const detected = await detectContainerSelector(info.selector);
    candidates = [{
      selector: detected.selector || generalizeItemSelector(info.selector),
      count: detected.count || 0,
      score: 0,
      depth: 0,
      tag: info.tag || 'element',
      label: info.tag || 'Elemen',
      textSample: info.text || '',
      descendants: 0,
      recommended: true
    }];
  }
  state.containerCandidates = candidates;
  state.selectedContainerCandidate = candidates.find(candidate => candidate.recommended) || candidates[0] || null;
  $('containerPickedText').textContent = info.text ? `Anda mengklik: “${info.text.slice(0, 115)}”` : 'Elemen dipilih.';
  renderContainerCandidates();
  if (state.selectedContainerCandidate) highlightContainerCandidate(state.selectedContainerCandidate);
  $('containerDialog').showModal();
}

function renderContainerCandidates() {
  const root = $('containerCandidateList');
  root.innerHTML = '';
  if (!state.containerCandidates.length) {
    root.innerHTML = '<div class="empty-list">Tidak ada kandidat batas record yang dapat dianalisis.</div>';
    $('useContainerBtn').disabled = true;
    return;
  }
  const hasRepeatedCandidate = state.containerCandidates.some(c => Number(c.logicalCount || c.count || 0) >= 2);
  const selectedCount = Number(state.selectedContainerCandidate?.logicalCount || state.selectedContainerCandidate?.count || 0);
  $('useContainerBtn').disabled = hasRepeatedCandidate && selectedCount < 2;
  $('useContainerBtn').title = $('useContainerBtn').disabled ? 'Pilih struktur dengan minimal 2 item berulang. Struktur 1 item biasanya merupakan seluruh panel.' : '';

  state.containerCandidates.forEach((candidate, index) => {
    const row = document.createElement('label');
    row.className = `candidate-row${candidate === state.selectedContainerCandidate ? ' selected' : ''}`;
    const logicalCount = Number(candidate.logicalCount || candidate.count || 0);
    const recommended = candidate.recommended ? '<span class="candidate-recommended">Direkomendasikan</span>' : '';
    const warning = candidate.panelLike ? '<span class="candidate-warning">Kemungkinan panel, bukan item</span>' : (logicalCount < 2 ? '<span class="candidate-warning">Hanya 1 item</span>' : '');
    const identityLabel = candidate.identity?.jsonPath ? `${candidate.identity.attribute} → ${candidate.identity.jsonPath}` : (candidate.identity?.attribute || candidate.keyAttribute || '');
    const depthLabel = candidate.depth === 0 ? 'Elemen yang diklik' : `Parent +${candidate.depth}`;
    row.innerHTML = `
      <input type="radio" name="containerCandidate" value="${index}" ${candidate === state.selectedContainerCandidate ? 'checked' : ''}>
      <div class="candidate-main">
        <div class="candidate-title"><b>${escapeHtml(candidate.label || candidate.tag || 'Batas record')}</b>${recommended}${warning}</div>
        <div class="candidate-meta"><span>${logicalCount.toLocaleString('id-ID')} item unik${candidate.count > logicalCount ? ` / ${Number(candidate.count).toLocaleString('id-ID')} DOM` : ''}</span><span>${escapeHtml(depthLabel)}</span><span>${Number(candidate.descendants || 0)} elemen isi</span>${identityLabel ? `<span>ID: ${escapeHtml(identityLabel)}</span>` : ''}</div>
        <div class="candidate-sample">${escapeHtml(candidate.textSample || 'Tidak ada contoh teks')}</div>
      </div>`;
    row.querySelector('input').addEventListener('change', () => {
      state.selectedContainerCandidate = candidate;
      renderContainerCandidates();
      highlightContainerCandidate(candidate);
    });
    root.appendChild(row);
  });
}

function highlightContainerCandidate(candidate) {
  highlightInBrowser({ type: 'selector', selector: candidate.selector, color: '#21c77a' });
  setStatus(`${candidate.logicalCount || candidate.count || 0} item logis dipilih${candidate.count > (candidate.logicalCount || candidate.count) ? ` (${candidate.count} elemen DOM)` : ''}. Pastikan outline hijau mengelilingi satu kartu lengkap.`);
}

function applyContainerCandidate(candidate, { auto = false, preserveFields = false } = {}) {
  if (!candidate?.selector) return false;
  const changed = Boolean(state.project.itemSelector && state.project.itemSelector !== candidate.selector);
  state.project.itemSelector = candidate.selector;
  state.project.itemKeyAttribute = candidate.keyAttribute || null;
  state.project.itemIdentity = candidate.identity || null;
  state.project.itemMode = auto ? 'auto' : 'manual';
  state.project.itemLocked = true;
  state.project.itemMeta = {
    label: friendlyContainerLabel(candidate),
    countAtSelection: candidate.count || 0,
    logicalCountAtSelection: candidate.logicalCount || candidate.count || 0,
    keyAttribute: candidate.keyAttribute || null,
    identity: candidate.identity || null,
    selectedFromDepth: candidate.depth || 0,
    textSample: candidate.textSample || '',
    autoDetected: Boolean(auto)
  };
  if (changed && state.project.fields.length && !preserveFields) {
    state.project.fields = []; state.previewRows = []; state.showingPreview = false;
  }
  // Identitas record adalah metadata internal, bukan field yang harus dipilih pengguna.
  // Engine tetap menyertakannya pada preview/export (mis. review_id) dan memakainya
  // untuk deduplikasi, checkpoint, serta deteksi siklus halaman.
  return true;
}

function applySelectedContainer() {
  const candidate = state.selectedContainerCandidate;
  if (!applyContainerCandidate(candidate, { auto: false })) return;
  const identity = candidate.identity || null;
  const identityNote = identity ? ` Identitas record ${identity.suggestedName || 'record_id'} aktif otomatis.` : ' Identitas record akan dibuat dari fingerprint jika situs tidak menyediakan ID stabil.';
  setStatus(`Batas record “${state.project.itemMeta.label}” digunakan. ${candidate.logicalCount || candidate.count || 0} record logis ditemukan.${identityNote}`);
  renderProject(); scheduleAutosave(); renderFlowCanvas();
}

function friendlyContainerLabel(candidate) {
  const raw = String(candidate.label || '').replace(/^\w+\s*·\s*/, '').trim();
  if (/review/i.test(raw)) return 'Review';
  if (/product/i.test(raw)) return 'Produk';
  if (/hotel|property/i.test(raw)) return 'Hotel';
  if (/item|card|row/i.test(raw)) return raw.slice(0, 48) || 'Item berulang';
  return raw.slice(0, 48) || 'Item berulang';
}

async function openFieldDialog(info) {
  const dialogRevision = ++state.fieldDialogRevision;
  state.lastPicked = info;
  let rootSelector = state.project.itemSelector;
  let inferred = null;
  const proposed = info.inferredContainer || (Array.isArray(info.containerCandidates) ? (info.containerCandidates.find(c => c.recommended) || info.containerCandidates.find(c => Number(c.logicalCount || c.count || 0) >= 2 && !c.panelLike)) : null);
  if (!rootSelector || (proposed?.replaceActive && proposed.selector && proposed.selector !== rootSelector)) {
    inferred = proposed;
    if (inferred?.selector) rootSelector = inferred.selector;
  }
  state.pendingInferredContainer = inferred;
  const relativeInfo = info.relative && info.relative.containerSelector === rootSelector
    ? info.relative
    : await computeRelativeSelector(info.selector, rootSelector);
  if (dialogRevision !== state.fieldDialogRevision) return;
  const suggested = friendlyFieldSuggestion(info);
  state.fieldExpectedSignature = relativeInfo.targetSignature || info.semanticSignature || '';
  state.fieldCandidateSelectors = [...new Set([relativeInfo.selector, ...(relativeInfo.selectors || []), info.reusableSelector].filter(Boolean))];
  state.fieldTargetMeta = {
    tag: String(info.tag || '').toLowerCase(),
    classes: String(info.attributes?.class || '').split(/\s+/).filter(Boolean).slice(0,8),
    semanticRole: String(info.semanticRole || ''),
    pickedText: String(info.text || '').trim().slice(0,240)
  };
  state.fieldInitialValidation = {
    matches: Number(relativeInfo.matches || 0),
    total: Number(relativeInfo.total || 0),
    ambiguous: Number(relativeInfo.ambiguous || 0),
    mismatched: Number(relativeInfo.mismatched || 0),
    values: String(info.text || '').trim() ? [{ index: 1, value: String(info.text || '').trim(), selectorUsed: relativeInfo.selector || info.reusableSelector || info.selector || '' }] : [],
    source: 'selection'
  };
  state.fieldPreviewFallbackUsed = false;
  state.fieldPreviewError = '';
  state.detectedContainerIdentity = info.containerIdentity || inferred?.identity || state.project.itemIdentity || state.project.itemMeta?.identity || null;
  $('fieldNameInput').value = uniqueFieldName(suggested);
  $('fieldSelectorInput').value = relativeInfo.selector || info.reusableSelector || info.selector;
  $('fieldExtractInput').value = info.href ? 'href' : info.src ? 'src' : 'text';
  $('fieldDataTypeInput').value = guessDataType(info.text, suggested);
  $('fieldTransformInput').value = guessTransform(info.text, suggested);
  $('fieldRequiredInput').checked = false;
  $('fieldAttributeInput').value = '';
  $('fieldJsonPathInput').value = '';
  updateFieldExtractionControls(); renderIdentitySuggestion();
  $('fieldPickedValue').textContent = info.text ? `Contoh yang dipilih: “${info.text.slice(0, 100)}”` : info.href || info.src || '';
  const notice=$('autoStructureNotice');
  if (inferred?.replaceActive) {
    const logical=Number(inferred.logicalCount || inferred.count || 0);
    notice.innerHTML=`<b>Struktur review yang lebih tepat ditemukan</b><br>Batas record lama terlalu luas atau menghasilkan kandidat ambigu. ${logical ? `${logical} review tamu terdeteksi. ` : ''}Perubahan baru diterapkan setelah Anda menekan “Tambahkan”; tombol Batal tetap mempertahankan proyek lama.`;
    notice.classList.remove('hidden');
  } else if (inferred?.selector) {
    const logical=Number(inferred.logicalCount || inferred.count || 0);
    notice.innerHTML=`<b>Struktur record ditemukan otomatis</b><br>${logical ? `${logical} record terdeteksi. ` : ''}Field akan dicari relatif terhadap satu record. Detail HTML dapat diperiksa setelah field disimpan.`;
    notice.classList.remove('hidden');
  } else if (!state.project.itemSelector) {
    notice.textContent='MyDataset belum yakin dengan batas satu record. Field masih dapat diperiksa, tetapi Anda mungkin perlu memakai “Atur batas record secara manual”.';
    notice.classList.remove('hidden');
  } else notice.classList.add('hidden');
  setFieldQuality(relativeInfo.matches || 0, relativeInfo.total || 0, relativeInfo.ambiguous || 0, relativeInfo.mismatched || 0);
  $('fieldDialog').showModal();
  await updateFieldPreview(rootSelector, dialogRevision);
}

function updateFieldExtractionControls() {
  const mode = $('fieldExtractInput').value;
  const needsAttribute = ['attribute','containerAttribute','jsonAttribute','containerJsonAttribute'].includes(mode);
  const needsJsonPath = ['jsonAttribute','containerJsonAttribute'].includes(mode);
  $('attributeWrap').classList.toggle('hidden', !needsAttribute);
  $('jsonPathWrap').classList.toggle('hidden', !needsJsonPath);
}

function renderIdentitySuggestion() {
  const box = $('identitySuggestion');
  const info = state.detectedContainerIdentity || state.project.itemIdentity || state.project.itemMeta?.identity || null;
  if (!info?.attribute) {
    box.classList.add('hidden');
    return;
  }
  const path = info.jsonPath ? ` → ${info.jsonPath}` : '';
  const value = info.value != null && String(info.value) !== '' ? ` · contoh ${String(info.value).slice(0, 50)}` : '';
  $('identitySuggestionText').textContent = `${info.suggestedName || 'record_id'} aktif otomatis · ${info.attribute}${path}${value}`;
  box.classList.remove('hidden');
}

function looksLikeReviewDateText(value) {
  const text=String(value||'').replace(/\s+/g,' ').trim();
  if (!text) return false;
  if (/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(text)) return true;
  if (/^(?:\d{1,2}\s+)?(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text)) return true;
  if (/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(text)) return true;
  return false;
}

function looksLikeRatingMaxText(value) {
  const text=String(value||'').replace(/\s+/g,' ').trim();
  return /^\/\s*(?:5|10)(?:[.,]0+)?$/.test(text);
}

function semanticRoleFromFieldName(name) {
  const normalized=String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  // uniqueFieldName() adds _2, _3, ... when the same semantic field appears
  // more than once.  The suffix is an output-name disambiguator, not a new role.
  const n=normalized.replace(/_\d+$/,'');
  if (/^(review_title|comment_title|feedback_title|headline|title)$/.test(n)) return 'review_title';
  if (/^(review_text|review_comment|comment|comment_text|feedback|review_body)$/.test(n)) return 'review_text';
  if (/^(reviewer_name|reviewer|guest_name|author_name|user_name|customer_name)$/.test(n)) return 'reviewer_name';
  if (/^(reviewer_country|country|nationality|guest_country)$/.test(n)) return 'reviewer_country';
  if (/^(traveler_type|traveller_type|trip_type|guest_type)$/.test(n)) return 'traveler_type';
  if (/^(room_type|room_name)$/.test(n)) return 'room_type';
  if (/^(stay_detail|stay_date|checkin_detail)$/.test(n)) return 'stay_detail';
  if (/^(review_date|reviewed_at|review_time|date)$/.test(n)) return 'review_date';
  if (/^(rating_score|review_score|score|rating)$/.test(n)) return 'rating_score';
  if (/^(rating_max|max_rating|max_score|rating_scale|score_max)$/.test(n)) return 'rating_max';
  if (/^(rating_label|rating_level|score_label)$/.test(n)) return 'rating_label';
  if (/^(review_count|comment_count|reviews_count)$/.test(n)) return 'review_count';
  if (/^(product_name|product_title|item_name)$/.test(n)) return 'product_name';
  if (/^(price|product_price|amount|cost)$/.test(n)) return 'price';
  if (/^(description|product_description|item_description)$/.test(n)) return 'description';
  if (/^(stock|availability|inventory)$/.test(n)) return 'stock';
  if (/^(url|link|detail_url|product_url)$/.test(n)) return 'url';
  return '';
}

function semanticFallbackSelectors(name) {
  const role=semanticRoleFromFieldName(name);
  const profile=effectiveSiteProfile();
  const siteMap={
    tiket:{
      review_date:['[class*="ReviewCard_date__"]','[class*="ReviewCard_date"]','[class*="date__"]'],
      review_text:['span[class*="review_card_comment__"]','[class*="ReadMoreComments_review_card_comment__"]'],
      rating_score:['[class*="user_review__"]','[data-testid="tvat-ratingScore"]']
    },
    trip:{
      review_date:['[class*="reviewItem-userReviewTime"]','[class*="userReviewTime"]'],
      rating_label:['[class*="commentLevel"]','[class*="reviewItem-commentLevel"]'],
      rating_score:['[class*="reviewItem-rating"]','[class*="ratingScore"]'],
      rating_max:['[data-testid="rating-max"]','[class*="ratingMax"]','[class*="scoreMax"]']
    },
    traveloka:{
      review_date:['[data-testid*="review" i] [class*="time" i]','[data-testid*="review" i] [class*="date" i]','[aria-label*="Diulas" i]','time'],
      review_text:['[data-testid*="review" i] [dir="auto"]','article [dir="auto"]'],
      rating_score:['[data-testid*="rating" i]','[aria-label*="/10"]']
    },
    agoda:{
      review_date:['.Review-statusBar-left span','[class*="userReviewTime"]','[class*="reviewTime"]'],
      rating_score:[':scope > .Review-comment-left p > span:first-of-type',':scope > .Review-comment-left .Review-comment-score > span:first-of-type'],
      rating_label:[':scope > .Review-comment-left p > span:nth-of-type(2)',':scope > .Review-comment-left .Review-comment-score > span:nth-of-type(2)']
    }
  };
  const map={
    review_title:[
      '[data-testid="review-title"]','[data-element-name="review-title"]',
      '[class*="review_title"]','[class*="reviewTitle"]','[class*="comment-title"]'
    ],
    review_text:[
      '[data-testid="review-comment"]','[data-testid="review-text"]',
      'span[class*="review_card_comment__"]','[class*="ReadMoreComments_review_card_comment__"]',
      '[class*="reviewItem-content__"]','[class*="review-copy"]','[class*="review_text"]','[class*="review-content"]'
    ],
    reviewer_name:[
      '[data-info-type="reviewer-name"] strong','[data-testid="reviewer-name"]','[data-testid="guest-name"]',
      '[class*="customer_name__"]','[class*="reviewItem-userName__"]','[class*="reviewer_name"]','[class*="guest_name"]','cite'
    ],
    reviewer_country:[
      '[data-info-type="reviewer-name"] span:last-of-type','[data-testid="reviewer-country"]','[class*="reviewer_country"]','[class*="country__"]',
      'div:has(> .ic_languages) > span'
    ],
    traveler_type:[
      '[data-info-type="group-name"] span','[data-testid="traveler-type"]','[class*="traveler_type__"]','[class*="traveller_type__"]',
      'div:has(> .ic_business2) > span'
    ],
    room_type:['[data-info-type="room-type"] span','[data-testid="room-type"]','[class*="room_type__"]','div:has(> .ic_roomline) > span'],
    stay_detail:['[data-info-type="stay-detail"] span','[data-testid="stay-detail"]','[class*="stay_detail"]','div:has(> [class*="calendar"]) > span'],
    review_date:[
      ':scope > .Review-comment-right > .Review-comment-bubble > .Review-statusBar > .Review-statusBar-left span',
      '[data-testid="review-date"]','[class*="ReviewCard_date__"]','[class*="ReviewCard_date"]',
      '[class*="reviewItem-userReviewTime"]','[class*="userReviewTime"]','[class*="reviewTime"]',
      '[class*="review_date"]','[class*="date__"]','time'
    ],
    rating_score:[
      ':scope > .Review-comment-left p > span:first-of-type',
      ':scope > .Review-comment-left .Review-comment-score > span:first-of-type',
      ':scope > .Review-comment-left p span:first-child',
      '[data-testid="tvat-ratingScore"]','[data-testid="rating-score"]','[class*="Review-comment-scoreValue"]',
      '[class*="user_review__"]','[class*="rating_score"]','[class*="ratingScore"]'
    ],
    rating_max:[
      '[data-testid="rating-max"]','[data-testid="score-max"]','[class*="rating_max"]','[class*="ratingMax"]','[class*="scoreMax"]'
    ],
    rating_label:[
      ':scope > .Review-comment-left p > span:nth-of-type(2)',
      ':scope > .Review-comment-left .Review-comment-score > span:nth-of-type(2)',
      ':scope > .Review-comment-left p span:nth-child(2)',
      '[data-testid="rating-label"]','[class*="Review-comment-scoreLabel"]','[class*="rating_label"]','[class*="commentLevel"]'
    ],
    review_count:['[data-testid="review-count"]','[class*="review_count"]','div:has(> .ic_message) > span'],
    product_name:['[data-testid="product-name"]','.product-name','[itemprop="name"]'],
    price:['[data-testid="price"]','.price','[itemprop="price"]'],
    description:['[data-testid="description"]','.description','[itemprop="description"]'],
    stock:['[data-testid="stock"]','.stock','[itemprop="availability"]'],
    url:['a.detail-link','a[itemprop="url"]']
  };
  return role ? [...new Set([...(siteMap[profile]?.[role] || []), ...(map[role] || [])])] : [];
}

function friendlyFieldSuggestion(info) {
  const base = String(info.suggestedName || '').toLowerCase();
  const attrs = info.attributes || {};
  const text = String(info.text || '').trim();
  const dataTestId = String(attrs['data-testid'] || '').toLowerCase();
  const classHint = String(attrs.class || '').toLowerCase();
  const semanticPickedRole = String(info.semanticRole || '').toLowerCase();
  if (semanticPickedRole === 'review_date' || semanticPickedRole === 'stay_detail') return semanticPickedRole;
  if (looksLikeReviewDateText(text)) return 'review_date';
  if (/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(text)) return 'review_date';
  if (/^(?:\d{1,2}\s+)?(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text)) return 'review_date';
  if (/reviewitem-userreviewtime|review.*(?:date|time)/i.test(classHint)) return 'review_date';
  if (/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(text) || /member|membership|loyalty|tier|badge/i.test(classHint)) return 'field';
  if (/^\s*\d+\s+(?:ulasan|review|reviews|komentar|comments?)\s*$/i.test(text)) return 'review_count';
  const role = String(info.semanticRole || '').toLowerCase();
  if (role) return role;
  if (dataTestId === 'review-title') return 'review_title';
  if (dataTestId === 'review-comment') return 'review_text';
  if (dataTestId === 'tvat-ratingscore') return 'rating_score';
  if (/^diulas\s+\d+\s+(?:minggu|hari|bulan|tahun)\s+lalu$/i.test(text)) return 'review_date';
  if (/^direspon pada\b/i.test(text)) return 'hotel_response_date';
  if (base && !/^(field|div|span|p|sc_|css_|r_|typography)/.test(base) && !looksGeneratedFieldName(base)) return base;
  const hint = Object.entries(attrs).map(([key, value]) => `${key} ${value}`).join(' ').toLowerCase();
  if (/rating|score|star/.test(hint)) return 'rating_score';
  if (/review.*(text|content)|comment|feedback/.test(hint)) return 'review_text';
  if (/reviewer|guest.*name|author|user.*name/.test(hint)) return 'reviewer_name';
  if (/date|time|posted/.test(hint)) return 'review_date';
  if (/country|nationality/.test(hint)) return 'reviewer_country';
  if (/room.*type/.test(hint)) return 'room_type';
  if (/travell?er|guest.*type/.test(hint)) return 'traveler_type';
  if (/member|membership|loyalty|tier|badge|guest.*level/.test(hint)) return 'field';
  return 'field';
}

function looksGeneratedFieldName(value) {
  const raw = String(value || '');
  if (/^(css|sc|r)_/.test(raw)) return true;
  if (raw.length >= 16 && /\d/.test(raw) && /_/.test(raw) && !/(review|rating|country|room|traveler|date|name|title|text|score|price|amount|count|hotel|product)/.test(raw)) return true;
  return false;
}

function detectSiteProfileFromUrl(url = '') {
  const raw = String(url || '').toLowerCase();
  if (/tiket\.com/.test(raw)) return 'tiket';
  if (/agoda\./.test(raw)) return 'agoda';
  if (/traveloka\./.test(raw)) return 'traveloka';
  if (/(^|\/\/|\.)(trip\.com|ctrip\.com|tripcdn\.com)/.test(raw)) return 'trip';
  if (/booking\.com/.test(raw)) return 'booking';
  return 'generic';
}

function effectiveSiteProfile(project = state.project, url = currentBrowserUrl()) {
  const selected = String(project?.siteProfile || 'auto');
  const normalized = AcquisitionPolicy?.normalizedSite(selected, { url: url || project?.startUrl || project?.source?.sourceUrl || '' });
  if (normalized) return normalized;
  const detected = detectSiteProfileFromUrl(url || project?.startUrl || project?.source?.sourceUrl || '');
  return SITE_PROFILE_DEFS[detected] ? detected : 'generic';
}

function isNetworkJsonSourceMode() {
  // HAR/Network must remain visible even before the HAR tells us which
  // supported platform is active. Source detection later resolves
  // Traveloka or Tiket and updates siteProfile accordingly.
  return resolvedAcquisitionMethod() === 'network-json';
}


function normalizedNetworkSourceUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^(?:http:|https:)$/i.test(parsed.protocol)) return '';
    return ['traveloka','tiket','agoda','trip','booking'].includes(detectSiteProfileFromUrl(parsed.toString())) ? parsed.toString() : '';
  } catch { return ''; }
}

function renderNetworkSourceUrlField() {
  const input = $('networkSourceUrl');
  const help = $('networkSourceUrlHelp');
  if (!input) return;
  const saved = String(state.project?.source?.sourceUrl || state.project?.startUrl || '').trim();
  if (document.activeElement !== input) input.value = saved;
  const raw = String(input.value || '').trim();
  const valid = !raw || Boolean(normalizedNetworkSourceUrl(raw));
  input.classList.toggle('invalid', !valid);
  input.setAttribute('aria-invalid', String(!valid));
  if (help) {
    help.classList.toggle('error', !valid);
    help.innerHTML = !valid
      ? 'Source URL HAR/Network harus berupa alamat halaman <b>Traveloka, Tiket, Agoda, Trip, atau Booking</b> dengan http:// atau https:// yang valid.'
      : 'Alamat halaman asli tempat review berasal. Nilai ini disimpan sebagai provenance <code>_sourceUrl</code> / <code>source_url</code>, bukan URL endpoint API.';
  }
}

function syncNetworkSourceUrlFromInput({ validate = true, announce = false } = {}) {
  if (!isNetworkJsonSourceMode()) return '';
  const input = $('networkSourceUrl');
  const raw = String(input?.value || '').trim();
  if (!raw) {
    state.project.startUrl = '';
    state.project.source = { ...(state.project.source || {}), sourceUrl: '', canonicalUrl: '', actualUrl: '' };
    renderNetworkSourceUrlField();
    if (announce) setStatus('Source URL HAR/Network dikosongkan. Dataset tetap dapat diproses tanpa URL provenance jika sumber tidak menyediakan URL.');
    return '';
  }
  const normalized = normalizedNetworkSourceUrl(raw);
  if (!normalized) {
    renderNetworkSourceUrlField();
    if (validate && announce) setStatus('Source URL HAR/Network tidak valid. Gunakan alamat yang diawali http:// atau https://.');
    return '';
  }
  const previous = state.project.source || {};
  state.project.startUrl = normalized;
  state.project.source = {
    ...createDefaultProject().source,
    ...previous,
    sourceUrl: normalized,
    canonicalUrl: normalized,
    actualUrl: normalized,
    siteName: previous.siteName || activePageDisplayLabel(normalized),
    detectedBy: previous.detectedBy || 'manual'
  };
  if (input && input.value !== normalized && document.activeElement !== input) input.value = normalized;
  renderNetworkSourceUrlField();
  if (announce) setStatus(`Source URL HAR/Network disimpan: ${activePageDisplayLabel(normalized)}.`);
  return normalized;
}

function currentNetworkSourceUrl() {
  if (!isNetworkJsonSourceMode()) return '';
  const input = $('networkSourceUrl');
  if (input) {
    const inputValue = String(input.value || '').trim();
    return inputValue ? normalizedNetworkSourceUrl(inputValue) : '';
  }
  return normalizedNetworkSourceUrl(state.project?.source?.sourceUrl || state.project?.startUrl || '');
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function selectedNetworkSourceCandidate(staged = state.stagedNetworkImport) {
  const candidates = Array.isArray(staged?.sourceCandidates) ? staged.sourceCandidates : [];
  if (!candidates.length) return null;
  return candidates.find(item => String(item.id || '') === String(staged?.selectedSourceId || '')) || candidates[0];
}

function networkSiteFromContext(candidate = {}, staged = state.stagedNetworkImport) {
  const direct = String(candidate.siteProfile || '').toLowerCase();
  if (['traveloka','tiket','agoda','trip','booking'].includes(direct)) return direct;
  const label = String(candidate.siteName || staged?.sourceContext?.siteName || '').toLowerCase();
  if (label.includes('tiket')) return 'tiket';
  if (label.includes('traveloka')) return 'traveloka';
  if (label.includes('agoda')) return 'agoda';
  if (label.includes('trip')) return 'trip';
  if (label.includes('booking')) return 'booking';
  const url = String(candidate.sourceUrl || staged?.sourceContext?.sourceUrl || '');
  const detected = detectSiteProfileFromUrl(url);
  return ['traveloka','tiket','agoda','trip','booking'].includes(detected) ? detected : 'traveloka';
}

function applyDetectedNetworkSource(staged = state.stagedNetworkImport, { announce = false } = {}) {
  if (!staged) return null;
  const candidate = selectedNetworkSourceCandidate(staged);
  const siteProfile = networkSiteFromContext(candidate || {}, staged);
  const siteName = candidate?.siteName || staged.sourceContext?.siteName || AcquisitionPolicy?.labelForSite(siteProfile) || SITE_PROFILE_DEFS[siteProfile]?.label || 'Sumber';
  const context = candidate ? {
    objectName: candidate.objectName,
    siteName,
    sourceUrl: candidate.sourceUrl,
    canonicalUrl: candidate.canonicalUrl || candidate.sourceUrl,
    objectId: candidate.objectId,
    entityType: candidate.entityType,
    detectedBy: staged.sourceType === 'har' ? 'har-network' : 'network-import'
  } : (staged.sourceContext || {});
  const detectedUrl = normalizedNetworkSourceUrl(context.sourceUrl || '');
  if (detectedUrl) {
    if ($('networkSourceUrl')) $('networkSourceUrl').value = detectedUrl;
    state.project.startUrl = detectedUrl;
  }
  const detectedName = String(context.objectName || '').trim();
  if (detectedName && (staged.sourceType === 'har' || state.project.nameAuto !== false || !unifiedProjectIdentity())) {
    setUnifiedProjectIdentity(detectedName, { detectedBy: context.detectedBy || 'network-import', syncInput: true });
  }
  state.project.siteProfile = siteProfile;
  state.project.acquisition = { ...(state.project.acquisition || {}), method: 'network-json', scope: 'all' };
  state.project.source = {
    ...createDefaultProject().source,
    ...(state.project.source || {}),
    objectName: detectedName || state.project.source?.objectName || unifiedProjectIdentity(),
    siteName,
    sourceUrl: detectedUrl || state.project.source?.sourceUrl || '',
    canonicalUrl: normalizedNetworkSourceUrl(context.canonicalUrl || '') || detectedUrl || state.project.source?.canonicalUrl || '',
    actualUrl: detectedUrl || state.project.source?.actualUrl || '',
    objectId: String(context.objectId || ''),
    entityType: String(context.entityType || ''),
    detectedBy: context.detectedBy || (staged.sourceType === 'har' ? 'har-network' : 'network-import'),
    importedNetworkData: true,
    importSourceType: staged.sourceType || 'json'
  };
  if ($('siteProfile')) $('siteProfile').value = siteProfile;
  if ($('networkSourceUrlMode')) $('networkSourceUrlMode').textContent = '';
  renderSiteProfile();
  renderNetworkSourceUrlField();
  renderSourceIdentity();
  if (announce && detectedName) setStatus(`Sumber terdeteksi otomatis: ${siteName} · ${detectedName}${context.objectId ? ` · ID ${context.objectId}` : ''}.`);
  return context;
}

function applyNetworkCandidateSelection(candidateId) {
  const staged = state.stagedNetworkImport;
  if (!staged) return;
  const candidate = (staged.sourceCandidates || []).find(item => String(item.id || '') === String(candidateId || ''));
  if (!candidate) return;
  staged.selectedSourceId = candidate.id;
  staged.adapter = candidate.adapter || staged.adapter;
  staged.platform = candidate.siteProfile || staged.platform;
  staged.sourceContext = {
    objectName: candidate.objectName,
    siteName: candidate.siteName || AcquisitionPolicy?.labelForSite(candidate.siteProfile) || SITE_PROFILE_DEFS[candidate.siteProfile]?.label || 'Sumber',
    sourceUrl: candidate.sourceUrl,
    canonicalUrl: candidate.canonicalUrl || candidate.sourceUrl,
    objectId: candidate.objectId,
    entityType: candidate.entityType,
    detectedBy: staged.sourceType === 'har' ? 'har-network' : 'network-import'
  };
  staged.responseCount = Number(candidate.responseCount || 0);
  staged.rawResponseOccurrences = Number(candidate.rawResponseOccurrences ?? candidate.responseCount ?? 0);
  staged.totalReviews = Number(candidate.totalReviews || 0);
  staged.uniqueSourceReviews = Number(candidate.uniqueReviews ?? candidate.totalReviews ?? 0);
  staged.textReviewCount = Number(candidate.textReviews || 0);
  staged.emptyTextReviewCount = Number(candidate.emptyTextReviews || 0);
  staged.lastHasNext = typeof candidate.lastHasNext === 'boolean' ? candidate.lastHasNext : null;
  staged.datasetMetadata = candidate.datasetMetadata || staged.datasetMetadata || null;
  applyDetectedNetworkSource(staged, { announce: true });
  renderNetworkImportStage();
  scheduleAutosave();
  renderFlowCanvas();
}

function renderNetworkImportStage() {
  const setup = $('networkImportSetup');
  if (!setup) return;
  const active = isNetworkJsonSourceMode();
  setup.classList.toggle('hidden', !active);
  $('sourceIdentityCard')?.classList.toggle('hidden', active);
  if (!active) return;
  renderNetworkSourceUrlField();

  const preview = $('networkStagePreview');
  const actions = $('networkStageActions');
  const processBtn = $('processNetworkFilesBtn');
  const staged = state.stagedNetworkImport;
  if (!staged?.stageId) {
    preview.className = 'network-stage-preview har-inspector-preview empty';
    preview.innerHTML = '<span>Pilih file HAR.</span>';
    const sidebarSummary = $('networkSidebarSummary');
    if (sidebarSummary) { sidebarSummary.className = 'network-sidebar-summary empty'; sidebarSummary.textContent = 'Belum ada file dipilih.'; }
    actions?.classList.add('hidden');
    if (processBtn) processBtn.disabled = true;
    if ($('networkSourceUrlMode')) $('networkSourceUrlMode').textContent = '';
    return;
  }

  const files = Array.isArray(staged.files) ? staged.files : [];
  const candidate = selectedNetworkSourceCandidate(staged);
  const candidates = Array.isArray(staged.sourceCandidates) ? staged.sourceCandidates : [];
  const siteProfile = networkSiteFromContext(candidate || {}, staged);
  const isTiket = siteProfile === 'tiket' || staged.adapter === 'tiket-internalReview';
  const isAgoda = siteProfile === 'agoda' || staged.adapter === 'agoda-ReviewComments';
  const isTrip = siteProfile === 'trip' || staged.adapter === 'trip-getHotelCommentInfo';
  const isBooking = siteProfile === 'booking' || staged.adapter === 'booking-ReviewList';
  const siteName = candidate?.siteName || staged.sourceContext?.siteName || (isTiket ? 'Tiket' : isAgoda ? 'Agoda' : isTrip ? 'Trip' : isBooking ? 'Booking' : 'Traveloka');
  const adapterLabel = staged.adapter === 'tiket-internalReview' ? 'Tiket internalReview' : staged.adapter === 'agoda-ReviewComments' ? 'Agoda ReviewComments' : staged.adapter === 'trip-getHotelCommentInfo' ? 'Trip getHotelCommentInfo' : staged.adapter === 'booking-ReviewList' ? 'Booking ReviewList' : String(staged.adapter || '').replace('traveloka-getReviews', 'Traveloka getReviews');
  const sourceTypeLabel = staged.sourceType === 'har' ? 'HAR Chrome' : (staged.sourceType === 'capture-json' ? 'JSON Capture Legacy' : 'JSON Network');
  const captureVersion = String(staged.captureMetadata?.extensionVersion || '').trim();
  const captureBadge = captureVersion ? `<span>Capture ${escapeHtml(captureVersion)}</span>` : '';
  const datasetMeta = staged.datasetMetadata || staged.captureMetadata?.datasetMetadata || candidate?.datasetMetadata || null;
  const fmtCount = value => value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toLocaleString('id-ID');
  const pagination = datasetMeta?.pagination || {};
  const reportedCount = datasetMeta?.api_reported_count ?? datasetMeta?.api_reported_text_count ?? null;
  const discrepancy = datasetMeta?.count_discrepancy?.reported_vs_retrieved;
  const detected = candidate || staged.sourceContext || {};
  const sourceUrl = String(detected.sourceUrl || staged.sourceContext?.sourceUrl || '');
  const candidateLabel = item => {
    const candidateSite = item.siteName || AcquisitionPolicy?.labelForSite(item.siteProfile) || SITE_PROFILE_DEFS[item.siteProfile]?.label || 'Sumber';
    if (item.siteProfile !== 'traveloka' || item.adapter !== 'traveloka-getReviews') return `${candidateSite} · ${item.objectName || item.objectId || 'Sumber'} · ${fmtCount(item.uniqueReviews ?? item.totalReviews)} review`;
    const f = String(item?.filter?.format || '');
    const fl = f === 'FORMAT_VALUE_TEXT' ? 'Dengan Teks' : f === 'FORMAT_VALUE_ALL' ? 'Semua Format' : f;
    return `${candidateSite} · ${item.objectName || item.objectId || 'Sumber'}${fl ? ` · ${fl}` : ''} · ${fmtCount(item.uniqueReviews ?? item.totalReviews)} review`;
  };
  const sourceChooser = candidates.length > 1 ? `
    <label class="network-source-candidate">Sumber di HAR
      <select id="networkDetectedSourceSelect">
        ${candidates.map(item => `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(staged.selectedSourceId) ? 'selected' : ''}>${escapeHtml(candidateLabel(item))}</option>`).join('')}
      </select>
    </label>` : '';
  const detectedCard = `
    <div class="network-detected-source">
      <div class="network-detected-source-title"><b>Sumber</b></div>
      <div class="network-detected-source-grid">
        <div><span>Website</span><b>${escapeHtml(siteName)}</b></div>
        <div><span>Objek</span><b>${escapeHtml(detected.objectName || staged.sourceContext?.objectName || 'Belum terdeteksi')}</b></div>
        ${(detected.entityType || staged.sourceContext?.entityType) ? `<div><span>Jenis</span><b>${escapeHtml(detected.entityType || staged.sourceContext?.entityType)}</b></div>` : ''}
        ${(detected.objectId || staged.sourceContext?.objectId) ? `<div><span>ID objek</span><b>${escapeHtml(detected.objectId || staged.sourceContext?.objectId)}</b></div>` : ''}
      </div>
      ${sourceUrl ? `<small class="network-detected-url" title="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</small>` : '<small class="network-detected-url">Source URL tidak tersedia.</small>'}
    </div>`;

  let populationAudit = '';
  let warning = '';
  if (isTiket) {
    const missingPages = Number(pagination.missing_pages_count ?? (Array.isArray(pagination.missing_pages) ? pagination.missing_pages.length : NaN));
    const config = datasetMeta?.requested_config || candidate?.requestConfig || candidate?.filter || {};
    const configLabel = [config.subTopic ? `subTopic=${config.subTopic}` : '', config.reviewSubmitColumn ? `sort=${config.reviewSubmitColumn}` : '', config.sortDirection || ''].filter(Boolean).join(' · ') || 'konfigurasi request tercatat di HAR';
    populationAudit = `
      <div class="network-stage-audit">
        <div class="network-stage-audit-title"><b>Review · Tiket</b></div>
        <div class="network-stage-audit-grid">
          <div><span>internalReview aktual</span><b>${fmtCount(staged.uniqueSourceReviews ?? staged.totalReviews)}</b><small>${fmtCount(staged.responseCount)} halaman logis · last=${pagination.last_page_flag === true ? 'true' : pagination.last_page_flag === false ? 'false' : '?'}</small></div>
          <div><span>Dengan teks</span><b>${fmtCount(staged.textReviewCount)}</b></div>
          <div><span>Tanpa teks</span><b>${fmtCount(staged.emptyTextReviewCount)}</b></div>
          ${reportedCount != null ? `<div><span>Total menurut API</span><b>${fmtCount(reportedCount)}</b><small>totalElements</small></div>` : ''}
          <div><span>Konfigurasi</span><b>Semua review</b><small>${escapeHtml(configLabel)}</small></div>
          <div><span>Respons HAR</span><b>${fmtCount(pagination.raw_occurrence_count ?? staged.rawResponseOccurrences)}</b><small>${fmtCount(pagination.duplicate_page_occurrences)} berulang</small></div>
          ${discrepancy != null ? `<div><span>Selisih API</span><b>${fmtCount(discrepancy)}</b></div>` : ''}
        </div>
        <div class="network-stage-coverage ${pagination.complete ? 'complete' : ''}">${pagination.complete ? 'Lengkap' : 'Belum lengkap'}${pagination.first_page != null ? ` · halaman ${fmtCount(pagination.first_page)}–${fmtCount(pagination.last_page)}` : ''}${pagination.total_pages != null ? ` · total ${fmtCount(pagination.total_pages)}` : ''}${Number.isFinite(missingPages) ? ` · hilang ${fmtCount(missingPages)}` : ''}</div>
      </div>`;
    if (pagination.complete === false) warning = '<div class="network-stage-warning"><b>Pagination belum lengkap.</b></div>';
  } else if (isTrip) {
    const missingPages = Number(pagination.missing_pages_count ?? (Array.isArray(pagination.missing_pages) ? pagination.missing_pages.length : NaN));
    const logicalPages = Number(pagination.request_count ?? staged.responseCount ?? 0);
    const totalPages = Number(pagination.total_pages ?? 0);
    const listingCount = Number(datasetMeta?.api_reported_count ?? staged.uniqueSourceReviews ?? staged.totalReviews ?? 0);
    const capturedListing = Number(staged.uniqueSourceReviews ?? staged.totalReviews ?? 0);
    const rawTotal = datasetMeta?.api_reported_total_count;
    const repeatCount = datasetMeta?.api_repeat_comment_count;
    const duplicateIds = Number(datasetMeta?.source_duplicate_review_ids ?? staged.sourceDuplicateReviewIds ?? 0);
    populationAudit = `
      <div class="network-stage-audit">
        <div class="network-stage-audit-title"><b>Review · Trip · getHotelCommentInfo</b></div>
        <div class="network-stage-audit-grid">
          <div><span>Listing tercakup</span><b>${fmtCount(capturedListing)} / ${fmtCount(listingCount)}</b><small>review ID unik pada listing endpoint</small></div>
          <div><span>Halaman tercakup</span><b>${fmtCount(logicalPages)} / ${totalPages ? fmtCount(totalPages) : '-'}</b><small>response logis pageIndex</small></div>
          <div><span>Halaman hilang</span><b>${Number.isFinite(missingPages) ? fmtCount(missingPages) : '-'}</b></div>
          <div><span>Duplicate review ID</span><b>${fmtCount(duplicateIds)}</b></div>
          <div><span>Respons HAR mentah</span><b>${fmtCount(pagination.raw_occurrence_count ?? staged.rawResponseOccurrences)}</b><small>${fmtCount(pagination.duplicate_page_occurrences)} pengulangan halaman</small></div>
          <div><span>Dengan teks</span><b>${fmtCount(staged.textReviewCount)}</b><small>tanpa teks ${fmtCount(staged.emptyTextReviewCount)}</small></div>
          ${rawTotal != null ? `<div><span>Total sumber</span><b>${fmtCount(rawTotal)}</b><small>totalCount</small></div>` : ''}
          ${repeatCount != null ? `<div><span>Repeat comments</span><b>${fmtCount(repeatCount)}</b><small>repeatCommentCount</small></div>` : ''}
        </div>
        <div class="network-stage-coverage ${pagination.complete ? 'complete' : ''}">${pagination.complete ? 'Lengkap' : 'Belum lengkap'} · ${totalPages ? `${fmtCount(logicalPages)}/${fmtCount(totalPages)} halaman tercakup` : `${fmtCount(logicalPages)} halaman teramati`} · ${fmtCount(capturedListing)}/${fmtCount(listingCount)} review listing · ${Number.isFinite(missingPages) ? `${fmtCount(missingPages)} halaman hilang` : 'halaman hilang tidak diketahui'} · ${fmtCount(duplicateIds)} duplicate ID</div>
      </div>`;
    if (pagination.complete === false) warning = '<div class="network-stage-warning"><b>HAR Trip belum mencakup seluruh pageIndex yang dilaporkan endpoint. Lakukan pagination review sampai halaman terakhir lalu ekspor ulang HAR with content.</b></div>';
  } else if (isAgoda) {
    const missingPages = Number(pagination.missing_pages_count ?? (Array.isArray(pagination.missing_pages) ? pagination.missing_pages.length : NaN));
    populationAudit = `
      <div class="network-stage-audit">
        <div class="network-stage-audit-title"><b>Review · ${escapeHtml(siteName)}</b></div>
        <div class="network-stage-audit-grid">
          <div><span>ReviewComments aktual</span><b>${fmtCount(staged.uniqueSourceReviews ?? staged.totalReviews)}</b><small>${fmtCount(staged.responseCount)} halaman response</small></div>
          <div><span>Dengan teks</span><b>${fmtCount(staged.textReviewCount)}</b></div>
          <div><span>Tanpa teks</span><b>${fmtCount(staged.emptyTextReviewCount)}</b></div>
          ${reportedCount != null ? `<div><span>Total menurut API</span><b>${fmtCount(reportedCount)}</b><small>totalIndex</small></div>` : ''}
          <div><span>Respons HAR</span><b>${fmtCount(pagination.raw_occurrence_count ?? staged.rawResponseOccurrences)}</b><small>${fmtCount(pagination.duplicate_page_occurrences)} berulang</small></div>
          ${discrepancy != null ? `<div><span>Belum tertangkap</span><b>${fmtCount(discrepancy)}</b></div>` : ''}
        </div>
        <div class="network-stage-coverage ${pagination.complete ? 'complete' : ''}">${pagination.complete ? 'Lengkap' : 'Belum lengkap'}${pagination.first_page != null ? ` · halaman ${fmtCount(pagination.first_page)}–${fmtCount(pagination.last_page)}` : ''}${pagination.total_pages != null ? ` · total ${fmtCount(pagination.total_pages)}` : ''}${Number.isFinite(missingPages) ? ` · hilang ${fmtCount(missingPages)}` : ''}</div>
      </div>`;
    if (pagination.complete === false) warning = '<div class="network-stage-warning"><b>HAR hanya memuat halaman yang terekam. Tambahkan pagination di browser sebelum ekspor HAR jika ingin coverage lebih besar.</b></div>';
  } else if (isBooking) {
    const missingOffsets = Number(pagination.missing_offsets ?? (Array.isArray(pagination.missing_skip_values) ? pagination.missing_skip_values.length : NaN));
    populationAudit = `
      <div class="network-stage-audit">
        <div class="network-stage-audit-title"><b>Review · Booking</b></div>
        <div class="network-stage-audit-grid">
          <div><span>ReviewList aktual</span><b>${fmtCount(staged.uniqueSourceReviews ?? staged.totalReviews)}</b><small>${fmtCount(staged.responseCount)} response logis</small></div>
          <div><span>Dengan teks</span><b>${fmtCount(staged.textReviewCount)}</b></div>
          <div><span>Tanpa teks</span><b>${fmtCount(staged.emptyTextReviewCount)}</b></div>
          ${reportedCount != null ? `<div><span>Total menurut API</span><b>${fmtCount(reportedCount)}</b><small>reviewsCount</small></div>` : ''}
          <div><span>Respons HAR</span><b>${fmtCount(pagination.raw_occurrence_count ?? staged.rawResponseOccurrences)}</b><small>${fmtCount(pagination.duplicate_offset_occurrences)} berulang</small></div>
          ${discrepancy != null ? `<div><span>Belum tertangkap</span><b>${fmtCount(discrepancy)}</b></div>` : ''}
        </div>
        <div class="network-stage-coverage ${pagination.complete ? 'complete' : ''}">${pagination.complete ? 'Lengkap' : 'Belum lengkap'}${pagination.first_skip != null ? ` · skip ${fmtCount(pagination.first_skip)}–${fmtCount(pagination.last_skip)}` : ''}${pagination.total_pages != null ? ` · total ${fmtCount(pagination.total_pages)} halaman` : ''}${Number.isFinite(missingOffsets) ? ` · hilang ${fmtCount(missingOffsets)}` : ''}</div>
      </div>`;
    if (pagination.complete === false) warning = '<div class="network-stage-warning"><b>HAR Booking belum mencakup seluruh offset ReviewList. Lakukan pagination sampai review terakhir sebelum ekspor HAR jika ingin coverage lengkap.</b></div>';
  } else {
    const aggregateAvailable = datasetMeta && [datasetMeta.aggregate_total, datasetMeta.aggregate_traveloka, datasetMeta.aggregate_other].some(value => value != null);
    const requestedFormat = String(datasetMeta?.filter?.format || candidate?.filter?.format || '');
    const formatLabel = requestedFormat === 'FORMAT_VALUE_TEXT' ? 'Dengan Teks' : requestedFormat === 'FORMAT_VALUE_ALL' ? 'Semua Format' : (requestedFormat || 'tidak tercatat');
    populationAudit = `
      <div class="network-stage-audit">
        <div class="network-stage-audit-title"><b>Review · Traveloka</b></div>
        <div class="network-stage-audit-grid">
          <div><span>getReviews aktual</span><b>${fmtCount(staged.uniqueSourceReviews ?? staged.totalReviews)}</b><small>${fmtCount(staged.responseCount)} response · ${pagination.last_has_next === false || staged.lastHasNext === false ? 'hasNext=false' : 'terminal belum pasti'}</small></div>
          <div><span>Dengan teks</span><b>${fmtCount(staged.textReviewCount)}</b></div>
          <div><span>Tanpa teks</span><b>${fmtCount(staged.emptyTextReviewCount)}</b></div>
          <div><span>Format request</span><b>${escapeHtml(formatLabel)}</b><small>${escapeHtml(requestedFormat || 'filter tidak tercatat')}</small></div>
          ${aggregateAvailable ? `<div><span>Aggregate UI</span><b>${fmtCount(datasetMeta.aggregate_total)}</b><small>Traveloka ${fmtCount(datasetMeta.aggregate_traveloka)}${datasetMeta.aggregate_other != null ? ` + sumber lain ${fmtCount(datasetMeta.aggregate_other)}` : ''}</small></div>` : ''}
          ${reportedCount != null ? `<div><span>getReviewCount</span><b>${fmtCount(reportedCount)}</b><small>count endpoint</small></div>` : ''}
          ${discrepancy != null ? `<div><span>Selisih API</span><b>${fmtCount(discrepancy)}</b></div>` : ''}
        </div>
        ${datasetMeta?.coverage_claim ? `<div class="network-stage-coverage ${pagination.complete ? 'complete' : ''}">${pagination.complete ? 'Lengkap' : 'Belum lengkap'}${pagination.first_skip != null ? ` · skip ${fmtCount(pagination.first_skip)}–${fmtCount(pagination.last_skip)}` : ''}${pagination.missing_offsets === 0 ? ' · hilang 0' : pagination.missing_offsets != null ? ` · hilang ${fmtCount(pagination.missing_offsets)}` : ''}</div>` : ''}
      </div>`;
    warning = staged.lastHasNext === true ? '<div class="network-stage-warning"><b>hasNext=true · pagination belum selesai.</b></div>' : '';
  }
  const privacy = '';
  preview.className = 'network-stage-preview har-inspector-preview';
  preview.innerHTML = `
    <div class="network-stage-summary">
      <span>${escapeHtml(sourceTypeLabel)}</span>
      <span>${files.length.toLocaleString('id-ID')} file</span>
      <span>${Number(staged.responseCount || 0).toLocaleString('id-ID')} respons review</span>
      <span>${Number(staged.uniqueSourceReviews ?? staged.totalReviews ?? 0).toLocaleString('id-ID')} review</span>
      ${adapterLabel ? `<span>${escapeHtml(adapterLabel)}</span>` : ''}
      ${captureBadge}
    </div>
    ${sourceChooser}
    ${detectedCard}
    <ul class="network-stage-files">
      ${files.map(file => `<li class="network-stage-file"><b title="${escapeHtml(file.name || '')}">${escapeHtml(file.name || 'file')}</b><small>${formatBytes(file.size)} · ${Number(file.responses || 0).toLocaleString('id-ID')} respons review · ${Number(file.reviews || 0).toLocaleString('id-ID')} review</small></li>`).join('')}
    </ul>
    ${populationAudit}
    ${warning}
    ${privacy}`;
  const candidateSelect = $('networkDetectedSourceSelect');
  candidateSelect?.addEventListener('change', () => applyNetworkCandidateSelection(candidateSelect.value));
  const sidebarSummary = $('networkSidebarSummary');
  if (sidebarSummary) {
    const firstFile = files[0];
    sidebarSummary.className = 'network-sidebar-summary';
    sidebarSummary.innerHTML = `<b>${escapeHtml(firstFile?.name || sourceTypeLabel)}</b><span>${escapeHtml(siteName)} · ${fmtCount(staged.uniqueSourceReviews ?? staged.totalReviews)} review · ${fmtCount(staged.responseCount)} response</span>`;
  }
  actions?.classList.remove('hidden');
  if (processBtn) {
    processBtn.disabled = !Number(staged.totalReviews || 0);
    processBtn.textContent = Number(staged.totalReviews || 0) > 0
      ? `Proses ${Number(staged.totalReviews).toLocaleString('id-ID')} review`
      : 'Proses file';
  }
}

async function clearStagedNetworkImport({ silent = false } = {}) {
  const stageId = state.stagedNetworkImport?.stageId;
  state.stagedNetworkImport = null;
  renderNetworkImportStage();
  if (stageId) {
    try { await appApi.clearNetworkJsonStage?.(stageId); } catch {}
  }
  if (!silent) setStatus('Pilihan file HAR/Network dikosongkan.');
}

async function focusNetworkJsonUpload() {
  if (state.running) return setStatus('Jeda atau tunggu run selesai sebelum mengganti sumber HAR/Network.');
  state.project.acquisition = { ...(state.project.acquisition || {}), method: 'network-json', scope: 'all' };
  const currentSite = AcquisitionPolicy?.normalizedSite(state.project.siteProfile || '', { url: state.project.startUrl || state.project.source?.sourceUrl || '' }) || '';
  if (!['traveloka','tiket','agoda','trip','booking'].includes(currentSite)) state.project.siteProfile = 'auto';
  if ($('acquisitionMethod')) $('acquisitionMethod').value = 'network-json';
  renderSiteProfile(); renderAcquisition();
  const button = $('stageNetworkFilesBtn');
  try { button?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
  button?.focus();
  setStatus('HAR / Network aktif. Pilih file HAR.');
}

async function stageNetworkJsonFiles() {
  if (state.running) return setStatus('Pengambilan data sedang berjalan. Jeda terlebih dahulu.');
  syncProjectInputs();
  const previousStage = state.stagedNetworkImport;
  try {
    const result = await appApi.stageNetworkJson({ project: state.project, sourceUrl: currentNetworkSourceUrl() });
    if (!result || result.canceled) return;
    const previousId = previousStage?.stageId;
    if (previousId && previousId !== result.stageId) {
      try { await appApi.clearNetworkJsonStage?.(previousId); } catch {}
    }
    state.stagedNetworkImport = result;
    state.project.acquisition = { ...(state.project.acquisition || {}), method: 'network-json', scope: 'all' };
    applyDetectedNetworkSource(result, { announce: false });
    renderNetworkImportStage();
    scheduleAutosave();
    const sourceLabel = result.sourceType === 'har' ? 'HAR Chrome' : 'JSON Network';
    setStatus(`${sourceLabel}: ${Number(result.uniqueSourceReviews ?? result.totalReviews ?? 0).toLocaleString('id-ID')} review · ${Number(result.responseCount || 0).toLocaleString('id-ID')} response.`);
  } catch (error) {
    // Selection/inspection failure must not destroy the last valid staged input.
    state.stagedNetworkImport = previousStage || null;
    renderNetworkImportStage();
    setStatus(`File HAR/Network tidak dapat diperiksa: ${error.message}`);
    const action = await showAcquisitionFailureDialog({
      message: error.message,
      stage: 'loading',
      collected: Number(previousStage?.totalReviews || 0),
      method: 'network-json'
    });
    if (action === 'retry') return stageNetworkJsonFiles();
  }
}

async function processStagedNetworkJson() {
  if (state.running) return setStatus('Pengambilan data sedang berjalan. Jeda terlebih dahulu.');
  const staged = state.stagedNetworkImport;
  if (!staged?.stageId) { await stageNetworkJsonFiles(); return; }
  syncProjectInputs();
  const policy = validateAcquisitionPolicy();
  if (!policy.ok || policy.method !== 'network-json' || !['traveloka','tiket','agoda','trip','booking'].includes(policy.site)) return setStatus(policy.ok ? 'HAR / Network mendukung Traveloka, Tiket, Agoda, Trip, dan Booking.' : policy.message);
  const subject = unifiedProjectIdentity();
  if (!subject) { $('projectName')?.focus(); return setStatus('Isi “Nama objek / proyek” sebelum memproses file. Nilai ini menjadi review_subject dan nama hasil.'); }
  $('logBox').textContent = '';
  beginRuntimeFlow(`Memproses file HAR/Network ${AcquisitionPolicy?.labelForSite(policy.site) || SITE_PROFILE_DEFS[policy.site]?.label || 'sumber'} yang sudah diperiksa…`);
  switchWorkspaceView('flowView', { focusLive: true });
  setRunningUi(true);
  let retryAgain = false;
  try {
    const result = await appApi.processNetworkJson({ stageId: staged.stageId, project: state.project, sourceUrl: currentNetworkSourceUrl(), sourceSelection: staged.selectedSourceId || '', allowSourceUrlOverride: true });
    if (!result || result.canceled) return;
    if (!result.ok) {
      await applyRunResult(result);
      const action = await showAcquisitionFailureDialog({ message:result.error || result.state?.lastMessage || 'Proses HAR/Network gagal.', stage:state.runtimeFlow.failureStage || state.runtimeFlow.lastOperationalStage || 'extracting', collected:result.totalRows || result.state?.itemsCollected || 0, runDir:result.runDir || '', method:'network-json' });
      retryAgain = action === 'retry';
      if (!retryAgain && result.runDir) { try { await appApi.markRunStopped?.(result.runDir); } catch {} }
    } else {
    state.stagedNetworkImport = null;
    state.project.acquisition = { ...(state.project.acquisition || {}), method: 'network-json', scope: 'all' };
    state.project.siteProfile = result.projectSiteProfile || policy.site;
    if (result.source) {
      state.project.source = { ...createDefaultProject().source, ...result.source, importedNetworkData: true };
      state.project.startUrl = String(result.source.sourceUrl || state.project.startUrl || '');
    }
    renderNetworkImportStage(); renderSourceIdentity(); scheduleAutosave();
    await applyRunResult(result);
    await keepCompletedFlowVisible(700);
    switchWorkspaceView('dataView');
    const summary = result.importSummary || {};
    const completed = summary.paginationComplete === true || summary.datasetMetadata?.pagination?.complete === true;
    const incomplete = summary.collectionMayBeIncomplete ? ' Pagination belum terbukti lengkap.' : completed ? ' Pagination teramati lengkap.' : '';
    const apiMismatch = summary.datasetMetadata?.count_discrepancy?.reported_vs_retrieved;
    const resultSite = result.projectSiteProfile || policy.site;
    const resultSiteName = AcquisitionPolicy?.labelForSite(resultSite) || SITE_PROFILE_DEFS[resultSite]?.label || 'Sumber';
    const countBasis = resultSite === 'tiket' ? 'totalElements' : resultSite === 'agoda' ? 'totalIndex' : resultSite === 'trip' ? 'totalCountForPage' : resultSite === 'booking' ? 'reviewsCount' : 'getReviewCount';
    const mismatchNote = apiMismatch != null && Number(apiMismatch) !== 0
      ? ` ${countBasis} berbeda ${Number(apiMismatch).toLocaleString('id-ID')} dari record canonical yang terekam di HAR; selisih dipakai sebagai indikator coverage.`
      : '';
    const excludedPartners = Number(summary.datasetMetadata?.partner_records_excluded_from_canonical || 0);
    const providerNote = resultSite === 'agoda' && excludedPartners > 0
      ? ` ${excludedPartners.toLocaleString('id-ID')} review provider partner dipertahankan di Data Asli tetapi tidak dimasukkan ke Hasil Cleaning Agoda.`
      : '';
    const completionLabel = summary.collectionMayBeIncomplete ? 'selesai — HAR parsial' : 'selesai';
    setStatus(`HAR/Network ${resultSiteName} ${completionLabel}: ${Number(summary.files || 0).toLocaleString('id-ID')} file · ${Number(summary.rawReviews || 0).toLocaleString('id-ID')} record sumber → ${Number(summary.cleanReviews || result.totalRows || 0).toLocaleString('id-ID')} record hasil.${incomplete}${providerNote}${mismatchNote}`);
    }
  } catch (error) {
    advanceRuntimeFlow({ stage: 'error', message: `Proses HAR/Network gagal: ${error.message}` });
    setStatus(`Proses HAR/Network gagal: ${error.message}`);
    const action = await showAcquisitionFailureDialog({ message:error.message, stage:state.runtimeFlow.failureStage || state.runtimeFlow.lastOperationalStage || 'extracting', collected:state.runtimeFlow.rows||0, method:'network-json' });
    retryAgain = action === 'retry';
  } finally {
    setRunningUi(false);
    await refreshRecoverableRun();
    await renderHistoryWorkspace();
  }
  if (retryAgain) return processStagedNetworkJson();
}


function renderSiteOptionsForMethod() {
  const select = $('siteProfile');
  if (!select) return;
  const method = resolvedAcquisitionMethod();
  const allowed = AcquisitionPolicy?.allowedSites(method) || ['traveloka','tiket','agoda','trip','booking'];
  let current = AcquisitionPolicy?.normalizedSite(state.project.siteProfile || '', { url: state.project.startUrl || state.project.source?.sourceUrl || '' }) || '';

  if (!allowed.includes(current)) {
    current = '';
    state.project.siteProfile = 'auto';
  }

  select.innerHTML = '';
  select.disabled = method === 'network-json';
  if (!current) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = method === 'network-json' ? 'Otomatis dari HAR' : 'Pilih website';
    placeholder.disabled = true;
    placeholder.selected = !current;
    select.appendChild(placeholder);
  }
  for (const site of allowed) {
    const option = document.createElement('option');
    option.value = site;
    option.textContent = AcquisitionPolicy?.labelForSite(site) || SITE_PROFILE_DEFS[site]?.label || site;
    option.selected = site === current;
    select.appendChild(option);
  }
  if (current) select.value = current;
}

function renderSiteProfile() {
  renderSiteOptionsForMethod();
  const effective = effectiveSiteProfile();
  const method = resolvedAcquisitionMethod();
  const label = SITE_PROFILE_DEFS[effective]?.label || 'Pilih website';
  if ($('siteProfileHelp')) $('siteProfileHelp').textContent = '';
  if ($('acquisitionMethodHelp')) $('acquisitionMethodHelp').textContent = '';
  renderNetworkImportStage();
}

function updateSiteProfileFromUrl({ silent = false } = {}) {
  if (!state.project) return;
  const detected = detectSiteProfileFromUrl(currentBrowserUrl() || state.project.startUrl || '');
  const method = resolvedAcquisitionMethod();
  if (method === 'dom' && ['tiket','agoda','trip'].includes(detected)) {
    state.project.siteProfile = detected;
  } else if (method === 'dom' && ['traveloka','booking'].includes(detected)) {
    state.project.siteProfile = detected;
    state.project.acquisition = { ...(state.project.acquisition || {}), method: 'network-json', scope: 'all' };
    if (!silent) setStatus(`${SITE_PROFILE_DEFS[detected]?.label || detected} tidak tersedia pada DOM; metode dialihkan ke HAR / Network.`);
  } else if (method === 'network-json' && ['traveloka','tiket','agoda','trip','booking'].includes(detected)) {
    state.project.siteProfile = detected;
  }
  renderSiteProfile(); renderAcquisition();
  if (!silent) {
    const profile = effectiveSiteProfile();
    if (!(method === 'dom' && ['traveloka','booking'].includes(detected))) setStatus(profile === 'generic' ? 'Pilih website.' : `Website: ${SITE_PROFILE_DEFS[profile]?.label || profile}.`);
  }
}
async function openPaginationDialog(info) {
  const attrs = info.attributes || {};
  const tag = info.tag || 'button';
  const candidates = [];
  const contextSelector=String(info.paginationContext?.selector||'').trim();
  const sourceHost=(()=>{try{return new URL(browser.getURL()||state.project.startUrl||'').hostname.toLowerCase();}catch{return'';}})();
  const tripHost=/(^|\.)trip\.com$/i.test(sourceHost);
  const overbroadPaginationSelector = selector => {
    const raw=String(selector||'').trim();
    const compact=raw.replace(/\s+/g,' ');
    if(/^(?:a|button|li|span|\[role=(?:"|')?(?:button|link)(?:"|')?\])$/i.test(compact.replace(/\s+/g,'')))return true;
    // Trip CSS-module pagination frequently yields `context ul a`. It is useful for
    // discovering the cluster, but too broad to persist as an actionable Next
    // fallback because the same selector also matches page numbers and ellipsis.
    if(/(?:^|[>+~\s])(?:ul|ol|nav)(?:[^,]*)\s+(?:a|button)$/i.test(compact)){
      const tail=(compact.match(/(?:a|button)$/i)||[])[0]||'';
      if(tail&&!/\[(?:data-|aria-|rel)|\.[A-Za-z_-]|:(?:nth|last|first|has|not|is)\b/i.test(tail))return true;
    }
    return false;
  };
  const quote = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  for (const attr of ['data-element-name','data-testid','data-selenium','aria-label','title']) {
    const value = attrs[attr];
    if (!value || String(value).length > 160) continue;
    candidates.push(`${tag}[${attr}="${quote(value)}"]`);
    candidates.push(`[${attr}="${quote(value)}"]`);
  }
  if (info.reusableSelector) candidates.push(info.reusableSelector);
  if (info.selector) candidates.push(info.selector);

  const scopedCandidates=contextSelector
    ? candidates.filter(Boolean).map(selector=>`${contextSelector} ${selector}`)
    : [];

  const tested = [];
  for (const selector of [...new Set([...scopedCandidates,...candidates].filter(Boolean))]) {
    try {
      const count = await browser.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`, true);
      tested.push({ selector, count: Number(count || 0) });
    } catch {}
  }
  // Trip sering menghasilkan kandidat global/descendant seperti `a` atau `... ul a`.
  // Simpan hanya kandidat yang cukup spesifik. Selector broad dipakai runtime hanya
  // sebagai discovery cluster dan tidak disimpan sebagai tombol Next yang dipercaya.
  const safeTested = tripHost
    ? tested.filter(x => !overbroadPaginationSelector(x.selector))
    : tested;
  const rankedTested = safeTested.length ? safeTested : tested;
  const stable = rankedTested.find(x => x.count === 1 && /data-element-name|data-testid|data-selenium|aria-label|title/.test(x.selector))
    || rankedTested.find(x => x.count === 1)
    || rankedTested.find(x => x.count > 0)
    || { selector: info.selector || '', count: 0 };
  const selectors = [stable.selector, ...rankedTested.map(x => x.selector)]
    .filter(Boolean)
    .filter(selector => !tripHost || selector === stable.selector || !overbroadPaginationSelector(selector));
  state.pendingPagination = {
    selector: stable.selector,
    selectors: [...new Set(selectors)],
    count: stable.count,
    text: info.text || '',
    tag,
    attributes: attrs,
    contextSelector,
    contextKind: info.paginationContext?.kind || '',
    sourceHost
  };
  $('paginationPickedText').textContent = info.text ? `Tombol: “${info.text.slice(0, 100)}”` : `Elemen ${tag}`;
  $('paginationQualityBadge').textContent = `${stable.count || 0} cocok`;
  $('paginationPreview').innerHTML = `<b>${escapeHtml(info.text || attrs['aria-label'] || 'Tombol navigasi')}</b><span>${stable.count === 1 ? `Tombol unik ditemukan${contextSelector?' di dalam area pagination/review yang sama':''}. MyDataset menyimpan scope ini agar tidak berpindah ke fasilitas, galeri, atau carousel.` : `${stable.count} elemen cocok; periksa outline pada halaman.`}</span>`;
  $('paginationDialogSelector').textContent = stable.selector;
  highlightInBrowser({ type: 'selector', selector: stable.selector, color: '#d8a542' });
  $('paginationDialog').showModal();
}

function applyPendingPagination() {
  const pending = state.pendingPagination;
  if (!pending?.selector) return;
  state.project.pagination.selector = pending.selector;
  state.project.pagination.selectors = pending.selectors || [pending.selector];
  state.project.pagination.meta = {
    text: pending.text || '',
    countAtSelection: pending.count || 0,
    tag: pending.tag || 'button',
    attributes: pending.attributes || {},
    contextSelector: pending.contextSelector || '',
    contextKind: pending.contextKind || '',
    sourceHost: pending.sourceHost || ''
  };
  renderPagination();
  scheduleAutosave();
  setStatus(`Tombol navigasi disimpan${pending.contextSelector?' bersama scope area review/pagination':''}. Runner hanya akan memilih kontrol yang sesuai dengan halaman sumber.`);
}

async function detectContainerSelector(fullSelector) {
  try {
    return await browser.executeJavaScript(String.raw`(() => {
      const target = document.querySelector(${JSON.stringify(fullSelector)});
      if (!target) return { selector: ${JSON.stringify(generalizeItemSelector(fullSelector))}, count: 0 };
      const esc = v => (globalThis.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&');
      const candidates = [];
      for (const attr of ['data-testid','data-test','data-qa','data-element-name','data-selenium','itemprop','role']) {
        const value = target.getAttribute(attr);
        if (value) candidates.push(target.tagName.toLowerCase()+'['+attr+'="'+String(value).replace(/"/g,'\\\\"')+'"]');
      }
      const classes = [...target.classList].filter(c => c.length < 90);
      for (let n = Math.min(classes.length, 3); n >= 1; n--) candidates.push(target.tagName.toLowerCase()+'.'+classes.slice(0,n).map(esc).join('.'));
      candidates.push(${JSON.stringify(generalizeItemSelector(fullSelector))});
      let best = { selector: candidates[candidates.length-1], count: 0, score: -Infinity };
      for (const selector of [...new Set(candidates)]) {
        try {
          const count = document.querySelectorAll(selector).length;
          if (!count) continue;
          const score = (count >= 2 && count <= 200 ? 1000 : 0) + Math.min(count,100) - selector.length * 0.08;
          if (score > best.score) best = { selector, count, score };
        } catch {}
      }
      return best;
    })()`, true);
  } catch {
    return { selector: generalizeItemSelector(fullSelector), count: 0 };
  }
}

function effectiveRecordContext(rootSelector = '') {
  const pending = state.pendingInferredContainer && state.pendingInferredContainer.selector === rootSelector
    ? state.pendingInferredContainer : null;
  // Saat dialog sedang memulihkan boundary lama yang terlalu lebar, metadata ID
  // milik boundary lama tidak boleh dipakai untuk menghitung preview boundary baru.
  // Commit tetap terjadi hanya di addFieldFromDialog; fungsi ini sekadar memastikan
  // preview memakai identitas data-review-id milik record semantik yang diusulkan.
  const replacing = Boolean(pending?.replaceActive);
  const keyAttribute = replacing
    ? (pending?.keyAttribute || '')
    : (state.project.itemKeyAttribute || pending?.keyAttribute || '');
  const identity = replacing
    ? (pending?.identity || state.detectedContainerIdentity || null)
    : (state.project.itemIdentity || state.project.itemMeta?.identity || pending?.identity || state.detectedContainerIdentity || null);
  return { keyAttribute, identity };
}

async function computeRelativeSelector(fullSelector, itemSelector) {
  if (!itemSelector) return { selector: fullSelector, matches: 0, total: 0, ambiguous: 0, mismatched: 0, targetSignature: '' };
  try {
    return await browser.executeJavaScript(String.raw`(() => {
      const all=[...document.querySelectorAll(${JSON.stringify(itemSelector)})];
      const detectKey=(roots)=>{
        const attrs=['data-review-id','data-comment-id','data-writing-id','data-submit-id','data-item-id','data-product-id','data-result-id','data-record-id','data-id','data-key','id'];
        let best=null;
        for(const attr of attrs){
          const vals=roots.map(r=>r.getAttribute(attr)).filter(Boolean);
          if(vals.length/Math.max(1,roots.length)<0.8) continue;
          const unique=new Set(vals); if(unique.size<2) continue;
          const savings=vals.length-unique.size;
          const score=(attr.startsWith('data-')?50:10)+(savings>0?120+savings*3:0)+unique.size;
          if(!best||score>best.score) best={attr,score};
        }
        return best?.attr||null;
      };
      const configuredKey=${JSON.stringify(effectiveRecordContext(itemSelector).keyAttribute || '')};
      const actualIdentity=${JSON.stringify(effectiveRecordContext(itemSelector).identity || null)};
      const actualKey=configuredKey || (!actualIdentity ? detectKey(all) : '');
      const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
      const identityValue=(root)=>{if(actualKey)return root.getAttribute(actualKey);if(!actualIdentity)return null;if(actualIdentity.mode==='containerAttribute')return root.getAttribute(actualIdentity.attribute||'');if(actualIdentity.mode==='containerJsonAttribute'){try{return getPath(JSON.parse(root.getAttribute(actualIdentity.attribute||'')||'null'),actualIdentity.jsonPath||'');}catch{return null;}}return null;};
      const target=document.querySelector(${JSON.stringify(fullSelector)});
      const rootScore=(r)=>{if(!r||!r.isConnected)return-100000;let score=(target&&r.contains(target))?100000:0;try{let n=r,hidden=false;for(let d=0;n&&n.nodeType===1&&d<18;d++,n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)===0){hidden=true;break;}if(n.getAttribute?.('aria-hidden')==='true')score-=2200;}score+=hidden?-12000:1000;const b=r.getBoundingClientRect();if(b.width>1&&b.height>1){score+=700;if(b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth)score+=650;}else score-=1800;score+=Math.min(220,String(r.innerText||r.textContent||'').trim().length*.05);}catch{}return score;};
      const grouped=new Map(),loose=[];all.forEach((r,index)=>{const k=identityValue(r);if(k==null||String(k)===''){loose.push({index,r});return;}const key=String(k);if(!grouped.has(key))grouped.set(key,{index,list:[]});grouped.get(key).list.push(r);});
      const renderedLoose=loose.filter(({r})=>rootScore(r)>-5000);const picked=renderedLoose.length?renderedLoose:[...loose];for(const g of grouped.values()){const r=g.list.sort((a,b)=>rootScore(b)-rootScore(a))[0];if(r)picked.push({index:g.index,r});}picked.sort((a,b)=>a.index-b.index);const roots=picked.map(x=>x.r);
      if (!target || !roots.length) return { selector:${JSON.stringify(fullSelector)},matches:0,total:roots.length,ambiguous:0,mismatched:0,targetSignature:'' };
      const root=target.closest(${JSON.stringify(itemSelector)});
      if (!root) return { selector:${JSON.stringify(fullSelector)},matches:0,total:roots.length,ambiguous:0,mismatched:0,targetSignature:'' };
      const esc=v=>(globalThis.CSS&&CSS.escape)?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,'\\$&');
      const q=v=>String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
      const sibling=(el)=>{const p=el.parentElement;if(!p)return el.tagName.toLowerCase();const same=[...p.children].filter(x=>x.tagName===el.tagName);if(same.length<=1)return el.tagName.toLowerCase();const i=same.indexOf(el)+1;return i===same.length?el.tagName.toLowerCase()+':last-of-type':el.tagName.toLowerCase()+':nth-of-type('+i+')';};
      const marker=(el,limit)=>{
        let cur=el;
        for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){
          for(const node of [cur,...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')]){
            if(!node) continue;
            for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=node.getAttribute?.(a); if(v && /(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name|member|membership|loyalty|tier|badge|level)/i.test(v)) return {signature:a+'='+v,selector:'['+a+'="'+q(v)+'"]',carrier:cur};}
            for(const c of [...(node.classList||[])]){if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score|member|membership|loyalty|tier|badge|level)/i.test(c)) return {signature:'class='+c,selector:'.'+esc(c),carrier:cur};}
          }
        }
        return null;
      };
      const signature=(el,limit)=>{if(!el)return '';for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=el.getAttribute?.(a);if(v)return a+'='+v;}const m=marker(el.parentElement||el,limit);return m?.signature||'';};
      const targetSignature=signature(target,root);
      const cleanText=el=>String(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();
      const tripHost=/(?:^|\.)(?:trip|ctrip)\.com$/i.test(String(location.hostname||''));
      const tripMonth='(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
      const isReviewDate=el=>{if(!el)return false;const txt=cleanText(el),classes=Array.from(el.classList||[],v=>String(v).toLowerCase());if(tripHost){if(new RegExp('^'+tripMonth+'\\s+\\d{4}$','i').test(txt)||new RegExp('^(?:menginap(?:\\s+pada)?|stayed?(?:\\s+(?:in|during))?|stay(?:\\s+(?:in|during))?)\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt))return false;if(new RegExp('^\\d{1,2}\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt))return true;if(/^(?:reviewed|posted)\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return true;if(/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt))return true;return false;}if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(txt))return true;if(classes.some(v=>/reviewitem-userreviewtime|review.*(?:date|time)|reviewcard.*date/i.test(v)))return true;if(/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(txt))return true;if(/^(?:\d{1,2}\s+)?(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|okt|nov|dec|des)\s+\d{4}$/i.test(txt))return true;if(/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return true;return false;};
      const semanticFlexibleRole=isReviewDate(target)?'review_date':'';
      if(target===root) return {selector:':scope',matches:roots.length,total:roots.length,ambiguous:0,mismatched:0,targetSignature};
      const candidates=[];
      if(semanticFlexibleRole==='review_date')candidates.push('.Review-statusBar-left span','[class*="ReviewCard_date__"]','[class*="ReviewCard_date"]','[class*="reviewItem-userReviewTime"]','[class*="userReviewTime"]','[class*="reviewTime"]','time');
      for (const attr of ['data-testid','data-test','data-qa','data-element-name','data-selenium','itemprop','name','aria-label','role']) { const value=target.getAttribute(attr); if(value) candidates.push(target.tagName.toLowerCase()+'['+attr+'="'+q(value)+'"]'); }
      // Keep opaque/CSS-module classes as candidates and let cross-record cardinality decide.
      const rawClasses=[...target.classList].filter(c=>c&&c.length<=120&&!/^(active|selected|hover|focus|open|show|hidden|disabled)$/i.test(c));
      const classFamily=c=>{const raw=String(c||'');if(!raw.includes('__'))return'';const base=raw.split('__')[0],tail=base.split('_').pop()||'';return tail.length>=5&&/(review|rating|score|user|guest|author|country|room|travell|date|time|content|comment|title|label|count|member|membership|loyalty|tier|badge|level)/i.test(tail)?tail+'__':'';};
      for(const c of rawClasses.slice(0,6)){candidates.push(target.tagName.toLowerCase()+'.'+esc(c));candidates.push('.'+esc(c));const fam=classFamily(c);if(fam){candidates.push(target.tagName.toLowerCase()+'[class*="'+q(fam)+'"]');candidates.push('[class*="'+q(fam)+'"]');}}
      if(rawClasses.length>=2)candidates.push(target.tagName.toLowerCase()+'.'+rawClasses.slice(0,2).map(esc).join('.'));
      const anchored=marker(target.parentElement||target,root);
      if(anchored?.carrier && anchored.carrier!==target){const carrierTag=anchored.carrier.tagName.toLowerCase(),targetTag=target.tagName.toLowerCase();candidates.push(carrierTag+':has(> '+anchored.selector+') > '+targetTag);const tcls=rawClasses.slice(0,1);if(tcls.length)candidates.push(carrierTag+':has(> '+anchored.selector+') > '+targetTag+'.'+esc(tcls[0]));}
      const info=target.closest('[data-info-type]'); if(info&&root.contains(info)){const v=info.getAttribute('data-info-type');candidates.push('[data-info-type="'+q(v)+'"] '+sibling(target));if(target.tagName.toLowerCase()==='strong')candidates.push('[data-info-type="'+q(v)+'"] strong');}
      const path=[];let cur=target;while(cur&&cur!==root){let part=sibling(cur);for(const attr of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=cur.getAttribute(attr);if(v){part=cur.tagName.toLowerCase()+'['+attr+'="'+q(v)+'"]';break;}}path.unshift(part);cur=cur.parentElement;}if(path.length){candidates.push(':scope > '+path.join(' > '));candidates.push(path.join(' > '));}
      const ranked=[];
      for(const selector of [...new Set(candidates.filter(Boolean))]){let matches=0,ambiguous=0,mismatched=0,single=0;for(const r of roots){try{let found=[...r.querySelectorAll(selector)];if(found.length>1&&semanticFlexibleRole==='review_date'&&tripHost){const dateOnly=found.filter(isReviewDate);if(dateOnly.length)found=dateOnly;}if(found.length>1){const visible=found.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)found=visible;}if(found.length)matches++;if(found.length===1)single++;if(found.length>1)ambiguous++;if(found.length===1&&targetSignature&&signature(found[0],r)!==targetSignature){const semanticEquivalent=semanticFlexibleRole==='review_date'&&isReviewDate(found[0]);if(!semanticEquivalent)mismatched++;}}catch{}}const ratio=roots.length?matches/roots.length:0;const singleRatio=roots.length?single/roots.length:0;const sem=selector.includes(':has(')?320:(/data-testid|data-info-type|data-element-name|data-selenium|rating|score|reviewtime|reviewcard_date|statusbar-left/i.test(selector)?100:0);const scopeBonus=selector.startsWith(':scope > ')?80:0;const semanticBonus=semanticFlexibleRole==='review_date'?120:0;const score=ratio*1000+singleRatio*700-ambiguous*700-mismatched*850+sem+scopeBonus+semanticBonus-selector.length*0.08;ranked.push({selector,matches,total:roots.length,ambiguous,mismatched,targetSignature,score});}
      ranked.sort((a,b)=>b.score-a.score);
      const best=ranked[0]||{selector:${JSON.stringify(fullSelector)},matches:0,total:roots.length,ambiguous:0,mismatched:0,targetSignature,score:-Infinity};
      return {...best,selectors:ranked.filter(x=>x.matches>0&&x.ambiguous===0).slice(0,8).map(x=>x.selector)};
    })()`, true);
  } catch {
    return { selector: fullSelector, matches: 0, total: 0, ambiguous: 0, mismatched: 0, targetSignature: '' };
  }
}
function generalizeItemSelector(selector) {
  return String(selector).replace(/:nth-of-type\(\d+\)/g, '');
}

function uniqueFieldName(base) {
  let name = String(base).replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
  let candidate = name;
  let index = 2;
  const used = new Set(state.project.fields.map(field => field.name));
  const internalIdentityName=(state.project.itemIdentity || state.pendingInferredContainer?.identity || state.project.itemMeta?.identity)?.suggestedName;
  if(internalIdentityName) used.add(internalIdentityName);
  while (used.has(candidate)) candidate = `${name}_${index++}`;
  return candidate;
}

function guessDataType(text, name = '') {
  const value = String(text || '').trim();
  const normalized = String(name || '').toLowerCase();
  if (/rating_label|label|title|reviewer|country|traveler|traveller|room_type|stay_detail|review_text|review_date_raw/.test(normalized)) return 'text';
  if (/date/.test(normalized)) return 'date';
  if (/rating_score|rating_max|max_score|rating_scale|score|price|amount|count|total/.test(normalized)) return 'number';
  if (/^-?\d{1,12}(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?$/.test(value)) return 'number';
  return 'text';
}

function guessTransform(text, name = '') {
  const value = String(text || '').trim();
  const normalized = String(name || '').toLowerCase();
  if (/rating_label|label|title|reviewer|country|traveler|traveller|room_type|stay_detail|review_text|date/.test(normalized)) return 'none';
  if (/rating_score|rating_max|max_score|rating_scale|score|price|amount|count|total/.test(normalized)) return 'extractNumber';
  if (/^-?\d{1,12}(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?$/.test(value)) return 'extractNumber';
  return 'none';
}

const OPTIONAL_PARTIAL_SEMANTIC_ROLES = new Set([
  'review_text','review_date','traveler_type','reviewer_country','room_type','stay_detail',
  'review_title','rating_label','rating_max','review_count'
]);
// Metadata Trip/OTA ini ditentukan oleh konteks semantik (ikon/data-info-type),
// bukan posisi sibling. Jika satu record tidak memiliki metadata tersebut, hasilnya
// harus null; selector tidak boleh bergeser dan mengambil metadata tetangganya.
const CONTEXT_BOUND_SEMANTIC_ROLES = new Set([
  'reviewer_country','room_type','traveler_type','stay_detail'
]);

function fieldValidationRole(name = '', explicitRole = '') {
  return String(explicitRole || semanticRoleFromFieldName(name) || '');
}

function isStrictFieldValidation(name = '', explicitRole = '', required = false) {
  // review_text must exist as a configured field for review projects, but an
  // individual review may legitimately contain only a rating. Missing comments
  // are therefore null unless the user explicitly marks the field as required.
  return Boolean(required);
}

function stableOptionalSemanticField({ name = '', role = '', required = false, matches = 0, total = 0, ambiguous = 0, mismatched = 0 } = {}) {
  const effectiveRole = fieldValidationRole(name, role);
  if (isStrictFieldValidation(name, effectiveRole, required)) return false;
  if (!OPTIONAL_PARTIAL_SEMANTIC_ROLES.has(effectiveRole)) return false;
  const m = Number(matches || 0), t = Number(total || 0), a = Number(ambiguous || 0), mm = Number(mismatched || 0);
  if (mm > 0 || t < 2 || m < 2) return false;
  // Optional metadata may legitimately be absent or ambiguous on a minority of records.
  // We accept only a stable majority; unresolved records stay null in preview/runner.
  return m / t >= 0.6 && m + a <= t;
}

function canAcceptPartialSemanticField(options = {}) {
  const m=Number(options.matches||0), t=Number(options.total||0), a=Number(options.ambiguous||0);
  return stableOptionalSemanticField(options) && (a > 0 || (t > 0 && m < t));
}

function fieldSelectionIsValid({ name = '', role = '', required = false, matches = 0, total = 0, ambiguous = 0, mismatched = 0 } = {}) {
  const m = Number(matches || 0), t = Number(total || 0), a = Number(ambiguous || 0), mm = Number(mismatched || 0);
  if (m <= 0 || mm > 0) return false;
  if (isStrictFieldValidation(name, role, required)) return a === 0 && (t <= 0 || m === t);
  const effectiveRole=fieldValidationRole(name, role);
  if (OPTIONAL_PARTIAL_SEMANTIC_ROLES.has(effectiveRole)) {
    // Optional metadata is best-effort, not arbitrary. A stable majority is required
    // whether the minority is missing or genuinely ambiguous.
    if (t <= 0) return m >= 1 && a === 0;
    return stableOptionalSemanticField({ name, role:effectiveRole, required, matches:m, total:t, ambiguous:a, mismatched:mm });
  }
  return a === 0;
}

function previewDiagnosticIsCritical(diagnostic, field) {
  const d = diagnostic || {};
  const f = field || {};
  const role = fieldValidationRole(f.name || d.name, f.semanticRole || '');
  const required = Boolean(f.required || d.required);
  const missing = Number(d.missing || 0), ambiguous = Number(d.ambiguous || 0);
  const actualCoverage = Number.isFinite(Number(d.actualCoverage)) ? Number(d.actualCoverage) : null;
  const coverageDrop = Number(d.coverageDrop || 0);
  if (Boolean(d.semanticCritical)) return true;
  if (isStrictFieldValidation(f.name || d.name, role, required)) {
    return ambiguous > 0 || missing > 0 || coverageDrop > 0.15;
  }
  if (OPTIONAL_PARTIAL_SEMANTIC_ROLES.has(role)) {
    if (actualCoverage != null) return actualCoverage < 0.6;
    return false;
  }
  return ambiguous > 0 || coverageDrop > 0.15 || (required && missing > 0);
}
async function updateFieldPreview(rootOverride = null, expectedRevision = state.fieldDialogRevision) {
  if (expectedRevision !== state.fieldDialogRevision || !$('fieldDialog').open) return;
  const activeRootSelector = rootOverride || state.project.itemSelector || state.pendingInferredContainer?.selector || '';
  const fieldName=$('fieldNameInput').value.trim();
  const nameRole=semanticRoleFromFieldName(fieldName);
  const rawSelector = $('fieldSelectorInput').value.trim();
  const clickedRole=String(state.fieldTargetMeta?.semanticRole||'');
  const initial=state.fieldInitialValidation||{};
  const broadSelection=!rawSelector||rawSelector===':scope'||Number(initial.matches||0)===0||String(state.fieldTargetMeta?.pickedText||'').length>220;
  const nameRoleSelectors=nameRole?semanticFallbackSelectors(nameRole):[];
  const selectorMatchesNameRole=Boolean(nameRole&&rawSelector&&nameRoleSelectors.includes(rawSelector));
  // Nama kolom adalah label output dan tidak boleh mengganti target DOM yang stabil.
  // Namun bila klik awal terbukti terlalu luas/tidak terbaca, atau preview sudah
  // memulihkan selector yang memang termasuk semantic role tersebut, semantic name
  // menjadi recovery intent dan mengalahkan semanticRole stale yang terbawa dari klik.
  const semanticRecoveryIntent=Boolean(nameRole&&(broadSelection||selectorMatchesNameRole)&&nameRole!==clickedRole);
  const effectiveRole=((broadSelection||selectorMatchesNameRole)&&nameRole)?nameRole:(clickedRole||(broadSelection?nameRole:''));
  const semanticSelectors=effectiveRole?semanticFallbackSelectors(effectiveRole):[];
  const selector = rawSelector || semanticSelectors[0] || '';
  if (!activeRootSelector || (!selector && !effectiveRole)) {
    setFieldQuality(0, 0, 0, 0);
    $('fieldPreview').innerHTML = '<span class="muted">Pola data belum dapat diuji.</span>';
    return;
  }
  if (!rawSelector && selector) $('fieldSelectorInput').value = selector;
  const extract = $('fieldExtractInput').value;
  const attribute = $('fieldAttributeInput').value.trim();
  const jsonPath = $('fieldJsonPathInput').value.trim();
  let expectedSignature = state.fieldExpectedSignature || '';
  const fallbackSelectors=[...new Set([selector,...state.fieldCandidateSelectors,...semanticSelectors].filter(Boolean))].slice(0,18);
  state.fieldCandidateSelectors=[...new Set([selector,...state.fieldCandidateSelectors,...semanticSelectors].filter(Boolean))].slice(0,18);
  let targetMeta={...(state.fieldTargetMeta || {})};
  targetMeta={...targetMeta,semanticRole:effectiveRole};
  if(broadSelection&&effectiveRole){
    expectedSignature='';
    targetMeta={...targetMeta,tag:'',classes:[],semanticRole:effectiveRole};
  }
  state.fieldSemanticRoleUsed=effectiveRole;
  state.fieldSemanticRecovered=semanticRecoveryIntent;
  // review_date is semantic-first as well. OTA pages (notably Agoda) may render
  // the same field with a value-bearing/dynamic signature per review, so the semantic
  // role is more stable than the exact signature captured from the first card.
  const semanticFlexibleRole=effectiveRole==='review_date';
  if(semanticFlexibleRole) expectedSignature='';
  const semanticFirst=Boolean(state.fieldSemanticRecovered || CONTEXT_BOUND_SEMANTIC_ROLES.has(effectiveRole) || semanticFlexibleRole || (effectiveRole==='review_text' && effectiveSiteProfile()==='tiket'));
  const context=effectiveRecordContext(activeRootSelector);
  const runPrimary=async()=>browser.executeJavaScript(String.raw`(() => {
      const all=[...document.querySelectorAll(${JSON.stringify(activeRootSelector)})];
      const keyAttr=${JSON.stringify(context.keyAttribute || '')};
      const identity=${JSON.stringify(context.identity || null)};
      const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
      const parseJson=(raw)=>{try{return raw==null?null:JSON.parse(raw);}catch{return null;}};
      const rootKey=(root)=>{if(keyAttr)return root.getAttribute(keyAttr);if(!identity)return null;if(identity.mode==='containerAttribute')return root.getAttribute(identity.attribute||'');if(identity.mode==='containerJsonAttribute')return getPath(parseJson(root.getAttribute(identity.attribute||'')),identity.jsonPath||'');return null;};
      const rootScore=(r)=>{if(!r||!r.isConnected)return-100000;let score=0;try{let n=r,hidden=false;for(let d=0;n&&n.nodeType===1&&d<18;d++,n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)===0){hidden=true;break;}if(n.getAttribute?.('aria-hidden')==='true')score-=2200;}score+=hidden?-12000:1000;const b=r.getBoundingClientRect();if(b.width>1&&b.height>1){score+=700;if(b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth)score+=650;}else score-=1800;score+=Math.min(220,String(r.innerText||r.textContent||'').trim().length*.05);}catch{}return score;};
      const grouped=new Map(),loose=[];all.forEach((r,index)=>{const k=rootKey(r);if(k==null||String(k)===''){loose.push({index,r});return;}const key=String(k);if(!grouped.has(key))grouped.set(key,{index,list:[]});grouped.get(key).list.push(r);});const renderedLoose=loose.filter(({r})=>rootScore(r)>-5000);const picked=renderedLoose.length?renderedLoose:[...loose];for(const g of grouped.values()){const r=g.list.sort((a,b)=>rootScore(b)-rootScore(a))[0];if(r)picked.push({index:g.index,r});}picked.sort((a,b)=>a.index-b.index);const roots=picked.map(x=>x.r);
      const selectors=${JSON.stringify(fallbackSelectors)},roleSelectors=${JSON.stringify(semanticSelectors)},semanticFirst=${JSON.stringify(semanticFirst)},semanticFlexibleRole=${JSON.stringify(semanticFlexibleRole)},extract=${JSON.stringify(extract)},attribute=${JSON.stringify(attribute)},jsonPath=${JSON.stringify(jsonPath)},expected=${JSON.stringify(expectedSignature)},targetMeta=${JSON.stringify(targetMeta)},fieldName=${JSON.stringify(fieldName)};
      const marker=(el,limit)=>{let cur=el;for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){const children=[];try{children.push(...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]'));}catch{}for(const node of [cur,...children]){if(!node)continue;for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=node.getAttribute&&node.getAttribute(a);if(v&&/(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name|member|membership|loyalty|tier|badge|level)/i.test(v))return a+'='+v;}for(const c of Array.from(node.classList||[]))if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score|member|membership|loyalty|tier|badge|level)/i.test(c))return 'class='+c;}}return '';};
      const signature=(el,root)=>{if(!el)return '';for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=el.getAttribute&&el.getAttribute(a);if(v)return a+'='+v;}return marker(el.parentElement||el,root);};
      const roleOf=(el,root)=>{
        if(!el)return'';
        const txt=String(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
        // Test each class independently. Joining CSS-module classes lets a broad regex
        // start at "ReviewCard_*" and finish at the unrelated utility class "Text_text__*".
        const classTokens=Array.from(el.classList||[],value=>String(value).toLowerCase());
        const hasClass=pattern=>classTokens.some(value=>pattern.test(value));
        const sig=signature(el,root).toLowerCase();
        const testid=String(el.getAttribute?.('data-testid')||'').toLowerCase();
        const infoCarrier=el.closest?.('[data-info-type]');
        const infoType=String(infoCarrier?.getAttribute?.('data-info-type')||'').toLowerCase();
        const tripHost=/(?:^|\.)(?:trip|ctrip)\.com$/i.test(String(location.hostname||''));
        const tripMonth='(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
        const tripBareStayMonth=tripHost&&new RegExp('^'+tripMonth+'\\s+\\d{4}$','i').test(txt);
        const tripStayDetail=tripHost&&(tripBareStayMonth||new RegExp('^(?:menginap(?:\\s+pada)?|stayed?(?:\\s+(?:in|during))?|stay(?:\\s+(?:in|during))?)\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt));
        const tripFullReviewDate=tripHost&&(new RegExp('^\\d{1,2}\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^(?:reviewed|posted)\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt));
        const tripTranslationResidual=tripHost?txt.replace(/(?:teks\s+asli|original\s+text|laporkan\s+masalah\s+terjemahan|report\s+translation\s+issue|diterjemahkan\s+oleh\s+ai|translated\s+by\s+ai|terj[ea]mahan\s+disediakan\s+oleh\s+google|translation\s+provided\s+by\s+google)/giu,' ').replace(/[|·•\s]+/g,' ').trim():txt;
        if(tripHost&&tripTranslationResidual!==txt&&tripTranslationResidual.length<2)return'';
        if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(txt)&&txt.length<=120)return'';
        if(testid==='review-title')return'review_title';
        if(testid==='review-comment'||testid==='review-text')return'review_text';
        if(testid==='product-name')return'product_name';
        if(testid==='price')return'price';
        if(testid==='description')return'description';
        if(testid==='stock')return'stock';
        if(testid==='rating')return'rating_score';
        if(infoType==='reviewer-name'){if(el.closest?.('strong'))return'reviewer_name';if(String(el.tagName||'').toLowerCase()==='span')return'reviewer_country';return'reviewer_name';}
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
        if((!tripHost&&hasClass(/userreviewtime|review.*(?:date|time)|reviewcard.*date/))||/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(txt)||/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return'review_date';
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
      const cleanUiText=value=>{let text=String(value==null?'':value).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();const labels=['tampilkan lebih sedikit','tampilkan lebih banyak','lihat lebih sedikit','lihat lebih banyak','baca lebih sedikit','baca lebih banyak','tampilkan selengkapnya','lihat selengkapnya','baca selengkapnya','continue reading','show less','show more','see less','see more','view less','view more','read less','read more','selengkapnya'].sort((a,b)=>b.length-a.length);let changed=true;while(changed&&text){changed=false;for(const label of labels){const escaped=label.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');const next=text.replace(new RegExp('(?:\\s*(?:\\.{2,}|\\u2026+|[·•|–—-]+)\\s*)?'+escaped+'\\s*$','iu'),'').trim();if(next!==text){text=next;changed=true;break;}}}return text;};
      const read=(root,el)=>{if(['containerAttribute','containerJsonAttribute'].includes(extract))el=root;if(!el)return null;if(extract==='href')return el.href||el.getAttribute('href')||'';if(extract==='src')return el.src||el.getAttribute('src')||'';if(extract==='html')return el.innerHTML||'';if(extract==='value')return 'value' in el?el.value:(el.getAttribute('value')||'');if(extract==='attribute'||extract==='containerAttribute')return attribute?el.getAttribute(attribute):null;if(extract==='jsonAttribute'||extract==='containerJsonAttribute')return getPath(parseJson(attribute?el.getAttribute(attribute):null),jsonPath);return cleanUiText(el.innerText||el.textContent||'');};
      const classes=new Set((targetMeta.classes||[]).map(String));const wantedRole=String(targetMeta.semanticRole||'');
      const resolve=(root)=>{
        if(['containerAttribute','containerJsonAttribute'].includes(extract)) return {el:root,selectorUsed:':scope',candidateCount:1,signature:''};
        // Semantic intent wins over a brittle click selector once the record boundary is locked.
        // Try role-specific selectors directly inside each record before applying click metadata.
        if(semanticFirst&&wantedRole&&roleSelectors.length){
          const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)tiket\.com$/i.test(location.hostname));
          const semanticRoleMustMatch=contextBoundRole||semanticFlexibleRole;
          for(const sel of roleSelectors){let list=[];try{list=Array.from(root.querySelectorAll(sel));}catch{continue;}if(list.length!==1)continue;const el=list[0],detected=roleOf(el,root);if(semanticRoleMustMatch?detected===wantedRole:(!detected||detected===wantedRole))return{el,selectorUsed:sel,candidateCount:1,signature:signature(el,root),score:3000};}
        }
        let best=null;let maxCandidates=0;
        for(let i=0;i<selectors.length;i++){
          const sel=selectors[i];const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(sel);let list=[];try{list=sel===':scope'?[root]:Array.from(root.querySelectorAll(sel));}catch{continue;}
          maxCandidates=Math.max(maxCandidates,list.length);if(!list.length)continue;
          let candidates=list;
          if(targetMeta.tag){const byTag=candidates.filter(el=>el.tagName&&el.tagName.toLowerCase()===targetMeta.tag);if(byTag.length)candidates=byTag;}
          const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)tiket\.com$/i.test(location.hostname));
          if(expected){const bySig=candidates.filter(el=>signature(el,root)===expected);if(bySig.length)candidates=bySig;else if(semanticFlexibleRole){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}else if(!strictStructural||contextBoundRole)continue;}
          if(wantedRole&&(!strictStructural||contextBoundRole||semanticFlexibleRole)){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}
          if(classes.size&&candidates.length>1){const byClass=candidates.filter(el=>Array.from(classes).some(c=>el.classList&&el.classList.contains(c)));if(byClass.length)candidates=byClass;}
          if(candidates.length>1){const visible=candidates.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)candidates=visible;else{const pool=visible.length?visible:candidates;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)candidates=[pool[0]];}}if(candidates.length!==1)continue;
          const el=candidates[0];const sig=signature(el,root);let score=1200-i*35;
          if(expected)score+=semanticFlexibleRole?(roleOf(el,root)===wantedRole?220:-420):(sig===expected?500:-420);
          if(targetMeta.tag&&el.tagName&&el.tagName.toLowerCase()===targetMeta.tag)score+=120;
          if(classes.size){const overlap=Array.from(classes).filter(c=>el.classList&&el.classList.contains(c)).length;score+=Math.min(240,overlap*80);}
          if(sel.startsWith(':scope > '))score+=90;
          if(!best||score>best.score)best={el,selectorUsed:sel,candidateCount:list.length,signature:sig,score};
        }
        if(!best && wantedRole){
          // Last-resort semantic resolver deliberately ignores click tag/class/signature.
          // Once the record boundary is locked, finding exactly one element with the
          // requested role inside that record is stronger evidence than brittle CSS.
          let semantic=[];try{semantic=Array.from(root.querySelectorAll('*')).filter(el=>roleOf(el,root)===wantedRole);}catch{}
          if(semantic.length===1) best={el:semantic[0],selectorUsed:'@semantic:'+wantedRole,candidateCount:1,signature:signature(semantic[0],root),score:900};
        }
        return best||{el:null,selectorUsed:'',candidateCount:maxCandidates,signature:''};
      };
      let matches=0,ambiguous=0,mismatched=0,singleCandidate=0,maxCandidates=0;const values=[];const distinctValues=new Set();const selectorUsage={};
      roots.forEach((root,index)=>{const resolved=resolve(root);maxCandidates=Math.max(maxCandidates,resolved.candidateCount||0);if(resolved.el){matches++;singleCandidate++;selectorUsage[resolved.selectorUsed]=(selectorUsage[resolved.selectorUsed]||0)+1;if(expected&&resolved.signature&&resolved.signature!==expected){const semanticEquivalent=semanticFlexibleRole&&roleOf(resolved.el,root)===wantedRole;if(!semanticEquivalent)mismatched++;}}else if((resolved.candidateCount||0)>1)ambiguous++;const value=read(root,resolved.el);if(value!=null&&String(value).trim()!=='')distinctValues.add(String(value).trim());if(values.length<6)values.push({index:index+1,value,selectorUsed:resolved.selectorUsed});});
      const sampleValues=values.map(x=>String(x.value==null?'':x.value)).filter(Boolean);
      const semanticWarnings=[];const lname=String(fieldName||'').toLowerCase();
      const looksReviewCount=sampleValues.length&&sampleValues.every(v=>/^\s*\d+\s+(?:ulasan|review|reviews|komentar|comments?)\s*$/i.test(v));
      const looksNumber=sampleValues.length&&sampleValues.every(v=>/^\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?\s*$/i.test(v));
      const looksDate=sampleValues.length&&sampleValues.filter(v=>/(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).*\d{4}/i.test(v)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(v)).length>=Math.ceil(sampleValues.length*.6);
      if(/rating_label/.test(lname)&&looksReviewCount)semanticWarnings.push('Nilai terlihat seperti jumlah ulasan, bukan label rating. Pertimbangkan nama review_count.');
      if(/review_count/.test(lname)&&!looksReviewCount&&sampleValues.length)semanticWarnings.push('Nama field review_count, tetapi contoh nilai tidak terlihat seperti jumlah ulasan.');
      if(/rating_score|score/.test(lname)&&sampleValues.length&&!looksNumber)semanticWarnings.push('Nama field mengarah ke skor numerik, tetapi beberapa contoh nilai bukan angka/skor.');
      if(/review_date/.test(lname)&&sampleValues.length&&!looksDate)semanticWarnings.push('Nama field mengarah ke tanggal ulasan, tetapi contoh nilai tidak terlihat seperti tanggal.');
      const bestSelector=Object.entries(selectorUsage).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';return {matches,total:roots.length,ambiguous,mismatched,singleCandidate,maxCandidates,distinctValues:distinctValues.size,values,selectorsUsed:selectorUsage,bestSelector,semanticWarnings,validationMode:'full'};
    })()`, true);

  const runCompactFallback=async()=>browser.executeJavaScript(String.raw`(() => {
      const all=Array.from(document.querySelectorAll(${JSON.stringify(activeRootSelector)}));
      const keyAttr=${JSON.stringify(context.keyAttribute || '')};
      const identity=${JSON.stringify(context.identity || null)};
      const selectors=${JSON.stringify(fallbackSelectors)},roleSelectors=${JSON.stringify(semanticSelectors)},semanticFirst=${JSON.stringify(semanticFirst)},semanticFlexibleRole=${JSON.stringify(semanticFlexibleRole)};
      const extract=${JSON.stringify(extract)},attribute=${JSON.stringify(attribute)},jsonPath=${JSON.stringify(jsonPath)};
      const expected=${JSON.stringify(expectedSignature)},targetMeta=${JSON.stringify(targetMeta)},fieldName=${JSON.stringify(fieldName)};
      const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
      const parseJson=raw=>{try{return raw==null?null:JSON.parse(raw);}catch{return null;}};
      const idOf=root=>{if(keyAttr)return root.getAttribute(keyAttr);if(!identity)return null;if(identity.mode==='containerAttribute')return root.getAttribute(identity.attribute||'');if(identity.mode==='containerJsonAttribute')return getPath(parseJson(root.getAttribute(identity.attribute||'')),identity.jsonPath||'');return null;};
      const rootScore=(r)=>{if(!r||!r.isConnected)return-100000;let score=0;try{let n=r,hidden=false;for(let d=0;n&&n.nodeType===1&&d<18;d++,n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)===0){hidden=true;break;}if(n.getAttribute?.('aria-hidden')==='true')score-=2200;}score+=hidden?-12000:1000;const b=r.getBoundingClientRect();if(b.width>1&&b.height>1){score+=700;if(b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth)score+=650;}else score-=1800;score+=Math.min(220,String(r.innerText||r.textContent||'').trim().length*.05);}catch{}return score;};
      const grouped=new Map(),loose=[];all.forEach((r,index)=>{const id=idOf(r);if(id==null||String(id)===''){loose.push({index,r});return;}const key=String(id);if(!grouped.has(key))grouped.set(key,{index,list:[]});grouped.get(key).list.push(r);});const renderedLoose=loose.filter(({r})=>rootScore(r)>-5000);const picked=renderedLoose.length?renderedLoose:[...loose];for(const g of grouped.values()){const r=g.list.sort((a,b)=>rootScore(b)-rootScore(a))[0];if(r)picked.push({index:g.index,r});}picked.sort((a,b)=>a.index-b.index);const roots=picked.map(x=>x.r);
      const marker=(el,limit)=>{let cur=el;for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){let children=[];try{children=[...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')];}catch{}for(const node of [cur,...children]){if(!node)continue;for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=node.getAttribute?.(a);if(v&&/(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name|member|membership|loyalty|tier|badge|level)/i.test(v))return a+'='+v;}for(const c of [...(node.classList||[])])if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score|member|membership|loyalty|tier|badge|level)/i.test(c))return 'class='+c;}}return '';};
      const signature=(el,root)=>{if(!el)return '';for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=el.getAttribute?.(a);if(v)return a+'='+v;}return marker(el.parentElement||el,root);};
      const roleOf=(el,root)=>{
        if(!el)return'';
        const t=String(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
        const classTokens=Array.from(el.classList||[],value=>String(value).toLowerCase());
        const hasClass=pattern=>classTokens.some(value=>pattern.test(value));
        const sig=signature(el,root).toLowerCase();
        const testid=String(el.getAttribute?.('data-testid')||'').toLowerCase();
        const infoCarrier=el.closest?.('[data-info-type]');
        const infoType=String(infoCarrier?.getAttribute?.('data-info-type')||'').toLowerCase();
        const tripHost=/(?:^|\.)(?:trip|ctrip)\.com$/i.test(String(location.hostname||''));
        const tripMonth='(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
        const tripBareStayMonth=tripHost&&new RegExp('^'+tripMonth+'\\s+\\d{4}$','i').test(t);
        const tripStayDetail=tripHost&&(tripBareStayMonth||new RegExp('^(?:menginap(?:\\s+pada)?|stayed?(?:\\s+(?:in|during))?|stay(?:\\s+(?:in|during))?)\\s+'+tripMonth+'\\s+\\d{4}$','i').test(t));
        const tripFullReviewDate=tripHost&&(new RegExp('^\\d{1,2}\\s+'+tripMonth+'\\s+\\d{4}$','i').test(t)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(t)||/^(?:reviewed|posted)\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(t));
        const tripTranslationResidual=tripHost?t.replace(/(?:teks\s+asli|original\s+text|laporkan\s+masalah\s+terjemahan|report\s+translation\s+issue|diterjemahkan\s+oleh\s+ai|translated\s+by\s+ai|terj[ea]mahan\s+disediakan\s+oleh\s+google|translation\s+provided\s+by\s+google)/giu,' ').replace(/[|·•\s]+/g,' ').trim():t;
        if(tripHost&&tripTranslationResidual!==t&&tripTranslationResidual.length<2)return'';
        if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(t)&&t.length<=120)return'';
        if(testid==='review-title')return'review_title';
        if(testid==='review-comment'||testid==='review-text')return'review_text';
        if(testid==='product-name')return'product_name';
        if(testid==='price')return'price';
        if(testid==='description')return'description';
        if(testid==='stock')return'stock';
        if(testid==='rating')return'rating_score';
        if(infoType==='reviewer-name'){if(el.closest?.('strong'))return'reviewer_name';if(String(el.tagName||'').toLowerCase()==='span')return'reviewer_country';return'reviewer_name';}
        if(infoType==='group-name')return'traveler_type';
        if(infoType==='room-type')return'room_type';
        if(infoType==='stay-detail')return'stay_detail';
        if(tripStayDetail)return'stay_detail';
        if(tripFullReviewDate)return'review_date';
        if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(t))return'review_date';
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
        if(/message/.test(sig)||/^\d+\s+(?:ulasan|reviews?|comments?|komentar)$/i.test(t))return'review_count';
        if(hasClass(/reviewitem-username|review.*(?:user|guest|customer).*name|reviewer.*name|author.*name|customer[_-]?name/)||el.closest?.('cite'))return'reviewer_name';
        if((!tripHost&&hasClass(/userreviewtime|review.*(?:date|time)|reviewcard.*date/))||/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(t)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(t)||/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(t)||/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(t))return'review_date';
        const p=String(el.parentElement?.innerText||el.parentElement?.textContent||'').trim().replace(/\s+/g,' ');
        if(hasClass(/rating.*score|score.*rating|review[_-]?card[_-]?user[_-]?review/)||(el.getAttribute?.('data-testid')||'').toLowerCase()==='tvat-ratingscore'||(/^\d+(?:[.,]\d+)?$/.test(t)&&/^\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)$/.test(p)))return'rating_score';
        if(/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(t))return'rating_max';
        if(hasClass(/rating.*label|commentlevel/))return'rating_label';
        if(hasClass(/reviewitem-content|review[-_].*(?:content|text|copy|body)|comment[-_].*(?:content|text|body)|review[_-]?card[_-]?comment|readmorecomments.*comment|reviewcopy|review-copy/))return'review_text';
        if(hasClass(/product[-_]?name|product[-_]?title|item[-_]?name/))return'product_name';
        if(hasClass(/(?:^|[-_])price(?:$|[-_])|product[-_]?price/))return'price';
        if(hasClass(/(?:^|[-_])description(?:$|[-_])|product[-_]?description/))return'description';
        if(hasClass(/(?:^|[-_])stock(?:$|[-_])|availability/))return'stock';
        if(String(el.tagName||'').toLowerCase()==='a'&&hasClass(/detail[-_]?link|product[-_]?link/))return'url';
        const metadataAggregate=/\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|desember)\s+\d{4}\s*(?:[•·|–—-]\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?\s*$/i.test(t)&&(/\b(?:perjalanan\s+bisnis|business\s+trip|pasangan|couple|keluarga|family|solo|sendiri|teman|friends?|rombongan|group|liburan|leisure)\b/i.test(t)||(!/[.!?](?:\s|$)/.test(t)&&t.length<=180));
        if(metadataAggregate)return'';
        const textBlocks=[...el.children].filter(child=>String(child.innerText||child.textContent||'').trim().replace(/\s+/g,' ').length>=20).length;
        if(t.length>=55&&t.length<=5000&&textBlocks<=6)return'review_text';
        return'';
      };
      const cleanUiText=value=>{let text=String(value==null?'':value).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();const labels=['tampilkan lebih sedikit','tampilkan lebih banyak','lihat lebih sedikit','lihat lebih banyak','baca lebih sedikit','baca lebih banyak','tampilkan selengkapnya','lihat selengkapnya','baca selengkapnya','continue reading','show less','show more','see less','see more','view less','view more','read less','read more','selengkapnya'].sort((a,b)=>b.length-a.length);let changed=true;while(changed&&text){changed=false;for(const label of labels){const escaped=label.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');const next=text.replace(new RegExp('(?:\\s*(?:\\.{2,}|\\u2026+|[·•|–—-]+)\\s*)?'+escaped+'\\s*$','iu'),'').trim();if(next!==text){text=next;changed=true;break;}}}return text;};
      const read=(root,el)=>{if(['containerAttribute','containerJsonAttribute'].includes(extract))el=root;if(!el)return null;if(extract==='href')return el.href||el.getAttribute('href')||'';if(extract==='src')return el.src||el.getAttribute('src')||'';if(extract==='html')return el.innerHTML||'';if(extract==='value')return 'value' in el?el.value:(el.getAttribute('value')||'');if(extract==='attribute'||extract==='containerAttribute')return attribute?el.getAttribute(attribute):null;if(extract==='jsonAttribute'||extract==='containerJsonAttribute')return getPath(parseJson(attribute?el.getAttribute(attribute):null),jsonPath);return cleanUiText(el.innerText||el.textContent||'');};
      const classes=new Set((targetMeta.classes||[]).map(String)),wantedRole=String(targetMeta.semanticRole||'');
      const resolve=(root)=>{
        if(['containerAttribute','containerJsonAttribute'].includes(extract))return{el:root,selectorUsed:':scope',candidateCount:1};
        if(semanticFirst&&wantedRole&&roleSelectors.length){const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)tiket\.com$/i.test(location.hostname));const semanticRoleMustMatch=contextBoundRole||semanticFlexibleRole;for(const sel of roleSelectors){let list=[];try{list=Array.from(root.querySelectorAll(sel));}catch{continue;}if(list.length!==1)continue;const el=list[0],detected=roleOf(el,root);if(semanticRoleMustMatch?detected===wantedRole:(!detected||detected===wantedRole))return{el,selectorUsed:sel,candidateCount:1,score:3000};}}
        let best=null,maxCandidates=0;
        for(let i=0;i<selectors.length;i++){
          const sel=selectors[i];const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(sel);let list=[];try{list=sel===':scope'?[root]:Array.from(root.querySelectorAll(sel));}catch{continue;}maxCandidates=Math.max(maxCandidates,list.length);if(!list.length)continue;
          let candidates=list;
          if(targetMeta.tag){const byTag=candidates.filter(el=>el.tagName?.toLowerCase()===String(targetMeta.tag).toLowerCase());if(byTag.length)candidates=byTag;}
          const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)tiket\.com$/i.test(location.hostname));
          if(expected){const bySig=candidates.filter(el=>signature(el,root)===expected);if(bySig.length)candidates=bySig;else if(semanticFlexibleRole){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}else if(!strictStructural||contextBoundRole)continue;}
          if(wantedRole&&(!strictStructural||contextBoundRole||semanticFlexibleRole)){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}
          if(classes.size&&candidates.length>1){const byClass=candidates.filter(el=>[...classes].some(c=>el.classList?.contains(c)));if(byClass.length)candidates=byClass;}
          if(candidates.length>1){const visible=candidates.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)candidates=visible;else{const pool=visible.length?visible:candidates;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)candidates=[pool[0]];}}if(candidates.length!==1)continue;
          const el=candidates[0];let score=1200-i*35;if(expected)score+=500;if(wantedRole&&roleOf(el,root)===wantedRole)score+=420;if(targetMeta.tag&&el.tagName?.toLowerCase()===String(targetMeta.tag).toLowerCase())score+=100;if(classes.size)score+=Math.min(240,[...classes].filter(c=>el.classList?.contains(c)).length*80);if(sel.startsWith(':scope > '))score+=90;if(!best||score>best.score)best={el,selectorUsed:sel,candidateCount:list.length,score};
        }
        if(!best && wantedRole){
          let semantic=[];try{semantic=Array.from(root.querySelectorAll('*')).filter(el=>roleOf(el,root)===wantedRole);}catch{}
          if(semantic.length===1) best={el:semantic[0],selectorUsed:'@semantic:'+wantedRole,candidateCount:1,score:900};
        }
        return best||{el:null,selectorUsed:'',candidateCount:maxCandidates};
      };
      let matches=0,ambiguous=0,mismatched=0;const values=[],distinct=new Set();const selectorUsage={};let maxCandidates=0;
      for(let index=0;index<roots.length;index++){
        const root=roots[index],resolved=resolve(root);maxCandidates=Math.max(maxCandidates,resolved.candidateCount||0);
        if(resolved.el){matches++;selectorUsage[resolved.selectorUsed]=(selectorUsage[resolved.selectorUsed]||0)+1;const value=read(root,resolved.el);if(value!=null&&String(value).trim()!=='')distinct.add(String(value).trim());if(values.length<6)values.push({index:index+1,value,selectorUsed:resolved.selectorUsed});}
        else {if((resolved.candidateCount||0)>1)ambiguous++;if(values.length<6)values.push({index:index+1,value:null,selectorUsed:''});}
      }
      const sampleValues=values.map(x=>String(x.value==null?'':x.value)).filter(Boolean),semanticWarnings=[];const lname=String(fieldName||'').toLowerCase();
      const looksReviewCount=sampleValues.length&&sampleValues.every(v=>/^\s*\d+\s+(?:ulasan|review|reviews|komentar|comments?)\s*$/i.test(v));
      if(/rating_label/.test(lname)&&looksReviewCount)semanticWarnings.push('Nilai terlihat seperti jumlah ulasan, bukan label rating. Pertimbangkan nama review_count.');
      const bestSelector=Object.entries(selectorUsage).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';return {matches,total:roots.length,ambiguous,mismatched,singleCandidate:matches,maxCandidates,distinctValues:distinct.size,values,selectorsUsed:selectorUsage,bestSelector,semanticWarnings,validationMode:'compact'};
    })()`, true);

  try {
    let result;
    try {
      result=await runPrimary();
      if (expectedRevision !== state.fieldDialogRevision || !$('fieldDialog').open) return;
      state.fieldPreviewFallbackUsed=false;state.fieldPreviewError='';
    } catch (primaryError) {
      state.fieldPreviewError=String(primaryError?.message||primaryError||'').slice(0,320);
      result=await runCompactFallback();
      if (expectedRevision !== state.fieldDialogRevision || !$('fieldDialog').open) return;
      state.fieldPreviewFallbackUsed=true;
    }
    if (expectedRevision !== state.fieldDialogRevision || !$('fieldDialog').open) return;
    if(result.bestSelector && result.bestSelector!==':scope' && !String(result.bestSelector).startsWith('@semantic:') && result.matches>0 && result.ambiguous===0){
      $('fieldSelectorInput').value=result.bestSelector;
      state.fieldCandidateSelectors=[...new Set([result.bestSelector,...state.fieldCandidateSelectors,...fallbackSelectors])].slice(0,18);
    }
    setFieldQuality(result.matches || 0, result.total || 0, result.ambiguous || 0, result.mismatched || 0);
    if(nameRole&&clickedRole&&nameRole!==clickedRole){
      result.semanticWarnings=[...(result.semanticWarnings||[]),`Nama kolom “${fieldName}” berbeda dari elemen yang diklik (${clickedRole}). MyDataset tetap mengambil elemen yang diklik; ubah pilihan jika ini tidak disengaja.`];
    }
    renderFieldPreview(result);
    highlightInBrowser({ type: 'relative', rootSelector: activeRootSelector, fieldSelector: result.bestSelector||selector, fieldSelectors:[...new Set([result.bestSelector,...fallbackSelectors].filter(Boolean))], expectedSignature, targetMeta, color: '#4d91ff' });
  } catch (error) {
    if (expectedRevision !== state.fieldDialogRevision || !$('fieldDialog').open) return;
    state.fieldPreviewError=String(error?.message||error||'').slice(0,320);
    const initial=state.fieldInitialValidation || {};
    const initialValid=Number(initial.matches||0)>0&&Number(initial.ambiguous||0)===0&&Number(initial.mismatched||0)===0;
    if(initialValid){
      state.fieldPreviewFallbackUsed=true;
      setFieldQuality(initial.matches||0,initial.total||initial.matches||0,0,0);
      renderFieldPreview({matches:initial.matches||0,total:initial.total||initial.matches||0,ambiguous:0,mismatched:0,singleCandidate:initial.matches||0,distinctValues:initial.values?.length||1,values:initial.values||[],semanticWarnings:[],validationMode:'selection',previewError:state.fieldPreviewError});
    }else{
      setFieldQuality(0, 0, 0, 0);
      $('fieldPreview').innerHTML = `<span class="bad-text">Preview pola data gagal.</span><small class="muted">${escapeHtml(state.fieldPreviewError||'Coba pilih tepat pada teks atau buka Detail Teknis.')}</small>`;
    }
  }
}
function normalizeRatingLabelDisplay(value) {
  if (value == null) return value;
  const text = String(value).replace(/\s+/g, ' ').trim();
  const match = text.match(/^\/\s*([+-]?\d+(?:[.,]\d+)?)$/);
  return match ? match[1].replace(',', '.') : value;
}

function renderFieldPreview(result) {
  const root = $('fieldPreview');
  const total=Number(result.total||0),matches=Number(result.matches||0),ambiguous=Number(result.ambiguous||0),mismatched=Number(result.mismatched||0),single=Number(result.singleCandidate||0),distinct=Number(result.distinctValues||0);
  const currentFieldName=String($('fieldNameInput')?.value||'').trim().toLowerCase();
  const values=Array.isArray(result.values)?result.values.filter(item=>item.value!=null&&String(item.value).trim()!=='').slice(0,4).map(item=>({
    ...item,
    value: currentFieldName === 'rating_label' ? normalizeRatingLabelDisplay(item.value) : item.value
  })):[];
  const warning=ambiguous
    ? `Pilihan belum aman: pada ${ambiguous} record ditemukan lebih dari satu elemen yang mungkin merupakan data ini. Pilih bagian yang lebih spesifik.`
    : mismatched
      ? `${mismatched} record cocok pada konteks berbeda. Pilih bagian yang lebih spesifik.`
      : '';
  const semanticWarnings=Array.isArray(result.semanticWarnings)?result.semanticWarnings:[];
  const validationMode=result.validationMode||'full';
  const fallbackNote=validationMode==='compact'?'<div class="field-preview-info">Preview lengkap mengalami kendala; MyDataset memakai pemeriksaan selector cadangan yang tetap diuji lintas record.</div>':validationMode==='selection'?'<div class="field-preview-info">Preview penuh tidak tersedia, tetapi pola saat pemilihan field sudah tervalidasi lintas record. Anda tetap dapat menyimpan field dan memeriksanya lagi dari Preview Halaman.</div>':'';
  root.innerHTML=`<div class="field-preview-head"><b>Preview lintas record</b><span>${matches}/${total} record terbaca · ${single}/${total} tepat satu kandidat${distinct ? ` · ${distinct} nilai berbeda` : ''}${total < 2 ? ' · belum lintas item' : ''}</span></div>${fallbackNote}${warning?`<div class="field-preview-warning">⚠ ${escapeHtml(warning)}</div>`:''}${semanticWarnings.map(msg=>`<div class="field-preview-semantic">⚠ ${escapeHtml(msg)}</div>`).join('')}<div class="preview-chips">${values.length?values.map(item=>`<span title="Record ${item.index}${item.selectorUsed?` · ${escapeHtml(item.selectorUsed)}`:''}">${escapeHtml(String(item.value).slice(0,90))}</span>`).join(''):'<span class="muted">Belum ada nilai.</span>'}</div>`;
}

function setFieldQuality(matches, total, ambiguous = 0, mismatched = 0) {
  state.fieldPreviewMatches=Number(matches||0);state.fieldPreviewTotal=Number(total||0);state.fieldPreviewAmbiguous=Number(ambiguous||0);state.fieldPreviewMismatched=Number(mismatched||0);
  const save=$('saveFieldBtn');
  const name=String($('fieldNameInput')?.value||'').trim();
  const role=String(state.fieldSemanticRoleUsed||state.fieldTargetMeta?.semanticRole||semanticRoleFromFieldName(name)||'');
  const required=Boolean($('fieldRequiredInput')?.checked);
  const strict=isStrictFieldValidation(name,role,required);
  const partial=canAcceptPartialSemanticField({name,role,required,matches:state.fieldPreviewMatches,total:state.fieldPreviewTotal,ambiguous:state.fieldPreviewAmbiguous,mismatched:state.fieldPreviewMismatched});
  const valid=fieldSelectionIsValid({name,role,required,matches:state.fieldPreviewMatches,total:state.fieldPreviewTotal,ambiguous:state.fieldPreviewAmbiguous,mismatched:state.fieldPreviewMismatched});
  const missing=Math.max(0,state.fieldPreviewTotal-state.fieldPreviewMatches-state.fieldPreviewAmbiguous);
  let reason;
  if(valid&&partial) reason=`Siap ditambahkan sebagai metadata opsional. ${state.fieldPreviewMatches}/${state.fieldPreviewTotal} record memiliki pola stabil; record yang ambigu/kosong akan disimpan sebagai null.`;
  else if(valid) reason='Siap ditambahkan. Satu kandidat field dipakai pada setiap record yang cocok.';
  else if(strict&&missing>0) reason=`Belum bisa ditambahkan: field ${role==='review_text'?'review_text':'wajib'} harus stabil pada seluruh record; ${missing} record masih kosong.`;
  else if(state.fieldPreviewAmbiguous>0) reason=`Belum bisa ditambahkan: ${state.fieldPreviewAmbiguous} record masih memiliki lebih dari satu potensi duplikat. MyDataset hanya melonggarkan ambiguitas minor untuk metadata opsional dengan pola mayoritas stabil.`;
  else if(state.fieldPreviewMismatched>0) reason=`Belum bisa ditambahkan: ${state.fieldPreviewMismatched} record mengarah ke konteks data yang berbeda.`;
  else reason='Belum bisa ditambahkan: pola field belum ditemukan pada record yang terdeteksi.';
  if(save){save.disabled=!valid;save.title=reason;}
  const hint=$('fieldSaveHint');if(hint){hint.textContent=reason;hint.className=`field-save-hint ${valid?'good-text':'warn-text'}`;}
  const badge=$('fieldQualityBadge');if(!total){badge.textContent='Belum diuji';badge.className='quality-badge';return;}const ratio=matches/total;const validation=valid&&partial?` · mayoritas stabil (${ambiguous} ambigu → null)`:matches===0?' · belum ditemukan':total<2?' · belum tervalidasi lintas item':ambiguous?` · ${ambiguous} perlu diperjelas`:mismatched?` · ${mismatched} beda konteks`:' · stabil';badge.textContent=`${matches}/${total} terisi${validation}`;badge.className=`quality-badge ${!valid?'bad':partial||total<2||ratio<0.9?'warn':'good'}`;
}
async function updateContainerQuality() {
  const selector = state.project.itemSelector;
  if (!selector || !browser.src) {
    $('containerQuality').textContent = 'Belum diuji.';
    $('containerSummary').textContent = 'Belum ada struktur record.';
    $('containerSummary').className = 'selection-summary empty';
    $('previewBtn').disabled = true;
    renderBrowserMarkers();
    return;
  }
  if (/^\s*#/.test(selector)) {
    $('containerSummary').innerHTML = '<b>Batas record lama perlu dipilih ulang</b><span>Selector berbasis ID tidak aman untuk item berulang.</span>';
    $('containerSummary').className = 'selection-summary warn-summary';
    $('containerQuality').textContent = 'Atur ulang batas record. MyDataset tidak menggunakan ID instance seperti #review-1 sebagai pola review.';
    $('containerQuality').className = 'quality-line bad-text';
    $('previewBtn').disabled = true;
    return;
  }
  try {
    const result = await browser.executeJavaScript(String.raw`(() => {
      let roots=[...document.querySelectorAll(${JSON.stringify(selector)})];
      const rendered=roots.filter(root=>{try{let node=root;for(let depth=0;node&&node.nodeType===1&&depth<18;depth++,node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)===0||node.getAttribute?.('aria-hidden')==='true')return false;}const rect=root.getBoundingClientRect();return rect.width>1&&rect.height>1;}catch{return true;}});
      if(rendered.length)roots=rendered;
      let keyAttr=${JSON.stringify(state.project.itemKeyAttribute || '')};
      const identity=${JSON.stringify(state.project.itemIdentity || state.project.itemMeta?.identity || null)};
      const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
      const identityValue=(root)=>{if(keyAttr)return root.getAttribute(keyAttr);if(!identity)return null;if(identity.mode==='containerAttribute')return root.getAttribute(identity.attribute||'');if(identity.mode==='containerJsonAttribute'){try{return getPath(JSON.parse(root.getAttribute(identity.attribute||'')||'null'),identity.jsonPath||'');}catch{return null;}}return null;};
      if(!keyAttr&&!identity){
        const attrs=['data-review-id','data-comment-id','data-writing-id','data-submit-id','data-item-id','data-product-id','data-result-id','data-record-id','data-id','data-key','id'];let best=null;
        for(const attr of attrs){const vals=roots.map(r=>r.getAttribute(attr)).filter(Boolean);if(vals.length/Math.max(1,roots.length)<.8)continue;const unique=new Set(vals);if(unique.size<2)continue;const savings=vals.length-unique.size;const score=(attr.startsWith('data-')?50:10)+(savings>0?120+savings*3:0)+unique.size;if(!best||score>best.score)best={attr,score};} keyAttr=best?.attr||null;
      }
      const values=roots.map(identityValue).filter(v=>v!=null&&String(v)!=='').map(String);const unique=values.length?new Set(values):null;
      return {raw:roots.length,logical:unique&&unique.size?unique.size:roots.length,keyAttribute:keyAttr,identity:Boolean(identity)};
    })()`, true);
    if (!state.project.itemKeyAttribute && result.keyAttribute && result.logical < result.raw) { state.project.itemKeyAttribute=result.keyAttribute; scheduleAutosave(); }
    const label = state.project.itemMeta?.label || 'Item berulang';
    const dup = result.raw > result.logical;
    const identity = state.project.itemIdentity || state.project.itemMeta?.identity || null;
    const identityName = identity?.suggestedName || (result.keyAttribute ? (/review|comment|writing/i.test(result.keyAttribute) ? 'review_id' : 'record_id') : '');
    const identityInfo = identityName ? ` · ID record: ${identityName} (otomatis)` : ' · ID internal: fingerprint otomatis';
    const boundaryMode = state.project.itemMode === 'manual' ? 'Manual' : 'Otomatis';
    $('containerSummary').innerHTML = `<b>✓ ${escapeHtml(label)} terdeteksi</b><span>${Number(result.logical).toLocaleString('id-ID')} record${dup ? ` · ${Number(result.raw).toLocaleString('id-ID')} elemen DOM` : ''}${escapeHtml(identityInfo)} · Mode ${boundaryMode} · terkunci</span>`;
    $('containerSummary').className = `selection-summary ${result.logical >= 2 ? 'good-summary' : 'warn-summary'}`;
    $('containerQuality').textContent = result.logical >= 2 ? (dup ? `Struktur siap. Duplikat DOM akan digabung berdasarkan ${result.keyAttribute || identityName || 'ID internal'}. Field yang sudah dipilih diberi penanda di halaman.` : (identityName ? `Struktur siap. ${identityName} digunakan otomatis sebagai identitas record; Anda tidak perlu memilihnya sebagai field.` : 'Struktur record siap. MyDataset akan memakai fingerprint internal bila situs tidak menyediakan ID stabil.')) : 'Hanya satu record ditemukan. Ini sering berarti seluruh panel dipilih, bukan satu kartu/baris. Atur ulang batas record.';
    $('containerQuality').className = `quality-line ${result.logical >= 2 ? 'good-text' : 'warn-text'}`;
    $('previewBtn').disabled = !(result.logical && state.project.fields.length);
    renderBrowserMarkers();
  } catch {
    $('containerSummary').textContent = 'Struktur record tidak ditemukan pada halaman ini.';
    $('containerSummary').className = 'selection-summary warn-summary';
    $('containerQuality').textContent = 'Selector tidak valid atau struktur halaman sudah berubah.';
    $('containerQuality').className = 'quality-line bad-text';
    $('previewBtn').disabled = true;
  }
}

function addFieldFromDialog() {
  const name = $('fieldNameInput').value.trim(); const selector = $('fieldSelectorInput').value.trim();
  const roleForValidation=String(state.fieldSemanticRoleUsed||state.fieldTargetMeta?.semanticRole||semanticRoleFromFieldName(name)||'');
  const requiredForValidation=Boolean($('fieldRequiredInput')?.checked);
  if (!fieldSelectionIsValid({name,role:roleForValidation,required:requiredForValidation,matches:state.fieldPreviewMatches,total:state.fieldPreviewTotal,ambiguous:state.fieldPreviewAmbiguous,mismatched:state.fieldPreviewMismatched})) {
    const message = isStrictFieldValidation(name,roleForValidation,requiredForValidation) && state.fieldPreviewTotal > state.fieldPreviewMatches
      ? 'Data belum dapat ditambahkan karena field wajib/review_text belum stabil pada seluruh record.'
      : state.fieldPreviewAmbiguous > 0 ? 'Data belum dapat ditambahkan karena ambiguitas belum memenuhi pola mayoritas stabil untuk metadata opsional.' : state.fieldPreviewMismatched > 0 ? 'Data belum dapat ditambahkan karena posisi/konteks field berubah antar-record.' : 'Data belum dapat ditambahkan karena pola field belum cukup jelas.';
    setStatus(`${message} Pilih elemen yang lebih spesifik atau buka Detail Teknis.`); return;
  }
  if (!name || !selector) return;
  if (state.pendingInferredContainer && (!state.project.itemSelector || (state.pendingInferredContainer.replaceActive && state.pendingInferredContainer.selector !== state.project.itemSelector))) {
    applyContainerCandidate(state.pendingInferredContainer, { auto: true, preserveFields: true });
  }
  if (!state.project.itemSelector) return setStatus('Batas satu record belum dapat ditentukan otomatis. Gunakan “Atur batas record secara manual”, lalu ulangi pemilihan data.');
  const semanticRole=String(state.fieldSemanticRoleUsed||state.fieldTargetMeta?.semanticRole||'');
  const semanticSelectors=semanticRole?semanticFallbackSelectors(semanticRole):[];
  const selectors=[...new Set([selector, ...state.fieldCandidateSelectors, ...semanticSelectors].filter(Boolean))].slice(0,18);
  const storedSelector=selector;
  state.project.fields.push({
    name, selector: storedSelector, selectors, extract: $('fieldExtractInput').value,
    attribute: $('fieldAttributeInput').value.trim() || undefined, jsonPath: $('fieldJsonPathInput').value.trim() || undefined,
    dataType: $('fieldDataTypeInput').value, transform: $('fieldTransformInput').value,
    required: $('fieldRequiredInput').checked,
    expectedSignature: (state.fieldSemanticRecovered || semanticRole==='review_date') ? '' : (state.fieldExpectedSignature || ''),
    targetTag: state.fieldSemanticRecovered ? '' : (state.fieldTargetMeta?.tag || ''),
    targetClasses: state.fieldSemanticRecovered ? [] : (state.fieldTargetMeta?.classes || []),
    semanticRole,
    pickedText: state.fieldTargetMeta?.pickedText || '',
    selectionMatches: state.fieldPreviewMatches,
    selectionTotal: state.fieldPreviewTotal,
    selectionCoverage: state.fieldPreviewTotal ? state.fieldPreviewMatches / state.fieldPreviewTotal : null,
    selectionValidationMode: state.fieldPreviewFallbackUsed ? 'fallback' : 'full',
    sourceHost: httpHost(currentBrowserUrl() || state.project.startUrl || ''),
    sourceSite: effectiveSiteProfile()
  });
  renderFields(); scheduleAutosave(); renderFlowCanvas();
  setStatus(`Data “${name}” ditambahkan. Struktur record ${state.project.itemMeta?.autoDetected ? 'ditentukan otomatis' : 'siap'}; preview diperbarui.`);
  previewCurrentPage();
}

async function previewCurrentPage({ silent = false } = {}) {
  if (state.running) { if (!silent) setStatus('Preview tidak dijalankan saat proses aktif. Gunakan Alur Proses untuk memantau tahap yang berjalan atau jeda proses terlebih dahulu.'); return { ok: false, critical: [], rows: [] }; }
  if (!state.project.fields.length) { if (!silent) setStatus('Pilih minimal satu data terlebih dahulu.'); return { ok: false, critical: [], rows: [] }; }
  if (!state.project.itemSelector) { if (!silent) setStatus('Struktur record belum ditemukan. Pilih data pertama lagi atau atur batas record secara manual.'); return { ok: false, critical: [], rows: [] }; }
  try {
    let contentExpansion = { found: 0, expanded: 0, failed: 0 };
    if (state.project.settings?.expandTruncatedText !== false && window.CrawlLoomContentExpansion?.buildExpansionScript) {
      if (!silent) setStatus('Membuka teks yang masih terpotong sebelum membuat preview…');
      const expanded = await browser.executeJavaScript(window.CrawlLoomContentExpansion.buildExpansionScript({
        itemSelector: state.project.itemSelector,
        maxControls: 80,
        waitMs: 1500,
        pollMs: 70
      }), true);
      if (expanded && typeof expanded === 'object') contentExpansion = expanded;
    }
    const result = await browser.executeJavaScript(String.raw`(() => {
      const all=[...document.querySelectorAll(${JSON.stringify(state.project.itemSelector)})];
      const keyAttr=${JSON.stringify(state.project.itemKeyAttribute || '')};
      const identity=${JSON.stringify(state.project.itemIdentity || state.project.itemMeta?.identity || null)};
      const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
      const parseJson=raw=>{try{return raw==null?null:JSON.parse(raw);}catch{return null;}};
      const getIdentity=(r)=>{if(keyAttr)return r.getAttribute(keyAttr);if(!identity)return null;if(identity.mode==='containerAttribute')return r.getAttribute(identity.attribute||'');if(identity.mode==='containerJsonAttribute')return getPath(parseJson(r.getAttribute(identity.attribute||'')),identity.jsonPath||'');return null;};
      const rootScore=(r)=>{if(!r||!r.isConnected)return-100000;let score=0;try{let n=r,hidden=false;for(let d=0;n&&n.nodeType===1&&d<18;d++,n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)===0){hidden=true;break;}if(n.getAttribute?.('aria-hidden')==='true')score-=2200;}score+=hidden?-12000:1000;const b=r.getBoundingClientRect();if(b.width>1&&b.height>1){score+=700;if(b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth)score+=650;}else score-=1800;score+=Math.min(220,String(r.innerText||r.textContent||'').trim().length*.05);}catch{}return score;};
      const grouped=new Map(),loose=[];all.forEach((r,index)=>{const k=getIdentity(r);if(k==null||String(k)===''){loose.push({index,r});return;}const key=String(k);if(!grouped.has(key))grouped.set(key,{index,list:[]});grouped.get(key).list.push(r);});const renderedLoose=loose.filter(({r})=>rootScore(r)>-5000);const picked=renderedLoose.length?renderedLoose:[...loose];for(const g of grouped.values()){const r=g.list.sort((a,b)=>rootScore(b)-rootScore(a))[0];if(r)picked.push({index:g.index,r});}picked.sort((a,b)=>a.index-b.index);const roots=picked.slice(0,30).map(x=>x.r);
      const fields=${JSON.stringify(state.project.fields)};
      const identityName=${JSON.stringify((state.project.itemIdentity || state.project.itemMeta?.identity)?.suggestedName || 'record_id')};
      const marker=(el,limit)=>{let cur=el;for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){for(const node of [cur,...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')]){if(!node)continue;for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=node.getAttribute?.(a);if(v&&/(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name|member|membership|loyalty|tier|badge|level)/i.test(v))return a+'='+v;}for(const c of [...(node.classList||[])])if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score|member|membership|loyalty|tier|badge|level)/i.test(c))return 'class='+c;}}return '';};
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
        const tripHost=/(?:^|\.)(?:trip|ctrip)\.com$/i.test(String(location.hostname||''));
        const tripMonth='(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
        const tripBareStayMonth=tripHost&&new RegExp('^'+tripMonth+'\\s+\\d{4}$','i').test(txt);
        const tripStayDetail=tripHost&&(tripBareStayMonth||new RegExp('^(?:menginap(?:\\s+pada)?|stayed?(?:\\s+(?:in|during))?|stay(?:\\s+(?:in|during))?)\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt));
        const tripFullReviewDate=tripHost&&(new RegExp('^\\d{1,2}\\s+'+tripMonth+'\\s+\\d{4}$','i').test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^(?:reviewed|posted)\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt));
        const tripTranslationResidual=tripHost?txt.replace(/(?:teks\s+asli|original\s+text|laporkan\s+masalah\s+terjemahan|report\s+translation\s+issue|diterjemahkan\s+oleh\s+ai|translated\s+by\s+ai|terj[ea]mahan\s+disediakan\s+oleh\s+google|translation\s+provided\s+by\s+google)/giu,' ').replace(/[|·•\s]+/g,' ').trim():txt;
        if(tripHost&&tripTranslationResidual!==txt&&tripTranslationResidual.length<2)return'';
        if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(txt)&&txt.length<=120)return'';
        if(testid==='review-title')return'review_title';
        if(testid==='review-comment'||testid==='review-text')return'review_text';
        if(testid==='product-name')return'product_name';
        if(testid==='price')return'price';
        if(testid==='description')return'description';
        if(testid==='stock')return'stock';
        if(testid==='rating')return'rating_score';
        if(infoType==='reviewer-name'){if(el.closest?.('strong'))return'reviewer_name';if(String(el.tagName||'').toLowerCase()==='span')return'reviewer_country';return'reviewer_name';}
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
        if((!tripHost&&hasClass(/userreviewtime|review.*(?:date|time)|reviewcard.*date/))||/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(txt)||/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return'review_date';
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
      const cleanUiText=value=>{let text=String(value==null?'':value).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();const labels=['tampilkan lebih sedikit','tampilkan lebih banyak','lihat lebih sedikit','lihat lebih banyak','baca lebih sedikit','baca lebih banyak','tampilkan selengkapnya','lihat selengkapnya','baca selengkapnya','continue reading','show less','show more','see less','see more','view less','view more','read less','read more','selengkapnya'].sort((a,b)=>b.length-a.length);let changed=true;while(changed&&text){changed=false;for(const label of labels){const escaped=label.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');const next=text.replace(new RegExp('(?:\\s*(?:\\.{2,}|\\u2026+|[·•|–—-]+)\\s*)?'+escaped+'\\s*$','iu'),'').trim();if(next!==text){text=next;changed=true;break;}}}return text;};
      const read=(root,field,el)=>{const mode=field.extract||'text';if(['containerAttribute','containerJsonAttribute'].includes(mode))el=root;if(!el)return null;if(mode==='href')return el.href||el.getAttribute('href')||null;if(mode==='src')return el.src||el.getAttribute('src')||null;if(mode==='html')return el.innerHTML||'';if(mode==='value')return 'value' in el?el.value:el.getAttribute('value');if(mode==='attribute'||mode==='containerAttribute')return field.attribute?el.getAttribute(field.attribute):null;if(mode==='jsonAttribute'||mode==='containerJsonAttribute')return getPath(parseJson(el.getAttribute(field.attribute||'')),field.jsonPath||'');return cleanUiText(el.innerText||el.textContent||'');};
      const resolve=(root,field)=>{
        if(['containerAttribute','containerJsonAttribute'].includes(field.extract))return {el:root,selectorUsed:':scope',candidateCount:1};
        const selectors=[...new Set([field.selector,...(Array.isArray(field.selectors)?field.selectors:[])].filter(Boolean))];
        const expected=field.expectedSignature||'';const tag=String(field.targetTag||'').toLowerCase();const classes=new Set((field.targetClasses||[]).map(String));const wantedRole=String(field.semanticRole||'');
        let best=null,maxCandidates=0;
        for(let i=0;i<selectors.length;i++){
          const sel=selectors[i];const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(sel);let list=[];try{list=sel===':scope'?[root]:[...root.querySelectorAll(sel)];}catch{continue;}maxCandidates=Math.max(maxCandidates,list.length);if(!list.length)continue;
          let candidates=list;if(tag){const byTag=candidates.filter(el=>el.tagName?.toLowerCase()===tag);if(byTag.length)candidates=byTag;}const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)tiket\.com$/i.test(location.hostname));const semanticFlexibleRole=wantedRole==='review_date';if(expected){const bySig=candidates.filter(el=>signature(el,root)===expected);if(bySig.length)candidates=bySig;else if(semanticFlexibleRole){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}else if(!strictStructural||contextBoundRole)continue;}if(wantedRole&&(!strictStructural||contextBoundRole||semanticFlexibleRole)){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}if(classes.size&&candidates.length>1){const byClass=candidates.filter(el=>[...classes].some(c=>el.classList?.contains(c)));if(byClass.length)candidates=byClass;}if(candidates.length>1){const visible=candidates.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)candidates=visible;else{const pool=visible.length?visible:candidates;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)candidates=[pool[0]];}}if(candidates.length!==1)continue;
          const el=candidates[0],sig=signature(el,root);let score=1200-i*35;if(expected)score+=sig===expected?500:-420;if(tag&&el.tagName?.toLowerCase()===tag)score+=120;if(classes.size)score+=Math.min(240,[...classes].filter(c=>el.classList?.contains(c)).length*80);if(sel.startsWith(':scope > '))score+=90;if(!best||score>best.score)best={el,selectorUsed:sel,candidateCount:list.length,score};
        }
        if(!best && wantedRole){
          let semantic=[];try{semantic=[...root.querySelectorAll('*')].filter(el=>roleOf(el,root)===wantedRole);}catch{}
          if(semantic.length===1) best={el:semantic[0],selectorUsed:'@semantic:'+wantedRole,candidateCount:1,score:900};
        }
        return best||{el:null,selectorUsed:'',candidateCount:maxCandidates};
      };
      const diagnostics=Object.fromEntries(fields.map(f=>[f.name,{missing:0,ambiguous:0,selectorUsage:{},samples:[],required:Boolean(f.required),expectedCoverage:Number.isFinite(Number(f.selectionCoverage))?Number(f.selectionCoverage):null} ]));
      const rows=roots.map(root=>{const row={};const id=getIdentity(root);if(id!=null&&String(id)!=='')row[identityName]=id;for(const field of fields){const resolved=resolve(root,field);const d=diagnostics[field.name];if(!resolved.el){if((resolved.candidateCount||0)>1)d.ambiguous++;else d.missing++;row[field.name]=null;continue;}d.selectorUsage[resolved.selectorUsed]=(d.selectorUsage[resolved.selectorUsed]||0)+1;const value=read(root,field,resolved.el);row[field.name]=value;if(d.samples.length<5&&value!=null&&String(value).trim()!=='')d.samples.push(String(value).trim());}return row;});
      const normalize=v=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
      for(const field of fields){
        const d=diagnostics[field.name];const values=d.samples;const lname=String(field.name||'').toLowerCase();d.semanticWarnings=[];d.semanticCritical=false;d.suggestedName='';
        d.actualCoverage=roots.length?Math.max(0,(roots.length-d.missing-d.ambiguous)/roots.length):0;d.coverageDrop=d.expectedCoverage==null?0:Math.max(0,d.expectedCoverage-d.actualCoverage);
        const reviewCount=values.length&&values.every(v=>/^\s*\d+\s+(?:ulasan|review|reviews|komentar|comments?)\s*$/i.test(v));
        const numeric=values.length&&values.every(v=>/^\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?\s*$/i.test(v));
        if(/rating_label/.test(lname)&&reviewCount){d.semanticWarnings.push('Nilai terlihat seperti jumlah ulasan; nama review_count lebih sesuai.');d.semanticCritical=true;d.suggestedName='review_count';}
        if(/rating_score|score/.test(lname)&&values.length&&!numeric){d.semanticWarnings.push('Nilai field skor tidak konsisten dengan bentuk angka/skor.');d.semanticCritical=true;}
      }
      const reviewerField=fields.find(f=>/^(?:reviewer_name|reviewer|author|user_name)$/i.test(String(f.name||'')));
      if(reviewerField){
        for(const field of fields){
          if(!/rating_label/i.test(String(field.name||'')))continue;
          let compared=0,same=0;for(const row of rows){const a=normalize(row[field.name]),b=normalize(row[reviewerField.name]);if(!a||!b)continue;compared++;if(a===b)same++;}
          if(compared>=2&&same/compared>=0.6){const d=diagnostics[field.name];d.semanticWarnings.push('Nilai '+field.name+' terlalu sering sama dengan '+reviewerField.name+'; selector kemungkinan bergeser ke nama pengguna.');d.semanticCritical=true;}
        }
      }
      return {rows,diagnostics};
    })()`, true);
    state.previewRows = Array.isArray(result?.rows) ? result.rows.map(row => {
      const out = { ...(row || {}) };
      if (Object.prototype.hasOwnProperty.call(out, 'rating_label')) out.rating_label = normalizeRatingLabelDisplay(out.rating_label);
      return out;
    }) : [];
    state.previewDiagnostics = result?.diagnostics ? Object.entries(result.diagnostics).map(([name,d])=>({name,...d})) : [];
    state.showingPreview = true;
    const critical=state.previewDiagnostics.filter(d=>previewDiagnosticIsCritical(d,state.project.fields.find(field=>field.name===d.name)));
    const semantic=state.previewDiagnostics.flatMap(d=>(d.semanticWarnings||[]).map(message=>({name:d.name,message})));
    state.runtimeFlow.validationWarnings=critical.length+semantic.length;
    renderFields();
    renderResults();
    const expansionNote = contentExpansion.failed
      ? ` ${contentExpansion.expanded || 0}/${contentExpansion.found || 0} teks terpotong berhasil dibuka; ${contentExpansion.failed} masih terpotong dan akan ditandai saat run.`
      : contentExpansion.found
        ? ` ${contentExpansion.expanded || 0}/${contentExpansion.found || 0} teks terpotong berhasil dibuka.`
        : '';
    if(critical.length){
      const summary=critical.slice(0,3).map(d=>{const sem=(d.semanticWarnings||[])[0];return sem?`${d.name}: ${sem}`:`${d.name}: ${d.missing||0} kosong, ${d.ambiguous||0} ambigu${Number(d.coverageDrop||0)>0.15?' · cakupan turun':''}`;}).join(' · ');
      if (!silent) setStatus(`Preview selesai tetapi belum aman untuk run: ${summary}. Marker dan preview kini memakai resolver yang sama; perbaiki field yang masih bermasalah.${expansionNote}`);
    } else if(semantic.length){
      if (!silent) setStatus(`Preview selesai: ${state.previewRows.length} baris. Ada ${semantic.length} peringatan semantik; periksa nama field sebelum menjalankan.${expansionNote}`);
    } else {
      if (!silent) setStatus(`Preview selesai: ${state.previewRows.length} baris dari halaman saat ini. Semua field terpetakan konsisten pada record yang terlihat.${expansionNote}`);
    }
    return { ok: critical.length === 0, critical, semantic, rows: state.previewRows };
  } catch (error) {
    if (!silent) setStatus(`Preview gagal: ${error.message}`);
    return { ok: false, critical: [], semantic: [], rows: [], error };
  }
}

function renderProject() {
  $('projectName').value = state.project.name || 'Proyek Baru';
  if ($('dataTarget')) $('dataTarget').value = state.project.dataTarget || 'reviews';
  if ($('acquisitionMethod')) $('acquisitionMethod').value = AcquisitionPolicy?.normalizedMethod(state.project.acquisition?.method || 'network-json') || 'network-json';
  if ($('acquisitionScope')) $('acquisitionScope').value = state.project.acquisition?.scope || 'current';
  if ($('acquisitionLimit')) $('acquisitionLimit').value = state.project.acquisition?.limit ?? state.project.pagination?.maxPages ?? 5;
  $('urlInput').value = state.project.startUrl || $('urlInput').value;
  $('itemSelectorView').textContent = state.project.itemSelector || 'Belum terdeteksi';
  $('projectMode').value = state.project.mode || 'quick';
  if ($('siteProfile')) $('siteProfile').value = state.project.siteProfile || 'auto';
  $('paginationType').value = state.project.pagination?.type || 'none';
  $('maxPages').value = state.project.pagination?.maxPages ?? '';
  $('delayMs').value = Math.max(1, Number(state.project.pagination?.delayMs ?? 3000) / 1000);
  $('timeoutMs').value = Math.max(3, Number(state.project.settings?.timeoutMs ?? 30000) / 1000);
  $('retryCount').value = state.project.settings?.retryCount ?? 3;
  $('browserZoomSelect').value = String(nearestZoomPreset(state.project.settings?.browserZoomPercent ?? 100));
  $('crawlScope').value = state.project.crawl?.scope || 'same-host';
  $('crawlDepth').value = state.project.crawl?.maxDepth ?? 2;
  $('crawlMaxUrls').value = state.project.crawl?.maxUrls ?? 100;
  $('crawlInclude').value = state.project.crawl?.include || '';
  $('crawlExclude').value = state.project.crawl?.exclude || '';
  applyBrowserZoom(); renderProjectMode(); renderAcquisition(); renderSiteProfile(); renderNetworkImportStage(); renderSourceIdentity();
  renderActivePageSourceStatus(state.project.startUrl || ''); renderFields(); renderPagination(); updateContainerQuality(); renderFlowCanvas();
}

function releaseAutoRecordBoundaryIfUnused() {
  if (state.project.fields.length) return false;
  const manual = state.project.itemMode === 'manual' || state.project.itemMeta?.autoDetected === false;
  if (manual) return false;
  state.project.itemSelector = '';
  state.project.itemMeta = null;
  state.project.itemKeyAttribute = null;
  state.project.itemIdentity = null;
  state.project.itemMode = 'auto';
  state.project.itemLocked = false;
  state.detectedContainerIdentity = null;
  state.pendingInferredContainer = null;
  return true;
}

function removeFieldAt(index) {
  if (index < 0 || index >= state.project.fields.length) return false;
  const [removed] = state.project.fields.splice(index, 1);
  state.previewRows = [];
  state.previewDiagnostics = [];
  state.showingPreview = false;
  const releasedAutoBoundary = releaseAutoRecordBoundaryIfUnused();
  clearBrowserHighlights();
  renderFields();
  renderResults();
  updateContainerQuality();
  scheduleAutosave();
  setStatus(releasedAutoBoundary
    ? `Data “${removed?.name || 'field'}” dihapus. Karena tidak ada field lain, batas record otomatis juga dilepas.`
    : `Data “${removed?.name || 'field'}” dihapus. Penanda halaman diperbarui.`);
  return true;
}

function renderFields() {
  const root = $('fieldList');
  root.innerHTML = '';
  const identity = state.project.itemIdentity || state.project.itemMeta?.identity || null;
  if (identity) {
    const auto = document.createElement('div');
    auto.className = 'field-item auto-field-item';
    const source = identity.jsonPath ? `${identity.attribute} → ${identity.jsonPath}` : (identity.attribute || 'fingerprint internal');
    auto.innerHTML = `<div class="field-title-line"><span class="field-number auto-number">ID</span><b>${escapeHtml(identity.suggestedName || 'record_id')}</b><span class="auto-pill">AUTO</span></div><span>Identitas record · ${escapeHtml(source)}</span><details><summary>Untuk apa ID ini?</summary><code>Deduplikasi · checkpoint · deteksi siklus · identitas ekspor. Tidak perlu dipilih manual.</code></details>`;
    root.appendChild(auto);
  }
  if (!state.project.fields.length) {
    const empty=document.createElement('div');empty.className='field-empty';empty.textContent='Belum ada field.';root.appendChild(empty);
  }
  state.project.fields.forEach((field, index) => {
    const div = document.createElement('div');
    const diagnostic=(state.previewDiagnostics||[]).find(d=>d.name===field.name);
    const structuralProblem=diagnostic&&(Number(diagnostic.ambiguous||0)>0||(diagnostic.required&&Number(diagnostic.missing||0)>0)||Number(diagnostic.coverageDrop||0)>0.15);
    const semanticProblem=diagnostic&&Boolean(diagnostic.semanticCritical);
    const hasWarning=Boolean(structuralProblem||semanticProblem||(diagnostic?.semanticWarnings||[]).length);
    div.className = `field-item selected-field-item${hasWarning?' field-item-warning':''}`;
    const type = field.dataType || 'text';
    const required = field.required ? ' · wajib' : '';
    const diagnosticBadge=hasWarning?`<span class="field-warning-pill" title="Periksa hasil preview field ini">⚠ PERIKSA</span>`:'<span class="selected-pill">TERPILIH</span>';
    const diagnosticText=diagnostic?([
      structuralProblem?`${Number(diagnostic.missing||0)} kosong · ${Number(diagnostic.ambiguous||0)} ambigu${Number(diagnostic.coverageDrop||0)>0.15?' · cakupan turun':''}`:'',
      ...(diagnostic.semanticWarnings||[])
    ].filter(Boolean).join(' · ')):'';
    div.innerHTML = `<div class="field-title-line"><span class="field-number">${index+1}</span><b>${escapeHtml(field.name)}</b>${diagnosticBadge}</div><button title="Hapus field">×</button><span>${escapeHtml(field.extract || 'text')} → ${escapeHtml(type)}${required}</span>${diagnosticText?`<div class="field-diagnostic-text">${escapeHtml(diagnosticText)}</div>`:''}<details><summary>Detail teknis</summary><code>${escapeHtml(field.selector || field.selectors?.[0] || '')}</code></details>`;
    div.querySelector('button').addEventListener('click', () => removeFieldAt(index));
    root.appendChild(div);
  });
  $('previewBtn').disabled = !(state.project.itemSelector && state.project.fields.length);
  $('recordStructureDetails')?.classList.toggle('hidden', !state.project.fields.length);
  if ($('dataWorkspaceFields')) $('dataWorkspaceFields').textContent = identity ? `${state.project.fields.length} + ID` : String(state.project.fields.length);
  renderBrowserMarkers();
  renderFlowCanvas();
}

function renderPagination() {
  const type = state.project.pagination?.type || 'none';
  if ($('paginationType')) $('paginationType').value = type;
  $('paginationSelectorWrap')?.classList.toggle('hidden', !['next', 'loadMore'].includes(type));
  if ($('paginationSelectorView')) $('paginationSelectorView').textContent = state.project.pagination?.selector || 'Belum dipilih';
  const summary = $('paginationSummary');
  if (!summary) return;
  if (state.project.pagination?.selector) {
    const label = state.project.pagination?.meta?.text || (type === 'next' ? 'Tombol Next' : 'Load More');
    summary.innerHTML = `<b>${escapeHtml(label.slice(0, 70))}</b><span>Siap digunakan sebagai ${type === 'next' ? 'halaman berikutnya' : 'Load More'}.</span>`;
    summary.className = 'selection-summary good-summary';
  } else {
    summary.textContent = 'Belum dipilih.';
    summary.className = 'selection-summary empty';
  }
}

function normalizeProject(project) {
  const defaults = createDefaultProject();
  const inferredMode = project.mode || ((project.pagination?.type && project.pagination.type !== 'none') ? 'multipage' : 'quick');
  const rawPagination = { ...defaults.pagination, ...(project.pagination || {}) };
  const usefulPaginationType = ['next', 'loadMore', 'scroll'].includes(rawPagination.type) ? rawPagination.type : rawPagination.lastType;
  rawPagination.lastType = ['next', 'loadMore', 'scroll'].includes(usefulPaginationType) ? usefulPaginationType : 'scroll';
  rawPagination.type = inferredMode === 'multipage' ? rawPagination.lastType : 'none';
  const genericName = /^(?:proyek baru|new project|proyek|project)$/i.test(String(project.name || '').trim());
  const sourceHint=String(project.startUrl||project.source?.sourceUrl||'');
  const savedItemSelector=String(project.itemSelector||'');
  const normalizedItemSelector=/agoda\./i.test(sourceHint)&&/data-element-name\s*=\s*["']?review-comment/i.test(savedItemSelector)&&!/data-review-comment-type/i.test(savedItemSelector)
    ? 'div[data-element-name="review-comment"][data-review-comment-type="comment"]'
    : savedItemSelector;
  const rawSourceFields=Array.isArray(project.fields)?project.fields:[];
  const legacyMemberField=field=>/^(?:member_level|membership_level|loyalty_level|reviewer_member|member_tier|tier|badge|guest_level|tingkat_member)(?:_\d+)?$/i.test(String(field?.name||'')) || /^(?:member_level|membership_level|loyalty_level)$/i.test(String(field?.semanticRole||''));
  const removedLegacyMemberFields=rawSourceFields.filter(legacyMemberField).length;
  const sourceFields=rawSourceFields.filter(field=>!legacyMemberField(field));
  const hasExplicitDateField=sourceFields.some(field=>semanticRoleFromFieldName(field?.name)==='review_date');
  const usedFieldNames=new Set(sourceFields.map(field=>String(field?.name||'').toLowerCase()).filter(Boolean));
  let migratedLegacyDate=false;
  const nextRatingMaxName=()=>{
    if(!usedFieldNames.has('rating_max')){usedFieldNames.add('rating_max');return 'rating_max';}
    let index=2;while(usedFieldNames.has(`rating_max_${index}`))index+=1;
    const name=`rating_max_${index}`;usedFieldNames.add(name);return name;
  };
  const normalizedFields=sourceFields.map(field=>{
    const pickedText=String(field.pickedText||field.targetMeta?.pickedText||'').trim();
    const dateByValue=looksLikeReviewDateText(pickedText);
    const ratingMaxByValue=looksLikeRatingMaxText(pickedText);
    const legacyTextName=/^review_text(?:_?\d+)?$/i.test(String(field.name||''));
    const legacyRatingLabelName=/^rating_label(?:_?\d+)?$/i.test(String(field.name||''));
    const shouldRenameLegacyDate=dateByValue&&legacyTextName&&!hasExplicitDateField&&!migratedLegacyDate;
    const shouldRenameLegacyRatingMax=ratingMaxByValue&&legacyRatingLabelName;
    const normalizedName=shouldRenameLegacyRatingMax?nextRatingMaxName():(shouldRenameLegacyDate?'review_date':field.name);
    if(shouldRenameLegacyDate)migratedLegacyDate=true;
    const semanticRole=ratingMaxByValue&&legacyRatingLabelName?'rating_max':(dateByValue?'review_date':(field.semanticRole||semanticRoleFromFieldName(normalizedName)));
    const semanticSelectors=semanticRole?semanticFallbackSelectors(semanticRole):semanticFallbackSelectors(normalizedName);
    const dataType=semanticRole==='review_date'?'date':semanticRole==='rating_max'?'number':(field.dataType||'text');
    const transform=semanticRole==='rating_max'?'extractNumber':(field.transform||'none');
    return {
      dataType,transform:'none',required:false,...field,name:normalizedName,dataType,transform,semanticRole,
      selectors:[...new Set([...(semanticRole?semanticSelectors:[]),field.selector,...(Array.isArray(field.selectors)?field.selectors:[])].filter(Boolean))].slice(0,24)
    };
  });
  const legacyIdentity = String((!genericName ? project.name : '') || project.reviewSubject || project.source?.objectName || '').replace(/\s+/g, ' ').trim();
  const normalizedName = legacyIdentity || String(project.name || 'Proyek Baru').trim() || 'Proyek Baru';
  const normalized = {
    ...defaults, ...project, version: 23, mode: inferredMode,
    name: normalizedName,
    reviewSubject: legacyIdentity,
    dataTarget: project.dataTarget || 'reviews',
    acquisition: { ...defaults.acquisition, ...(project.acquisition || {}), scope: project.acquisition?.scope || (inferredMode === 'crawl' ? 'site-crawl' : inferredMode === 'multipage' ? 'multiple' : 'current'), limit: Number(project.acquisition?.limit || rawPagination.maxPages || 5) },
    nameAuto: project.nameAuto != null ? Boolean(project.nameAuto) : genericName,
    siteProfile: project.siteProfile === 'generic' ? 'auto' : (SITE_PROFILE_DEFS[project.siteProfile] || project.siteProfile === 'xhr-json' ? project.siteProfile : 'auto'),
    source: { ...defaults.source, ...(project.source || {}), ...(legacyIdentity ? { objectName: legacyIdentity } : {}) },
    itemSelector: normalizedItemSelector,
    itemMeta: project.itemMeta || null,
    itemKeyAttribute: project.itemKeyAttribute || project.itemMeta?.keyAttribute || null,
    itemIdentity: project.itemIdentity || project.itemMeta?.identity || null,
    itemMode: project.itemMode || (project.itemSelector && project.itemMeta?.autoDetected === false ? 'manual' : 'auto'),
    itemLocked: project.itemLocked != null ? Boolean(project.itemLocked) : Boolean(project.itemSelector),
    fields: normalizedFields,
    beforeActions: Array.isArray(project.beforeActions) ? project.beforeActions : [],
    pagination: rawPagination,
    crawl: { ...defaults.crawl, ...(project.crawl || {}) },
    settings: { ...defaults.settings, ...(project.settings || {}) }
  };
  const migrated = AcquisitionPolicy?.migrateProject(normalized) || { project: normalized, migration: [] };
  const migrationNotes = Array.isArray(migrated.migration) ? [...migrated.migration] : [];
  if (removedLegacyMemberFields) migrationNotes.push(`${removedLegacyMemberFields} field member_level lama dihapus karena bukan atribut lintas-situs pada schema review v5.`);
  migrated.project.migrationNotice = migrationNotes.length ? migrationNotes.join(' ') : '';
  return migrated.project;
}

function syncProjectInputs() {
  const inputName = $('projectName').value.trim();
  state.project.name = inputName || 'Proyek Baru';
  state.project.reviewSubject = inputName && !isGenericProjectName(inputName) ? inputName : '';
  state.project.dataTarget = $('dataTarget')?.value || state.project.dataTarget || 'reviews';
  const uiMethod = AcquisitionPolicy?.normalizedMethod($('acquisitionMethod')?.value || state.project.acquisition?.method || 'dom') || 'dom';
  state.project.acquisition = { ...(state.project.acquisition || createDefaultProject().acquisition), method: uiMethod, scope: uiMethod === 'network-json' ? 'all' : ($('acquisitionScope')?.value || state.project.acquisition?.scope || 'current'), limit: Math.max(1, Number($('acquisitionLimit')?.value || state.project.acquisition?.limit || 5)) };
  if (state.project.reviewSubject) state.project.source = { ...(state.project.source || {}), objectName: state.project.reviewSubject, detectedBy: state.project.source?.detectedBy || (state.project.nameAuto === false ? 'manual' : 'project') };
  syncLegacyModeFromAcquisition({ updateControls: false });
  state.project.mode = $('projectMode')?.value || state.project.mode || 'quick';
  state.project.siteProfile = $('siteProfile')?.value || state.project.siteProfile || 'auto';
  if (uiMethod === 'network-json') {
    // HAR/Network has its own explicit provenance field. The live browser URL must
    // never leak into the dataset unless the user deliberately claims it.
    syncNetworkSourceUrlFromInput({ validate: false });
    state.project.startUrl = currentNetworkSourceUrl();
  } else {
    state.project.startUrl = state.project.startUrl || $('urlInput').value.trim();
  }
  if (state.project.mode === 'multipage') {
    const selectedType = $('paginationType').value;
    state.project.pagination.type = ['next', 'loadMore', 'scroll'].includes(selectedType) ? selectedType : (state.project.pagination.lastType || 'next');
    state.project.pagination.lastType = state.project.pagination.type;
  } else {
    state.project.pagination.type = 'none';
  }
  state.project.pagination.maxPages = state.project.mode === 'multipage'
    ? (state.project.acquisition.scope === 'all' ? null : Math.max(1, Number(state.project.acquisition.limit || 5)))
    : 1;
  if ($('maxPages')) $('maxPages').value = state.project.pagination.maxPages;
  state.project.pagination.delayMs = Math.round((Number($('delayMs').value) || 3) * 1000);
  state.project.crawl = state.project.crawl || {};
  state.project.crawl.scope = $('crawlScope')?.value || 'same-host';
  state.project.crawl.maxDepth = Number($('crawlDepth')?.value) || 0;
  state.project.crawl.maxUrls = Number($('crawlMaxUrls')?.value) || 100;
  state.project.crawl.include = $('crawlInclude')?.value.trim() || '';
  state.project.crawl.exclude = $('crawlExclude')?.value.trim() || '';
  state.project.settings.timeoutMs = Math.round((Number($('timeoutMs').value) || 30) * 1000);
  state.project.settings.retryCount = Number($('retryCount').value) || 0;
  state.project.settings.browserZoomPercent = nearestZoomPreset($('browserZoomSelect').value || state.project.settings.browserZoomPercent || 100);
}

function scheduleAutosave() {
  syncProjectInputs();
  clearTimeout(state.autosaveTimer);
  $('autosaveState').textContent = 'Menyimpan…';
  state.autosaveTimer = setTimeout(async () => {
    try {
      await appApi.autosaveProject(state.project, state.projectPath);
      $('autosaveState').textContent = `Autosave ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      $('autosaveState').textContent = 'Autosave gagal';
      setStatus(`Autosave gagal: ${error.message}`);
    }
  }, 600);
}

async function resetManagedBrowserTabs(url = DEFAULT_HOME_URL) {
  const target = String(url || DEFAULT_HOME_URL);
  for (const tab of [...state.browserTabs]) {
    stopBrowserLoadProgress(tab.id);
    try { tab.view?.remove?.(); } catch {}
  }
  state.browserTabs = [];
  state.activeBrowserTabId = '';
  state.browserReady = false;
  state.runtimeFlow.currentUrl = '';
  const tab = createBrowserTab(target, { active: true, title: browserTitleFromUrl(target) });
  if (tab?.view) {
    browser = tab.view;
    try { browser.src = target; } catch {}
  }
  if ($('urlInput')) $('urlInput').value = target;
  $('browserEmpty')?.classList.add('hidden');
  renderBrowserTabs();
  return tab;
}

function clearProjectTransientState() {
  state.pendingRunDir = null;
  state.runViewSnapshot = null;
  state.pendingAutosave = null;
  state.importedSourceUrl = '';
  state.stagedNetworkImport = null;
  state.activeCombinedManifest = null;
  state.combinedBaseDir = null;
  state.combinedBaseName = '';
  state.selectedSessionDirs?.clear?.();
  state.recoverableRun = null;
  state.reviewSubjectDirtySinceNavigation = false;
  state.runtimeFlow = createRuntimeFlow();
  if (state.liveRunRefreshTimer) clearTimeout(state.liveRunRefreshTimer);
  state.liveRunRefreshTimer = null;
  state.liveRunRefreshBusy = false;
  state.liveRunRefreshQueued = false;
  state.liveRunRefreshLastAt = 0;
}

function openResetDialog(initialScope = 'results') {
  if (state.running) return setStatus('Jeda atau tunggu run selesai sebelum membersihkan sesi.');
  const safeScope = initialScope === 'project' ? 'project' : 'results';
  const first = document.querySelector(`input[name="resetScope"][value="${safeScope}"]`);
  if (first) first.checked = true;
  $('closeOldPagesInput').checked = true;
  $('abandonRecoveryInput').checked = true;
  updateResetDialogState();
  $('resetDialog').showModal();
}

function updateResetDialogState() {
  const scope = document.querySelector('input[name="resetScope"]:checked')?.value || 'results';
  $('resetProjectOptions').classList.toggle('hidden', scope !== 'project');
  $('resetResultsChoice').classList.toggle('selected', scope === 'results');
  $('resetProjectChoice').classList.toggle('selected', scope === 'project');
  $('confirmResetBtn').textContent = scope === 'project' ? 'Mulai Proyek Baru' : 'Bersihkan Hasil';
}

function clearVisibleRunState(message = 'Hasil sesi dibersihkan.') {
  setMetricLabels('run');
  state.results = [];
  state.datasetRows = { clean: [], duplicates: [], raw: [] };
  state.datasetCounts = { clean: 0, duplicates: 0, raw: 0, exactDuplicates: 0, possibleDuplicates: 0, text: 0, withoutText: 0, nativeReviewIds: 0, syntheticReviewIds: 0, missingReviewIds: 0 };
  state.activeDataset = 'clean';
  state.previewRows = [];
  state.showingPreview = false;
  state.activeRunDir = null;
  state.activeCombinedDir = null;
  state.activeCombinedManifest = null;
  state.duplicateDecisions = {};
  state.duplicateAuditFilter = 'all';
  state.duplicateAuditSearch = '';
  state.processLogRaw = '';
  state.runtimeFlow = createRuntimeFlow();
  $('logBox').textContent = '';
  $('runStatus').textContent = 'Idle';
  $('runCollected').textContent = '0';
  $('runRaw').textContent = '0';
  $('runDuplicates').textContent = '0';
  if ($('runPossibleDuplicates')) $('runPossibleDuplicates').textContent = Number(state.datasetCounts.possibleDuplicates || 0).toLocaleString('id-ID');
  if ($('runSyntheticIds')) $('runSyntheticIds').textContent = '0';
  if ($('runSyntheticIdsCard')) $('runSyntheticIdsCard').classList.add('hidden');
  document.querySelector('.result-overview-grid')?.classList.remove('identity-audit-metric');
  if ($('openResultFolderBtn')) $('openResultFolderBtn').disabled = true;
  updateDatasetUi();
  renderResults();
  renderFlowMonitor();
  setStatus(message);
}

async function applyResetSelection() {
  const scope = document.querySelector('input[name="resetScope"]:checked')?.value || 'results';
  stopPick();
  state.fieldDialogRevision += 1;
  clearTimeout(state.fieldQualityTimer);
  state.fieldQualityTimer = null;

  if (scope === 'results') {
    clearBrowserHighlights();
    clearVisibleRunState('Hasil sesi dibersihkan. Workflow dan riwayat run di disk tetap aman.');
    return;
  }

  // Full project reset must remove both visual layers: transient picker/highlight
  // state and persistent project markers. v0.22 only cleared the transient layer,
  // which could leave green record boxes and blue field outlines on the page.
  await clearAllBrowserVisuals();
  state.lastPicked = null;
  state.containerCandidates = [];
  state.selectedContainerCandidate = null;
  state.pendingPagination = null;
  state.pendingInferredContainer = null;
  state.detectedContainerIdentity = null;
  state.fieldCandidateSelectors = [];
  state.fieldTargetMeta = null;
  state.fieldExpectedSignature = '';
  state.fieldInitialValidation = null;
  state.fieldPreviewFallbackUsed = false;
  state.fieldPreviewError = '';
  state.previewDiagnostics = [];

  const oldProjectName = state.project.name || 'Proyek Baru';
  const closeOldPages = $('closeOldPagesInput').checked;
  const abandonRecoverable = $('abandonRecoveryInput').checked;
  let currentUrl = '';
  try { currentUrl = browser.getURL?.() || ''; } catch {}
  currentUrl = currentUrl || $('urlInput').value.trim();
  const zoom = nearestZoomPreset(state.project.settings?.browserZoomPercent ?? 100);

  const resetResult = await appApi.resetProjectState({
    projectName: oldProjectName,
    abandonRecoverable
  });

  await clearStagedNetworkImport({ silent: true });
  clearProjectTransientState();
  state.project = createDefaultProject();
  state.project.settings.browserZoomPercent = zoom;
  state.project.startUrl = '';
  state.projectPath = null;
  clearVisibleRunState();
  renderRecoveryCard();
  renderProject();
  await clearAllBrowserVisuals();

  // A new project is isolated from the browser state of the previous project.
  // When old pages are intentionally kept open, they remain passive until the
  // user explicitly presses “Gunakan Halaman Aktif”. This prevents a late SPA
  // navigation/did-finish-load event from re-attaching the old source to the
  // freshly reset project.
  state.browserSourceClaimSuspended = !closeOldPages;
  if (closeOldPages) {
    await resetManagedBrowserTabs(DEFAULT_HOME_URL);
  } else {
    const activeUrl = currentBrowserUrl() || currentUrl || '';
    if ($('urlInput')) $('urlInput').value = activeUrl;
    renderActivePageSourceStatus('');
    renderSourceIdentity();
  }

  await appApi.autosaveProject(state.project, null);
  $('autosaveState').textContent = 'Proyek baru';
  const abandonedText = resetResult?.abandonedRuns ? ` ${resetResult.abandonedRuns} run lama ditandai Ditinggalkan.` : '';
  setStatus(`Proyek baru siap. Konfigurasi, field, navigasi, preview, hasil aktif, dan state run lama telah direset.${closeOldPages ? ' Semua halaman web proyek lama ditutup.' : ' Halaman lama dipertahankan secara pasif; tekan Gunakan Halaman Aktif untuk menjadikannya sumber baru.'}${abandonedText}`);
}

async function saveProject(saveAs) {
  syncProjectInputs();
  const result = await appApi.saveProject(state.project, state.projectPath, saveAs);
  if (!result.canceled) {
    state.projectPath = result.filePath;
    $('autosaveState').textContent = 'Tersimpan';
    setStatus(`Proyek disimpan: ${result.filePath}`);
  }
}

async function openProject() {
  if (state.running) return setStatus('Jeda run terlebih dahulu sebelum membuka proyek lain.');
  const result = await appApi.openProject();
  if (result.canceled) return;
  state.project = normalizeProject(result.project);
  state.projectPath = result.filePath;
  state.activeRunDir = null;
  state.activeCombinedDir = null;
  state.activeCombinedManifest = null;
  state.stagedNetworkImport = null;
  state.results = [];
  state.datasetRows = { clean: [], duplicates: [], raw: [] };
  state.datasetCounts = { clean: 0, duplicates: 0, raw: 0, exactDuplicates: 0, possibleDuplicates: 0, text: 0, withoutText: 0, nativeReviewIds: 0, syntheticReviewIds: 0, missingReviewIds: 0 };
  state.activeDataset = 'clean';
  state.previewRows = [];
  state.showingPreview = false;
  renderProject();
  renderResults();
  loadProjectPage(state.project);
  const migration = state.project.migrationNotice;
  if (migration) {
    state.project.migrationNotice = '';
    setStatus(`Proyek dibuka dan diperbarui: ${migration}`);
  } else setStatus(`Proyek dibuka: ${result.filePath}`);
}

function toggleWorkspacePanel(side = 'left') {
  const cls = side === 'right' ? 'right-panel-collapsed' : 'left-panel-collapsed';
  document.body.classList.toggle(cls);
  const collapsed = document.body.classList.contains(cls);
  const button = side === 'right' ? $('toggleRightPanelBtn') : $('toggleLeftPanelBtn');
  if (button) button.setAttribute('aria-pressed', String(!collapsed));
  try { localStorage.setItem(`petikdata.layout.${side}Panel`, collapsed ? 'collapsed' : 'open'); } catch {}
  setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch {} }, 40);
}

function restoreWorkspacePanelState() {
  document.body.classList.remove('left-panel-collapsed', 'right-panel-collapsed');
  $('toggleLeftPanelBtn')?.setAttribute('aria-pressed', 'true');
}

function validateAcquisitionPolicy(project = state.project) {
  const result = AcquisitionPolicy?.validateProject(project);
  if (result) return result;
  const method = resolvedAcquisitionMethod();
  const site = effectiveSiteProfile(project);
  const ok = method === 'network-json' ? ['traveloka','tiket','agoda','trip','booking'].includes(site) : ['tiket','agoda','trip'].includes(site);
  return ok ? { ok:true, method, site } : { ok:false, code:'UNSUPPORTED_SITE_METHOD', message:'HAR / Network mendukung Traveloka, Tiket, Agoda, Trip, dan Booking; DOM mendukung Tiket, Agoda, dan Trip.' };
}

async function startAcquisition() {
  if (state.running) return setStatus('Pengambilan data sedang berjalan. Gunakan Jeda terlebih dahulu.');
  syncProjectInputs();
  const policy = validateAcquisitionPolicy();
  if (!policy.ok) { switchWorkspaceView('browserView'); return setStatus(policy.message); }
  const method = resolvedAcquisitionMethod();
  const subject = unifiedProjectIdentity();

  if (method === 'network-json') {
    if (!subject) {
      switchWorkspaceView('browserView');
      $('projectName')?.focus();
      return setStatus('Isi “Nama objek / proyek” terlebih dahulu. Nama ini dipakai sebagai identitas dataset, review_subject, folder proyek, dan nama ekspor.');
    }
    return processStagedNetworkJson();
  }

  if (!state.project.source?.importedSnapshot && effectiveSiteProfile() === 'generic') {
    switchWorkspaceView('browserView');
    return setStatus('Halaman Web / DOM mendukung Tiket, Agoda, dan Trip. Untuk Traveloka atau Booking gunakan HAR / Network.');
  }
  const visibleUrl = currentBrowserUrl();
  if (!state.project.source?.importedSnapshot && (!visibleUrl || /^about:blank/i.test(visibleUrl))) {
    switchWorkspaceView('browserView');
    $('urlInput')?.focus();
    return setStatus('Masukkan atau buka URL target terlebih dahulu. Setelah halaman tampil, tekan “Mulai Pengambilan” lagi.');
  }
  if (!state.project.fields.length) {
    switchWorkspaceView('browserView');
    setStatus('Langkah berikutnya: klik satu nilai review yang ingin diambil. MyDataset akan mencari batas satu record secara otomatis.');
    return startPick('field');
  }
  if (!state.project.itemSelector) {
    switchWorkspaceView('browserView');
    setStatus('Field sudah ada, tetapi batas satu record belum ditemukan. Klik satu kartu/record review sebagai batas data.');
    return startPick('item');
  }
  return runProject();
}

async function runProject() {
  if (state.running) return setStatus('Run sudah berjalan. Gunakan Jeda atau Hentikan sebelum memulai run lain.');
  if (state.browserSourceClaimSuspended) return setStatus('Halaman lama masih dipertahankan secara pasif. Tekan “Gunakan Halaman Aktif” sebelum menjalankan proyek baru.');
  syncProjectInputs();
  const policy = validateAcquisitionPolicy();
  if (!policy.ok || policy.method !== 'dom') return setStatus(policy.ok ? 'Run halaman hanya tersedia untuk metode Halaman Web / DOM.' : policy.message);
  await refreshSourceIdentity({ claimPage: true, silent: true });
  syncProjectInputs();
  if (!state.project.startUrl) state.project.startUrl = $('urlInput').value.trim();
  if (state.project.fields.length === 0) return setStatus('Rancangan belum lengkap: pilih minimal satu data.');
  if (!state.project.itemSelector) return setStatus('MyDataset belum menemukan batas satu record. Pilih data lagi atau atur batas record secara manual.');
  if (!state.project.source?.importedSnapshot && effectiveSiteProfile() === 'generic') return setStatus('Website tidak sesuai metode. DOM hanya untuk Tiket/Agoda/Trip; Traveloka dan Booking hanya melalui HAR/Network.');
  const currentHost = httpHost(currentBrowserUrl() || state.project.startUrl || '');
  const staleFields = state.project.fields.filter(field => field.sourceHost && currentHost && field.sourceHost !== currentHost);
  if (staleFields.length) {
    resetExtractionDesignForSourceChange();
    return setStatus('Field berasal dari website sebelumnya dan sudah dilepas. Pilih field pada halaman aktif agar selector tidak tercampur antar-situs.');
  }
  if ((state.project.dataTarget || 'reviews') === 'reviews') {
    const hasReviewText = state.project.fields.some(field => field.semanticRole === 'review_text' || semanticRoleFromFieldName(field.name) === 'review_text');
    if (!hasReviewText) {
      switchWorkspaceView('browserView');
      return setStatus('Review belum lengkap: pilih isi ulasan sebagai field review_text sebelum menjalankan. Field ini diperlukan agar dataset NLP tidak berisi rating/tanggal saja.');
    }
    const preflight = await previewCurrentPage({ silent: true });
    if (!preflight?.ok) {
      const names = (preflight?.critical || []).slice(0,4).map(item => item.name).join(', ');
      return setStatus(`Run belum dimulai karena field halaman aktif belum konsisten${names ? ` (${names})` : ''}. Periksa pemetaan field sebelum menjalankan.`);
    }
  }
  if (state.project.mode === 'multipage' && ['next', 'loadMore'].includes(state.project.pagination.type) && !state.project.pagination.selector) return setStatus('Mode Banyak Halaman membutuhkan tombol navigasi. Pilih tombol di halaman atau ubah metode menjadi Scroll Otomatis.');
  const criticalPreview=(state.previewDiagnostics||[]).filter(d=>previewDiagnosticIsCritical(d,state.project.fields.find(field=>field.name===d.name)));
  if(state.showingPreview&&criticalPreview.length){
    const names=criticalPreview.slice(0,4).map(d=>d.name).join(', ');
    return setStatus(`Run belum dimulai: preview terakhir masih menemukan field tidak konsisten (${names}). Perbaiki field tersebut lalu tekan “Periksa Hasil Halaman Ini” lagi.`);
  }

  await appApi.autosaveProject(state.project, state.projectPath);
  $('logBox').textContent = '';
  beginRuntimeFlow('Menyiapkan run baru dan folder penyimpanan…');
  switchWorkspaceView('flowView', { focusLive: true });
  state.runViewSnapshot = captureDatasetView();
  state.pendingRunDir = null;
  setRunningUi(true);
  // Dataset yang sedang ditampilkan tidak dikosongkan di awal run. Run baru
  // bekerja secara transaksional dan baru menggantikan tampilan setelah sukses.
  // Jika run baru gagal/parsial, dataset sebelumnya tetap aman dan tetap terlihat.
  setStatus(state.project.mode === 'crawl' ? 'Menjalankan crawler + scraper lokal dengan penyimpanan bertahap…' : 'Menjalankan ekstraksi lokal dengan penyimpanan bertahap…');
  let retryRequest = null;
  try {
    let webContentsId = null;
    try { webContentsId = browser.getWebContentsId?.() || null; } catch {}
    await keepLiveBrowserResponsive(webContentsId);
    const result = await appApi.runProject(state.project, webContentsId);
    await applyRunResult(result);
    if (result.ok && !result.partial && !result.paused) { if (effectiveSiteProfile() === 'trip') state.tripDomPaginationFailureCount = 0; await keepCompletedFlowVisible(500); switchWorkspaceView('dataView'); }
    if (!result.ok && !result.paused && !result.canceled) {
      const action = await showAcquisitionFailureDialog({
        message: result.failure?.message || result.error || result.state?.lastMessage || 'Run berhenti sebelum selesai.',
        stage: failureStageForCode(result.failure?.code, state.runtimeFlow.failureStage || state.runtimeFlow.lastOperationalStage), code:result.failure?.code, details:result.failure?.details,
        collected: result.totalRows || result.state?.itemsCollected || 0,
        runDir: result.runDir || '', method: 'dom', partial: Boolean(result.partial)
      });
      if (action === 'retry') retryRequest = result.runDir ? { type:'resume', runDir:result.runDir } : { type:'restart' };
      else if (result.runDir) { try { await appApi.markRunStopped?.(result.runDir); } catch {} }
    }
  } catch (error) {
    advanceRuntimeFlow({stage:'error',message:`Run gagal: ${error.message}`});
    const failedRunDir = state.pendingRunDir || '';
    // Live checkpoint preview temporarily replaces state.results. If the runner
    // itself throws before applyRunResult can perform the transactional rollback,
    // explicitly restore the committed dataset snapshot here.
    if (state.runViewSnapshot) restoreDatasetView(state.runViewSnapshot);
    state.runViewSnapshot = null;
    setStatus(`Run baru gagal dan tidak mengubah dataset yang sedang ditampilkan: ${error.message}`);
    const action = await showAcquisitionFailureDialog({ message:error.message, stage:state.runtimeFlow.failureStage || state.runtimeFlow.lastOperationalStage, collected:state.runtimeFlow.rows||0, runDir:failedRunDir, method:'dom' });
    if (action === 'retry') retryRequest = failedRunDir ? { type:'resume', runDir:failedRunDir } : { type:'restart' };
    else if (failedRunDir) { try { await appApi.markRunStopped?.(failedRunDir); } catch {} }
    state.pendingRunDir = null;
  } finally {
    setRunningUi(false);
    await refreshRecoverableRun();
  }
  if (retryRequest?.type === 'resume') return resumeRun(retryRequest.runDir);
  if (retryRequest?.type === 'restart') return runProject();
}

async function pauseRun() {
  if (!state.running) return setStatus('Tidak ada run aktif yang dapat dijeda.');
  const result = await appApi.pauseRun();
  setStatus(result.message || 'Permintaan pause dikirim.');
  $('pauseBtn').disabled = true;
}

async function resumeRun(runDir) {
  if (!runDir || state.running) return;
  $('logBox').textContent = '';
  beginRuntimeFlow('Memuat checkpoint dan menyiapkan kelanjutan proses…');
  switchWorkspaceView('flowView', { focusLive: true });
  setRunningUi(true);
  state.showingPreview = false;
  state.activeCombinedDir = null;
  state.activeCombinedManifest = null;
  state.activeRunDir = runDir;
  setMetricLabels('run');
  setStatus('Melanjutkan run dari checkpoint…');
  let retryAgain = false;
  try {
    await keepLiveBrowserResponsive();
    let webContentsId = null;
    try { webContentsId = browser.getWebContentsId?.() || null; } catch {}
    const result = await appApi.resumeRun(runDir, webContentsId);
    await applyRunResult(result);
    if (result.ok && !result.partial && !result.paused) { await keepCompletedFlowVisible(500); switchWorkspaceView('dataView'); }
    if (!result.ok && !result.paused && !result.canceled) {
      const action = await showAcquisitionFailureDialog({ message:result.failure?.message || result.error || result.state?.lastMessage || 'Kelanjutan run gagal.', stage:failureStageForCode(result.failure?.code, state.runtimeFlow.failureStage || state.runtimeFlow.lastOperationalStage), code:result.failure?.code, details:result.failure?.details, collected:result.totalRows || result.state?.itemsCollected || 0, runDir:result.runDir || runDir, method:'dom', partial:Boolean(result.partial) });
      retryAgain = action === 'retry';
      if (!retryAgain) { try { await appApi.markRunStopped?.(result.runDir || runDir); } catch {} }
    }
  } catch (error) {
    advanceRuntimeFlow({stage:'error',message:`Resume gagal: ${error.message}`});
    setStatus(`Resume gagal: ${error.message}`);
    const action = await showAcquisitionFailureDialog({ message:error.message, stage:state.runtimeFlow.failureStage || state.runtimeFlow.lastOperationalStage, collected:state.runtimeFlow.rows||0, runDir, method:'dom' });
    retryAgain = action === 'retry';
    if (!retryAgain) { try { await appApi.markRunStopped?.(runDir); } catch {} }
  } finally {
    setRunningUi(false);
    await refreshRecoverableRun();
  }
  if (retryAgain) return resumeRun(runDir);
}

async function applyRunResult(result) {
  const runState = result.state || {};
  const previous = state.runViewSnapshot;
  const previousHasData = Boolean(previous && (Number(previous.datasetCounts?.clean || 0) > 0 || Number(previous.datasetCounts?.raw || 0) > 0));
  const completedCleanly = Boolean(result.ok && !result.partial && !result.paused);
  const commitNewDataset = completedCleanly || !previousHasData;

  if (commitNewDataset) {
    state.showingPreview = false;
    state.activeCombinedDir = null;
    state.activeCombinedManifest = null;
    setMetricLabels('run');
    state.activeRunDir = result.runDir || state.pendingRunDir || state.activeRunDir;
    state.results = result.rows || [];
    state.datasetRows = { clean: state.results, duplicates: [], raw: [] };
    state.activeDataset = 'clean';
    state.datasetCounts = {
      clean: Number(runState.itemsCollected ?? result.totalRows ?? state.results.length),
      raw: Number(runState.rawItemsRead ?? runState.itemsCollected ?? result.totalRows ?? state.results.length),
      exactDuplicates: Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0),
      possibleDuplicates: Number(runState.possibleDuplicates || 0),
      duplicates: Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0) + Number(runState.possibleDuplicates || 0),
      text: Number(runState.textRecords ?? result.importSummary?.textReviews ?? 0),
      withoutText: Number(runState.withoutTextRecords ?? result.importSummary?.emptyTextReviews ?? 0),
      nativeReviewIds: Number(runState.nativeReviewIds ?? 0),
      syntheticReviewIds: Number(runState.syntheticReviewIds ?? 0),
      missingReviewIds: Number(runState.missingReviewIds ?? 0)
    };
    updateDatasetUi();
    renderResults(result.totalRows);
  } else {
    restoreDatasetView(previous);
  }
  state.pendingRunDir = null;
  state.runViewSnapshot = null;
  mergeProcessLogs(result.logs || [], result.error || '');
  if (state.activeView === 'logView') renderProcessSummary(runState, state.processLogRaw);
  if (result.state) {
    if (commitNewDataset) updateRunMetrics(result.state);
    else {
      $('runStatus').textContent = humanRunStatus(result.state.status);
      $('runCollected').textContent = Number(result.state.itemsCollected || 0).toLocaleString('id-ID');
      $('runRaw').textContent = Number(result.state.rawItemsRead ?? result.state.itemsCollected ?? 0).toLocaleString('id-ID');
      $('runDuplicates').textContent = Number(result.state.exactDuplicates ?? result.state.duplicatesSkipped ?? 0).toLocaleString('id-ID');
      if ($('runPossibleDuplicates')) $('runPossibleDuplicates').textContent = Number(result.state.possibleDuplicates || 0).toLocaleString('id-ID');
    }
  }
  if(result.paused && result.accessIssue) advanceRuntimeFlow({stage:'access-required',message:result.state?.lastMessage||'Run dijeda karena situs membutuhkan akses manual.',itemsCollected:result.totalRows||0,currentUrl:result.accessIssue.currentUrl||''});
  else if(result.paused) advanceRuntimeFlow({stage:'partial',message:'Run dijeda pada checkpoint aman.',itemsCollected:result.totalRows||0});
  else if(result.partial) advanceRuntimeFlow({stage:'partial',message:result.error||'Run berhenti parsial; hasil sementara tetap aman.',itemsCollected:result.totalRows||0});
  else if((result.sourceLimited || runState.status === 'completed_source_limit') && state.runtimeFlow.stage!=='done') advanceRuntimeFlow({stage:'done',message:`Selesai pada batas sumber: ${result.totalRows||state.results.length} record hasil dipertahankan.`,itemsCollected:result.totalRows||state.results.length});
  else if((result.stepLimited || runState.status === 'completed_step_limit') && state.runtimeFlow.stage!=='done') advanceRuntimeFlow({stage:'done',message:`Selesai sesuai batas langkah: ${result.totalRows||state.results.length} record hasil. Akhir sumber belum terverifikasi.`,itemsCollected:result.totalRows||state.results.length});
  else if((result.sourceEnded || runState.sourceEndReason === 'PAGINATION_END_REACHED') && state.runtimeFlow.stage!=='done') advanceRuntimeFlow({stage:'done',message:`Selesai: ${result.totalRows||state.results.length} record hasil. Akhir sumber terverifikasi.`,itemsCollected:result.totalRows||state.results.length});
  else if(result.ok && state.runtimeFlow.stage!=='done') advanceRuntimeFlow({stage:'done',message:`Selesai: ${result.totalRows||state.results.length} record hasil.`,itemsCollected:result.totalRows||state.results.length});
  else if(!result.ok && state.runtimeFlow.stage!=='error') advanceRuntimeFlow({stage:'error',message:result.error||'Run gagal.',itemsCollected:result.totalRows||0});
  if (result.paused && result.accessIssue) {
    state.runtimeFlow.accessStatus = result.accessIssue.state || 'restricted';
    renderBrowserAccessNotice(state.runtimeFlow.accessStatus);
    switchWorkspaceView('browserView');
    setStatus('Akses situs dibatasi. Gunakan HAR / Network atau buka halaman di Chrome.');
  } else if (result.paused) setStatus(`Run dijeda. ${result.totalRows || 0} record tersimpan.`);
  else if (result.partial) setStatus(previousHasData ? `Run baru berhenti parsial. ${result.totalRows || 0} baris baru tetap tersimpan di Riwayat; dataset sebelumnya tidak diganti.` : `Run berhenti parsial. ${result.totalRows || state.results.length} baris aman tersimpan; lihat log pagination.`);
  else if (result.sourceLimited || runState.status === 'completed_source_limit') setStatus(`Selesai pada batas sumber. ${state.datasetCounts.clean.toLocaleString('id-ID')} record berhasil dipertahankan; sumber tidak lagi memberikan record stabil setelah batas yang teramati. Kelengkapan terhadap seluruh populasi sumber tidak diklaim.`);
  else if (result.stepLimited || runState.status === 'completed_step_limit') setStatus(`Selesai sesuai batas langkah pengguna. ${state.datasetCounts.clean.toLocaleString('id-ID')} record berhasil dikumpulkan. Run memenuhi cakupan yang diminta, tetapi akhir sumber belum terverifikasi tanpa navigasi tambahan.`);
  else if (result.sourceEnded || runState.sourceEndReason === 'PAGINATION_END_REACHED') setStatus(`Selesai. ${state.datasetCounts.clean.toLocaleString('id-ID')} record berhasil dikumpulkan dan akhir sumber terverifikasi tanpa navigasi tambahan.`);
  else if (result.ok) setStatus(`Selesai. ${state.datasetCounts.raw} record sumber → ${state.datasetCounts.clean} record hasil; ${state.datasetCounts.exactDuplicates} duplikat pasti, ${state.datasetCounts.possibleDuplicates} potensi duplikat.${previousHasData ? ' Dataset sebelumnya tetap tersimpan di Riwayat.' : ''}`);
  else setStatus(previousHasData ? `Run baru gagal dan tidak mengganti dataset sebelumnya. Detail run baru tetap tersedia di Riwayat.` : `Run gagal: ${result.error || 'lihat log run'}`);
}

function setRunningUi(running) {
  state.running = running;
  state.runtimeFlow.running = Boolean(running) && !['done','partial','error'].includes(state.runtimeFlow.stage);
  if ($('startAcquisitionBtn')) $('startAcquisitionBtn').disabled = running;
  $('saveAsBtn').disabled = running;
  $('newProjectBtn').disabled = running;
  $('openBtn').disabled = running;
  $('resetBtn').disabled = running;
  $('goBtn').disabled = running;
  if ($('historyClearBtn')) $('historyClearBtn').disabled = running || $('historyClearBtn').dataset.empty === 'true';
  if ($('useActivePageBtn')) $('useActivePageBtn').disabled = running;
  $('projectMenu')?.classList.toggle('is-disabled', running);
  if (running) closeProjectMenu();
  $('pauseBtn').classList.toggle('hidden', !running);
  $('pauseBtn').disabled = false;
  if(!running){
    if(state.liveRunRefreshTimer){clearTimeout(state.liveRunRefreshTimer);state.liveRunRefreshTimer=null;}
    state.liveRunRefreshQueued=false;
    state.flowController?.setViewMode?.('overview',{reframe:false});
    state.lastRunBrowserActivity=null;
    syncBrowserRunActivity(null);
  } else {
    syncBrowserRunActivity(state.lastRunBrowserActivity || { stage:'starting', message:'Menyiapkan pengambilan…' });
  }
  if (running) $('runStatus').textContent = 'Berjalan';
  else if (['Running', 'Berjalan'].includes($('runStatus').textContent)) $('runStatus').textContent = 'Idle';

  // Keep export/source controls consistent at the exact moment running changes,
  // not only after the next table render. This prevents exporting a live pending
  // checkpoint by accident and re-enables the committed dataset after completion.
  const noDatasetExport = running || state.showingPreview || (!state.results.length && !state.activeRunDir);
  if ($('exportCsvBtn')) $('exportCsvBtn').disabled = noDatasetExport;
  if ($('exportStandardCsvBtn')) $('exportStandardCsvBtn').disabled = noDatasetExport;
  if ($('exportStandardXlsxBtn')) $('exportStandardXlsxBtn').disabled = noDatasetExport;
  if ($('exportJsonBtn')) $('exportJsonBtn').disabled = noDatasetExport;
  if ($('exportBundleBtn')) $('exportBundleBtn').disabled = running || state.showingPreview || !state.activeRunDir;
  if ($('dataExportBtn')) $('dataExportBtn').disabled = running || state.showingPreview || (!state.results.length && !state.activeRunDir && !state.activeCombinedDir);
  if ($('dataExportStandardBtn')) $('dataExportStandardBtn').disabled = running || state.showingPreview || (!state.results.length && !state.activeRunDir && !state.activeCombinedDir);
  if ($('dataExportXlsxBtn')) $('dataExportXlsxBtn').disabled = running || state.showingPreview || (!state.results.length && !state.activeRunDir && !state.activeCombinedDir);
  if ($('dataExportBundleBtn')) $('dataExportBundleBtn').disabled = running || state.showingPreview || Boolean(state.activeCombinedDir) || !state.activeRunDir;
  if ($('processDetailsFromFlowBtn')) $('processDetailsFromFlowBtn').disabled = running ? !currentRunReadDir() : !state.activeRunDir;
  updateDatasetUi();
  updateBrowserKeepAlive();
  syncBrowserMonitor();
  renderFlowMonitor();
}


function currentRunReadDir() {
  // Never fall back to the previously committed run while a new transaction is
  // starting. Until the new runner reports its runDir there is simply no live
  // checkpoint to read yet.
  if (state.running) return state.pendingRunDir || '';
  return state.activeRunDir || '';
}

async function refreshLiveRunUi() {
  const runDir = currentRunReadDir();
  if (!runDir || state.liveRunRefreshBusy) return;
  state.liveRunRefreshBusy = true;
  state.liveRunRefreshLastAt = Date.now();
  try {
    const needRows = state.running && resolvedAcquisitionMethod() === 'dom' && state.activeView === 'dataView' && state.activeDataset === 'clean';
    const needProcess = state.activeView === 'logView';
    if (!needRows && !needProcess) return;

    const data = await appApi.getRunResults(runDir, 300, Boolean(state.running));
    const runState = data?.state || {};
    if (state.running && runDir !== currentRunReadDir()) return;

    if (needRows) {
      // The committed dataset remains protected by runViewSnapshot. While the
      // run is active we only mirror the checkpoint into the table, showing the
      // latest 300 records so users can see continued growth without rendering
      // thousands of DOM rows.
      state.showingPreview = false;
      state.activeCombinedDir = null;
      state.activeCombinedManifest = null;
      state.activeDataset = 'clean';
      state.results = Array.isArray(data?.rows) ? data.rows : [];
      state.datasetRows.clean = state.results;
      state.datasetCounts = {
        clean: Number(runState.itemsCollected ?? data?.counts?.clean ?? state.results.length),
        raw: Number(runState.rawItemsRead ?? data?.counts?.raw ?? runState.itemsCollected ?? state.results.length),
        exactDuplicates: Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? data?.counts?.exactDuplicates ?? 0),
        possibleDuplicates: Number(runState.possibleDuplicates ?? data?.counts?.possibleDuplicates ?? 0),
        duplicates: Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? data?.counts?.exactDuplicates ?? 0) + Number(runState.possibleDuplicates ?? data?.counts?.possibleDuplicates ?? 0),
        text: Number(runState.textRecords ?? data?.counts?.text ?? 0),
        withoutText: Number(runState.withoutTextRecords ?? data?.counts?.withoutText ?? 0),
        nativeReviewIds: Number(runState.nativeReviewIds ?? data?.counts?.nativeReviewIds ?? 0),
        syntheticReviewIds: Number(runState.syntheticReviewIds ?? data?.counts?.syntheticReviewIds ?? 0),
        missingReviewIds: Number(runState.missingReviewIds ?? data?.counts?.missingReviewIds ?? 0)
      };
      updateDatasetUi();
      renderResults(state.datasetCounts.clean);
    }

    if (needProcess) {
      renderProcessSummary(runState, state.processLogRaw);
      if (appApi.getRunLog) {
        try {
          const log = await appApi.getRunLog(runDir);
          if (log?.text != null) {
            state.processLogRaw = String(log.text || '');
            if ($('logBox')) {
              const box = $('logBox');
              const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
              box.textContent = state.processLogRaw;
              if (nearBottom) box.scrollTop = box.scrollHeight;
            }
          }
        } catch {}
      }
    }
  } catch {
    // A checkpoint can be between atomic state updates while the runner is
    // writing. The next progress event retries; the active run itself is not
    // affected by a transient UI read failure.
  } finally {
    state.liveRunRefreshBusy = false;
    if (state.liveRunRefreshQueued) {
      state.liveRunRefreshQueued = false;
      scheduleLiveRunUiRefresh({ immediate: true });
    }
  }
}

function scheduleLiveRunUiRefresh({ immediate = false } = {}) {
  if (!state.running || !currentRunReadDir()) return;
  if (state.liveRunRefreshBusy) {
    state.liveRunRefreshQueued = true;
    return;
  }
  if (state.liveRunRefreshTimer) return;
  const elapsed = Date.now() - Number(state.liveRunRefreshLastAt || 0);
  const delay = immediate ? 0 : Math.max(0, 900 - elapsed);
  state.liveRunRefreshTimer = setTimeout(() => {
    state.liveRunRefreshTimer = null;
    refreshLiveRunUi();
  }, delay);
}

function browserRunActivityLabel(payload = {}) {
  const stage = String(payload.stage || '');
  const sitePage = Number(payload.sitePage || 0) || null;
  const page = Number(payload.page || 0) || null;
  const collected = payload.itemsCollected != null ? Number(payload.itemsCollected) : null;
  const pageLabel = sitePage ? `halaman situs ${sitePage}` : page ? `langkah ${page}` : '';
  const suffix = collected != null ? ` · ${collected.toLocaleString('id-ID')} record` : '';
  const labels = {
    starting:'Menyiapkan pengambilan', loading:'Memuat halaman', expanding:'Menyiapkan review',
    extracting:'Mengambil data', normalizing:'Membersihkan data', deduplicating:'Memeriksa duplikat',
    checkpoint:'Checkpoint tersimpan', pagination:'Pindah halaman', 'pagination-confirmed':'Halaman terverifikasi',
    'pagination-recovery':'Memulihkan halaman', 'pagination-recovered':'Halaman dipulihkan',
    replaying:'Memulihkan checkpoint', scrolling:'Menggulir halaman', retry:'Mencoba lagi'
  };
  const base = labels[stage] || 'Pengambilan aktif';
  return `${base}${pageLabel ? ` · ${pageLabel}` : ''}${suffix}`;
}

function syncBrowserRunActivity(payload = state.lastRunBrowserActivity) {
  const pill = $('browserRunStatus');
  const text = $('browserRunStatusText');
  if (!state.running || !payload) {
    pill?.classList.add('hidden');
    if (text) text.textContent = '';
    return;
  }
  state.lastRunBrowserActivity = payload;
  const label = browserRunActivityLabel(payload);
  pill?.classList.remove('hidden');
  if (text) text.textContent = label;
  const tab = browserTabById();
  if (!tab) return;
  const stage = String(payload.stage || '');
  const busy = !['checkpoint','done','partial','error'].includes(stage);
  const progressByStage = {
    starting:10, loading:18, expanding:28, extracting:48, normalizing:62,
    deduplicating:76, checkpoint:90, pagination:38, 'pagination-confirmed':82,
    'pagination-recovery':45, 'pagination-recovered':84, replaying:42, scrolling:45, retry:35
  };
  updateBrowserTab(tab.id, {
    loading: busy,
    loadText: label,
    progress: busy ? Number(progressByStage[stage] ?? 55) : 100
  });
  updateBrowserMonitorText(payload);
  if (browserMonitorShouldShow() && ['checkpoint','pagination-confirmed','pagination-recovered','extracting'].includes(stage)) refreshBrowserMonitorFrame();
}

async function resyncLiveBrowserSurface() {
  if (!browser) return false;
  await keepLiveBrowserResponsive();
  try {
    const id = browser.getWebContentsId?.() || null;
    if (id != null) await appApi.refreshBrowserSurface?.(id);
  } catch {}
  try {
    await browser.executeJavaScript(`(() => {
      try { window.dispatchEvent(new Event('resize')); } catch {}
      try { window.dispatchEvent(new Event('scroll')); } catch {}
      try { document.documentElement?.getBoundingClientRect(); document.body?.getBoundingClientRect(); } catch {}
      return { url: location.href, title: document.title };
    })()`, true);
  } catch {}
  try { applyBrowserZoom(); } catch {}
  try { browser.focus(); } catch {}
  if (state.running) syncBrowserRunActivity(state.lastRunBrowserActivity);
  return true;
}

function handleRunProgress(payload) {
  state.lastRunBrowserActivity = payload || null;
  syncBrowserRunActivity(payload);
  setStatus(payload.message || 'Run berjalan…');
  if (payload.runDir) {
    if (state.running) state.pendingRunDir = payload.runDir;
    else state.activeRunDir = payload.runDir;
    if ($('processDetailsBtn')) $('processDetailsBtn').disabled = state.showingPreview || !currentRunReadDir() || Boolean(state.activeCombinedDir);
    if ($('processDetailsFromFlowBtn')) $('processDetailsFromFlowBtn').disabled = false;
  }
  if (payload.itemsCollected != null) $('runCollected').textContent = Number(payload.itemsCollected).toLocaleString('id-ID');
  if (payload.rawItemsRead != null) $('runRaw').textContent = Number(payload.rawItemsRead).toLocaleString('id-ID');
  if (payload.duplicatesSkipped != null) $('runDuplicates').textContent = Number(payload.duplicatesSkipped).toLocaleString('id-ID');
  if (payload.possibleDuplicates != null && $('runPossibleDuplicates')) $('runPossibleDuplicates').textContent = Number(payload.possibleDuplicates).toLocaleString('id-ID');
  const statusMap = { starting:'Menyiapkan', loading: 'Memuat', crawling: 'Menjelajah', discovering: 'Mencari URL', 'access-guard': 'Pemeriksaan akses', expanding: 'Membuka teks', extracting: 'Mengambil data', normalizing:'Membersihkan nilai', deduplicating:'Memeriksa duplikat', checkpoint: 'Tersimpan', pagination:'Pindah halaman', 'pagination-confirmed':'Halaman berubah', 'pagination-recovery':'Memulihkan pagination', 'pagination-recovered':'Pagination pulih', 'pagination-end':'Akhir pagination', scrolling: 'Menggulir', replaying: 'Melanjutkan', retry: 'Mencoba lagi', exporting:'Mengekspor', done: 'Selesai', partial: 'Parsial', error: 'Gagal' };
  $('runStatus').textContent = statusMap[payload.stage] || payload.stage || 'Berjalan';
  state.runtimeFlow.runStatus = $('runStatus').textContent;
  advanceRuntimeFlow(payload);
  renderFlowCanvas(false,{runtimeOnly:true});
  scheduleLiveRunUiRefresh();
}

function updateIdentityAuditMetric(runState = {}, counts = state.datasetCounts || {}) {
  const synthetic = Number(runState.syntheticReviewIds ?? counts.syntheticReviewIds ?? 0);
  const native = Number(runState.nativeReviewIds ?? counts.nativeReviewIds ?? 0);
  const missing = Number(runState.missingReviewIds ?? counts.missingReviewIds ?? 0);
  if ($('runSyntheticIds')) $('runSyntheticIds').textContent = synthetic.toLocaleString('id-ID');
  const showSynthetic = !Boolean(state.activeCombinedDir) && synthetic > 0;
  if ($('runSyntheticIdsCard')) {
    $('runSyntheticIdsCard').classList.toggle('hidden', !showSynthetic);
    $('runSyntheticIdsCard').title = `${native.toLocaleString('id-ID')} ID sumber · ${synthetic.toLocaleString('id-ID')} ID sintetis · ${missing.toLocaleString('id-ID')} tanpa ID`;
  }
  document.querySelector('.result-overview-grid')?.classList.toggle('identity-audit-metric', showSynthetic);
}

function updateRunMetrics(runState) {
  setMetricLabels('run');
  $('runStatus').textContent = humanRunStatus(runState.status);
  $('runCollected').textContent = Number(runState.itemsCollected || 0).toLocaleString('id-ID');
  $('runRaw').textContent = Number(runState.rawItemsRead ?? runState.itemsCollected ?? 0).toLocaleString('id-ID');
  $('runDuplicates').textContent = Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0).toLocaleString('id-ID');
  if ($('runPossibleDuplicates')) $('runPossibleDuplicates').textContent = Number(runState.possibleDuplicates || 0).toLocaleString('id-ID');
  state.datasetCounts = {
    clean: Number(runState.itemsCollected || 0),
    raw: Number(runState.rawItemsRead ?? runState.itemsCollected ?? 0),
    exactDuplicates: Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0),
    possibleDuplicates: Number(runState.possibleDuplicates || 0),
    duplicates: Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0) + Number(runState.possibleDuplicates || 0),
    text: Number(runState.textRecords ?? state.datasetCounts?.text ?? 0),
    withoutText: Number(runState.withoutTextRecords ?? state.datasetCounts?.withoutText ?? 0),
    nativeReviewIds: Number(runState.nativeReviewIds ?? state.datasetCounts?.nativeReviewIds ?? 0),
    syntheticReviewIds: Number(runState.syntheticReviewIds ?? state.datasetCounts?.syntheticReviewIds ?? 0),
    missingReviewIds: Number(runState.missingReviewIds ?? state.datasetCounts?.missingReviewIds ?? 0)
  };
  updateIdentityAuditMetric(runState, state.datasetCounts);
  updateDatasetUi();
  state.runtimeFlow.rows=Number(runState.itemsCollected||0); state.runtimeFlow.duplicates=Number(runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0); state.runtimeFlow.possibleDuplicates=Number(runState.possibleDuplicates||0); state.runtimeFlow.runStatus=humanRunStatus(runState.status);
  state.runtimeFlow.visitedUrls=Number(runState.crawlVisited?.length||state.runtimeFlow.visitedUrls||0); state.runtimeFlow.queuedUrls=Number(runState.crawlQueue?.length||0); renderFlowCanvas();
}

async function refreshRecoverableRun() {
  state.recoverableRun = null;
}

function renderRecoveryCard() {
  const card = $('recoveryCard');
  if (card) card.classList.add('hidden');
}

async function showRunsDialog() {
  const runs = await appApi.listRuns();
  const root = $('runsList');
  root.innerHTML = '';
  if (!runs.length) root.innerHTML = '<div class="empty-list">Belum ada riwayat run.</div>';
  for (const run of runs) {
    const row = document.createElement('div');
    row.className = 'run-row';
    row.innerHTML = `<div><b>${escapeHtml(run.projectName || 'Proyek')}</b><span>${escapeHtml(runSiteLabel(run))} · ${escapeHtml(runAcquisitionLabel(run))} · ${escapeHtml(humanRunStatus(run.status))} · ${Number(run.itemsCollected || 0).toLocaleString('id-ID')} record · ${escapeHtml(formatDate(run.updatedAt))}</span></div><div class="run-row-actions"></div>`;
    const actions = row.querySelector('.run-row-actions');
    const view = document.createElement('button');
    view.textContent = 'Lihat';
    view.addEventListener('click', async () => {
      const data = await appApi.getRunResults(run.runDir, 300);
      state.showingPreview = false;
      state.activeCombinedDir = null;
      state.activeCombinedManifest = null;
      setMetricLabels('run');
      state.activeRunDir = run.runDir;
      state.results = data.rows || [];
      state.datasetRows = { clean: state.results, duplicates: [], raw: [] };
      state.datasetCounts = data.counts || { clean: Number(data.state?.itemsCollected || state.results.length), raw: Number(data.state?.rawItemsRead || data.state?.itemsCollected || state.results.length), duplicates: Number(data.state?.exactDuplicates ?? data.state?.duplicatesSkipped ?? 0) + Number(data.state?.possibleDuplicates || 0), exactDuplicates: Number(data.state?.exactDuplicates ?? data.state?.duplicatesSkipped ?? 0), possibleDuplicates: Number(data.state?.possibleDuplicates || 0), text:Number(data.counts?.text||0), withoutText:Number(data.counts?.withoutText||0), nativeReviewIds:Number(data.counts?.nativeReviewIds||data.state?.nativeReviewIds||0), syntheticReviewIds:Number(data.counts?.syntheticReviewIds||data.state?.syntheticReviewIds||0), missingReviewIds:Number(data.counts?.missingReviewIds||data.state?.missingReviewIds||0) };
      state.activeDataset = 'clean';
      updateDatasetUi();
      renderResults(data.state?.itemsCollected);
      if (data.state) updateRunMetrics(data.state);
      $('runsDialog').close();
      setStatus(`Menampilkan hasil ${run.projectName}.`);
    });
    actions.appendChild(view);
    const folder = document.createElement('button');
    folder.textContent = 'Buka Folder';
    folder.addEventListener('click', () => appApi.openRunOutput(run.runDir));
    actions.appendChild(folder);
    root.appendChild(row);
  }
  $('runsDialog').showModal();
}


function setMetricLabels(mode = 'run') {
  const combined = mode === 'combined';
  if ($('runStatusLabel')) $('runStatusLabel').textContent = 'Status';
  if ($('runRawLabel')) $('runRawLabel').textContent = combined ? 'Sesi Sumber' : 'Data Asli';
  if ($('runCollectedLabel')) $('runCollectedLabel').textContent = combined ? 'Data Gabungan' : 'Hasil Cleaning';
  if ($('runDuplicatesLabel')) $('runDuplicatesLabel').textContent = combined ? 'Duplikat Antar-Sesi' : 'Duplikat Pasti';
  if ($('runPossibleDuplicatesLabel')) $('runPossibleDuplicatesLabel').textContent = 'Potensi Duplikat';
  if ($('runPossibleDuplicatesCard')) $('runPossibleDuplicatesCard').classList.toggle('hidden', combined);
  const showSynthetic = !combined && Number(state.datasetCounts?.syntheticReviewIds || 0) > 0;
  if ($('runSyntheticIdsCard')) $('runSyntheticIdsCard').classList.toggle('hidden', !showSynthetic);
  document.querySelector('.result-overview-grid')?.classList.toggle('combined-metrics', combined);
  document.querySelector('.result-overview-grid')?.classList.toggle('identity-audit-metric', showSynthetic);
  if (!combined) renderCombinedComposition(null);
}

function displaySourceName(value = '') {
  const raw = String(value || '').trim();
  if (/traveloka/i.test(raw)) return 'Traveloka';
  if (/tiket/i.test(raw)) return 'Tiket';
  return raw || 'Sumber';
}

async function openCombinedSourcePotentialAudit(session = {}) {
  if (!session?.sessionId && !session?.runId) return setStatus('Sesi sumber tidak dapat ditemukan.');
  let runs = [];
  try { runs = await appApi.listRuns(); } catch {}
  const run = runs.find(item => String(item.sessionId || '') === String(session.sessionId || ''))
    || runs.find(item => String(item.runId || '') === String(session.runId || ''));
  if (!run) return setStatus(`Sesi sumber “${session.objectName || 'dataset'}” tidak tersedia di Riwayat.`);
  try {
    const data = await appApi.getRunResults(run.runDir, 300);
    state.showingPreview = false;
    state.activeCombinedDir = null;
    state.activeCombinedManifest = null;
    setMetricLabels('run');
    state.activeRunDir = run.runDir;
    state.results = data.rows || [];
    state.datasetRows = { clean: state.results, duplicates: [], raw: [] };
    state.datasetCounts = data.counts || {
      clean: Number(data.state?.itemsCollected || state.results.length),
      raw: Number(data.state?.rawItemsRead || data.state?.itemsCollected || state.results.length),
      duplicates: Number(data.state?.exactDuplicates ?? data.state?.duplicatesSkipped ?? 0) + Number(data.state?.possibleDuplicates || 0),
      exactDuplicates: Number(data.state?.exactDuplicates ?? data.state?.duplicatesSkipped ?? 0),
      possibleDuplicates: Number(data.state?.possibleDuplicates || 0),
      text: Number(data.counts?.text || 0), withoutText: Number(data.counts?.withoutText || 0),
      nativeReviewIds: Number(data.counts?.nativeReviewIds || data.state?.nativeReviewIds || 0),
      syntheticReviewIds: Number(data.counts?.syntheticReviewIds || data.state?.syntheticReviewIds || 0),
      missingReviewIds: Number(data.counts?.missingReviewIds || data.state?.missingReviewIds || 0)
    };
    state.activeDataset = 'clean';
    updateDatasetUi();
    renderResults(data.state?.itemsCollected);
    if (data.state) updateRunMetrics(data.state);
    await setDataDatasetMode('duplicates');
    setDuplicateViewMode('map');
    setStatus(`Potensi Duplikat dari ${session.objectName || run.projectName || 'sesi sumber'}.`);
  } catch (error) {
    setStatus(`Audit sesi sumber tidak dapat dibuka: ${error.message}`);
  }
}

function renderCombinedComposition(manifest = state.activeCombinedManifest) {
  const root = $('combinedComposition');
  if (!root) return;
  const clean = manifest?.composition?.clean || {};
  const isCombined = Boolean(manifest);
  const items = isCombined && Array.isArray(clean.bySource) ? clean.bySource : [];
  const text = isCombined ? Number(clean.withText) : Number(state.datasetCounts?.text);
  const withoutText = isCombined ? Number(clean.withoutText) : Number(state.datasetCounts?.withoutText);
  const hasTextCounts = Number.isFinite(text) && Number.isFinite(withoutText) && (text > 0 || withoutText > 0);
  const textItems = hasTextCounts ? [{source:'Dengan teks',count:text},{source:'Tanpa teks',count:withoutText}] : [];
  const counts = manifest?.counts || {};
  const exactCross = Number(counts.crossSessionExactDuplicates ?? counts.duplicates ?? 0);
  const potentialIntra = Number(counts.intraSessionCandidateDuplicates || 0);
  const potentialCross = Number(counts.crossSessionCandidateDuplicates ?? counts.candidateDuplicates ?? 0);
  const auditItems = [
    ...(exactCross > 0 ? [{source:'Duplikat Pasti Lintas Sumber',count:exactCross}] : []),
    ...(potentialIntra > 0 ? [{source:'Kandidat dari Sesi Sumber',count:potentialIntra}] : []),
    ...(potentialCross > 0 ? [{source:'Kandidat Lintas Sumber',count:potentialCross}] : [])
  ];
  const visible = [...items.map(item => ({...item, source:displaySourceName(item.source)})), ...textItems, ...auditItems];
  const potentialOrigins = isCombined ? (manifest?.sessions || []).filter(session => Number(session.candidateDuplicates || 0) > 0) : [];
  root.classList.toggle('hidden', !visible.length && !potentialOrigins.length);
  const summaryHtml = visible.map(item => `<span><b>${escapeHtml(item.source || 'Sumber')}</b> ${Number(item.count || 0).toLocaleString('id-ID')}</span>`).join('');
  const originHtml = potentialOrigins.map((session,index) => `<button type="button" class="combined-potential-origin" data-potential-origin="${index}" title="Buka visualisasi Potensi Duplikat sesi ini"><b>${escapeHtml(session.objectName || session.siteName || 'Sesi')}</b> ${Number(session.candidateDuplicates || 0).toLocaleString('id-ID')} potensi</button>`).join('');
  root.innerHTML = summaryHtml + originHtml;
  root.querySelectorAll('[data-potential-origin]').forEach(button => button.addEventListener('click', () => openCombinedSourcePotentialAudit(potentialOrigins[Number(button.dataset.potentialOrigin)])));
}

function updateDatasetUi() {
  const counts = state.datasetCounts || {};
  const combined = Boolean(state.activeCombinedDir);
  const rawButton = $('dataFullModeBtn');
  if (rawButton) {
    rawButton.classList.toggle('hidden', combined);
    rawButton.disabled = state.running || combined || state.showingPreview || (!state.activeRunDir && !combined);
  }
  if ($('dataDuplicateModeBtn')) {
    const hasDuplicates = Number(counts.duplicates || 0) > 0;
    $('dataDuplicateModeBtn').classList.toggle('hidden', !hasDuplicates);
    $('dataDuplicateModeBtn').disabled = state.running || state.showingPreview || !hasDuplicates || (!state.activeRunDir && !combined);
  }
  if ($('dataSourceBtn')) {
    $('dataSourceBtn').classList.toggle('hidden', combined);
    $('dataSourceBtn').disabled = state.running || state.showingPreview || !state.activeRunDir || combined;
    $('dataSourceBtn').textContent = 'Data Sumber';
    $('dataSourceBtn').title = 'Buka provenance dan file sumber asli run';
  }
  if ($('processDetailsBtn')) {
    $('processDetailsBtn').disabled = state.showingPreview || !currentRunReadDir() || combined;
    $('processDetailsBtn').classList.toggle('hidden', combined);
  }
  if ($('dataFolderBtn')) {
    $('dataFolderBtn').disabled = state.showingPreview || (!state.activeRunDir && !combined);
    $('dataFolderBtn').title = combined ? 'Buka folder Dataset Gabungan' : 'Buka folder dataset hasil run';
  }
  renderCombinedComposition(combined ? state.activeCombinedManifest : null);
  syncDataViewControls();
}

async function selectDataset(dataset) {
  const selected = ['clean', 'duplicates', 'raw'].includes(dataset) ? dataset : 'clean';
  if (state.showingPreview) return;
  const combined = Boolean(state.activeCombinedDir);
  if (combined && selected === 'raw') return setStatus('Dataset Gabungan memakai hasil cleaning tiap sesi. Data Asli tetap berada pada sesi asal.');
  if (!combined && selected !== 'clean' && !state.activeRunDir) return setStatus('Data Asli dan Audit Duplikat tersedia setelah proses disimpan.');
  if (selected === 'duplicates' && Number(state.datasetCounts?.duplicates || 0) <= 0) return setStatus(combined ? 'Dataset Gabungan tidak memiliki baris Audit Duplikat.' : 'Run aktif tidak memiliki Audit Duplikat.');

  if (combined) {
    if (!state.datasetRows[selected]?.length && Number(state.datasetCounts[selected] || 0) > 0) {
      try {
        const result = await appApi.getCombinedDataset(state.activeCombinedDir, 0, selected);
        state.datasetRows[selected] = result.rows || [];
      } catch (error) {
        return setStatus(`Dataset Gabungan tidak dapat dimuat: ${error.message}`);
      }
    }
  } else if (state.activeRunDir && !state.datasetRows[selected]?.length && Number(state.datasetCounts[selected] || 0) > 0) {
    try {
      const result = await appApi.getRunDataset(state.activeRunDir, selected, selected === 'duplicates' ? 0 : 300);
      state.datasetRows[selected] = result.rows || [];
      if (result.state) updateRunMetrics(result.state);
    } catch (error) {
      return setStatus(`Dataset ${selected} tidak dapat dimuat: ${error.message}`);
    }
  }

  if (selected === 'duplicates' && !combined) await loadDuplicateDecisions();
  else if (selected !== 'duplicates') state.duplicateDecisions = {};
  state.activeDataset = selected;
  if (selected !== 'duplicates') state.duplicateViewMode = 'list';
  state.results = state.datasetRows[selected] || [];
  updateDatasetUi();
  renderResults(Number(state.datasetCounts[selected] || state.results.length));
  const labels = { clean: combined ? 'Dataset Gabungan' : 'Hasil Cleaning', duplicates: combined ? 'Audit Duplikat Antar-Sesi' : 'Audit Duplikat', raw: 'Data Asli' };
  setStatus(`Menampilkan ${Number(state.datasetCounts[selected] || 0).toLocaleString('id-ID')} ${labels[selected]}.`);
}

const STANDARD_TABLE_COLUMNS = Object.freeze([
  'review_id','review_subject','review_title','review_text','review_date',
  'rating_score','rating_max','reviewer_name','reviewer_country','reviewer_status',
  'travel_type','room_type','stay_detail','source_site'
]);

function standardTableColumns(rows = []) {
  const hasNormalized = Boolean(state.activeCombinedDir) && (Array.isArray(rows) ? rows : []).some(row => Object.prototype.hasOwnProperty.call(row || {}, 'rating_normalized'));
  if (!hasNormalized) return [...STANDARD_TABLE_COLUMNS];
  const columns = [];
  for (const key of STANDARD_TABLE_COLUMNS) {
    columns.push(key);
    if (key === 'rating_max') columns.push('rating_normalized');
  }
  return columns;
}

function numericRatingDisplay(value, component = 'score') {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  const pair = raw.match(/([+-]?\d+(?:[.,]\d+)?)\s*\/\s*([+-]?\d+(?:[.,]\d+)?)/);
  const denominator = raw.match(/^\/\s*([+-]?\d+(?:[.,]\d+)?)$/);
  const standalone = raw.match(/^([+-]?\d+(?:[.,]\d+)?)$/);
  const token = pair ? (component === 'max' ? pair[2] : pair[1]) : (denominator ? denominator[1] : (standalone ? standalone[1] : null));
  if (token == null) return '';
  const number = Number(token.replace(',', '.'));
  return Number.isFinite(number) ? number : '';
}

function rowFirst(row, names, fallback = '') {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function standardTableSite(row = {}) {
  const direct = String(rowFirst(row, ['source_site','review_provider','review_origin'], '')).toUpperCase();
  if (/AGODA/.test(direct)) return 'AGODA';
  if (/TRAVELOKA/.test(direct)) return 'TRAVELOKA';
  if (/TIKET/.test(direct)) return 'TIKET';
  if (/TRIP/.test(direct)) return 'TRIP';
  const sourceUrl = String(rowFirst(row, ['source_url','_sourceUrl'], ''));
  if (/agoda\./i.test(sourceUrl)) return 'AGODA';
  if (/traveloka\./i.test(sourceUrl)) return 'TRAVELOKA';
  if (/tiket\./i.test(sourceUrl)) return 'TIKET';
  if (/trip\.com/i.test(sourceUrl)) return 'TRIP';
  const profile = effectiveSiteProfile();
  return profile === 'agoda' ? 'AGODA' : profile === 'traveloka' ? 'TRAVELOKA' : profile === 'tiket' ? 'TIKET' : profile === 'trip' ? 'TRIP' : 'GENERIC';
}

function standardTableRow(row = {}) {
  const rawScore = rowFirst(row, ['rating_score','reviewScore','score','rating'], '');
  const rawMax = rowFirst(row, ['rating_max','reviewMaxScore','max_score','rating_scale'], '');
  const score = numericRatingDisplay(rawScore, 'score');
  let max = numericRatingDisplay(rawMax, 'max');
  // rating_max must come from explicit scale evidence (rating_max itself,
  // a denominator such as /5 or /10, or a score/max pair). A standalone score
  // such as 9.2 is never a valid maximum scale.
  if (max === '') max = numericRatingDisplay(rowFirst(row, ['rating_label'], ''), 'max');
  const normalized = numericRatingDisplay(rowFirst(row, ['rating_normalized'], ''), 'score');
  const out = {
    review_id: String(rowFirst(row, ['review_id','reviewId','id'], '')),
    review_subject: String(rowFirst(row, ['review_subject','_objectName','object_name'], unifiedProjectIdentity())),
    review_title: String(rowFirst(row, ['review_title','title'], '')),
    review_text: String(rowFirst(row, ['review_text','reviewContentText','comment','content','text'], '')),
    review_date: String(rowFirst(row, ['review_date','review_date_raw','date','reviewDate'], '')),
    rating_score: score,
    rating_max: max,
    rating_normalized: normalized,
    reviewer_name: String(rowFirst(row, ['reviewer_name','author','user_name','reviewer'], '')),
    reviewer_country: String(rowFirst(row, ['reviewer_country','country'], '')),
    reviewer_status: String(rowFirst(row, ['reviewer_status'], '')),
    travel_type: String(rowFirst(row, ['travel_type','trip_type','traveler_type'], '')),
    room_type: String(rowFirst(row, ['room_type','room','room_name'], '')),
    stay_detail: String(rowFirst(row, ['stay_detail','stay_info'], '')),
    source_site: standardTableSite(row)
  };
  return Object.fromEntries(standardTableColumns([row]).map(key => [key, out[key] ?? '']));
}

function rowsForDisplay(rows) {
  if (state.showingPreview) return rows || [];
  if (state.activeDataset === 'duplicates') {
    return duplicateAuditRows(rows || []).map(row => ({ ...row, _verification_status: duplicateDecisionLabel(duplicateDecisionFor(row)) }));
  }
  if (state.activeDataset !== 'clean') return rows || [];
  return (rows || []).map(standardTableRow);
}

function displayHeaders(rows) {
  if (!state.showingPreview && state.activeDataset === 'clean') return standardTableColumns(rows);
  return [...new Set((rows || []).flatMap(row => Object.keys(row || {})))];
}

function renderResults(totalOverride = null) {
  const table = $('resultTable');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const standardTableMode = !state.showingPreview && state.activeDataset === 'clean';
  table.dataset.schema = standardTableMode ? 'standard' : 'source';
  thead.innerHTML = '';
  tbody.innerHTML = '';
  const rows = state.showingPreview ? state.previewRows : state.results;
  const shownRows = rowsForDisplay(rows);
  const count = state.showingPreview ? rows.length : (state.activeDataset === 'duplicates' ? shownRows.length : (totalOverride ?? rows.length));
  const datasetSuffix = state.showingPreview ? 'preview' : state.activeDataset;
  $('resultCount').textContent = `${Number(count || 0).toLocaleString('id-ID')} ${datasetSuffix}`;
  const noDatasetExport = state.running || state.showingPreview || (!state.results.length && !state.activeRunDir);
  $('exportCsvBtn').disabled = noDatasetExport;
  if ($('exportStandardCsvBtn')) $('exportStandardCsvBtn').disabled = noDatasetExport;
  if ($('exportStandardXlsxBtn')) $('exportStandardXlsxBtn').disabled = noDatasetExport;
  $('exportJsonBtn').disabled = state.running || state.showingPreview || (!state.results.length && !state.activeRunDir);
  $('exportLogBtn').disabled = state.showingPreview || (!state.activeRunDir && !$('logBox').textContent.trim());
  if ($('exportBundleBtn')) $('exportBundleBtn').disabled = state.running || state.showingPreview || !state.activeRunDir;
  if ($('openResultFolderBtn')) $('openResultFolderBtn').disabled = state.showingPreview || !state.activeRunDir;
  updateDatasetUi();
  if (!rows.length) { mirrorDataWorkspaceTable(); syncDuplicateViewControls(); renderFlowCanvas(); return; }

  const headers = displayHeaders(shownRows);
  const diagnosticMap=new Map((state.showingPreview?state.previewDiagnostics:[]).map(d=>[d.name,d]));
  const trh = document.createElement('tr');
  headers.forEach(header => {
    const th = document.createElement('th');
    const diag=diagnosticMap.get(header);
    const diagProblem=diag&&(Number(diag.ambiguous||0)>0||(diag.required&&Number(diag.missing||0)>0)||Number(diag.coverageDrop||0)>0.15||Boolean(diag.semanticCritical)||(diag.semanticWarnings||[]).length);
    th.textContent = `${diagProblem?'⚠ ':''}${header}`;
    if(diagProblem)th.classList.add('preview-field-warning');
    if(diagProblem){const parts=[diag.missing?`${diag.missing} kosong`:'',diag.ambiguous?`${diag.ambiguous} ambigu`:'',...(diag.semanticWarnings||[])].filter(Boolean);th.title=`Field perlu diperiksa: ${parts.join(' · ')}`;}
    else if (header === 'rating_score') th.title = 'Skor rating asli dari sumber, disimpan sebagai angka.';
    else if (header === 'rating_max') th.title = 'Skala maksimum rating asli dari sumber, disimpan sebagai angka.';
    else if (header === 'rating_normalized') th.title = 'Rating pembanding skala 0–10. Kolom ini hanya ada pada Dataset Gabungan dengan lebih dari satu rating_max.';
    else if (header === 'review_provider') th.title = 'Provider asli review. Dapat berbeda dari source_site bila sebuah website menampilkan review partner.';
    else if (header === 'source_object_name') th.title = 'Nama objek/hotel sebagaimana terdeteksi pada website sumber.';
    else if (header === 'canonical_object') th.title = 'Identitas objek lintas sumber yang dipakai saat menggabungkan dataset.';
    else if (header === 'review_positive_text') th.title = 'Bagian positif review bila sumber menyediakannya secara terpisah.';
    else if (header === 'review_negative_text') th.title = 'Bagian negatif review bila sumber menyediakannya secara terpisah.';
    else if (header === '_scrapedAt') th.title = 'Waktu data diambil oleh MyDataset (waktu lokal, termasuk offset zona waktu).';
    else if (header === '_page') th.title = 'Nomor langkah/halaman saat data dikumpulkan.';
    else if (header === '_sourceUrl') th.title = 'Alamat halaman sumber saat data dikumpulkan.';
    trh.appendChild(th);
  });
  thead.appendChild(trh);

  const displayRows = state.activeCombinedDir ? shownRows : shownRows.slice(0, 300);
  displayRows.forEach(row => {
    const tr = document.createElement('tr');
    headers.forEach(header => {
      const td = document.createElement('td');
      td.textContent = row[header] ?? '';
      td.title = String(row[header] ?? '');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  mirrorDataWorkspaceTable();
  state.runtimeFlow.rows = Number(count || rows.length || 0);
  renderFlowCanvas();
}

function mirrorDataWorkspaceTable() {
  const target=$('dataWorkspaceTable'); if(!target) return;
  const source=$('resultTable'); target.dataset.schema=source.dataset.schema||'source'; target.querySelector('thead').innerHTML=source.querySelector('thead').innerHTML; target.querySelector('tbody').innerHTML=source.querySelector('tbody').innerHTML;
  const rows=state.showingPreview?state.previewRows:state.results;
  const visibleCount=state.showingPreview?rows.length:Number(state.datasetCounts?.[state.activeDataset]??rows.length);
  $('dataWorkspaceCount').textContent=Number(visibleCount||0).toLocaleString('id-ID');
  $('dataWorkspaceFields').textContent=String(state.project.fields.length);
  $('dataWorkspaceStructure').textContent=state.project.itemSelector?(state.project.itemMeta?.autoDetected?'Otomatis':'Siap'):'Belum siap';
  const displayedRows=state.activeDataset==='duplicates'?rowsForDisplay(rows):rows;
  $('dataWorkspaceStatus').textContent=displayedRows.length?'Ada data':(state.project.fields.length?'Siap diperiksa':'Menunggu');
  const noDataWorkspaceExport=state.running||state.showingPreview||(!state.results.length&&!state.activeRunDir&&!state.activeCombinedDir);
  $('dataExportBtn').disabled=noDataWorkspaceExport;
  if($('dataExportStandardBtn')) $('dataExportStandardBtn').disabled=noDataWorkspaceExport;
  if($('dataExportXlsxBtn')) $('dataExportXlsxBtn').disabled=noDataWorkspaceExport;
  if($('dataExportBundleBtn')) $('dataExportBundleBtn').disabled=state.running||state.showingPreview||Boolean(state.activeCombinedDir)||!state.activeRunDir;
  const empty=$('dataEmpty');
  if(empty){
    const title=empty.querySelector('h3'),message=empty.querySelector('p');
    if(state.activeDataset==='duplicates'&&rows.length&&!displayedRows.length){
      const labels={unreviewed:'Belum Diputuskan',confirmed:'Benar Duplikat',rejected:'Bukan Duplikat',all:'Audit Duplikat'};
      if(title)title.textContent=`Tidak ada record: ${labels[state.duplicateAuditFilter]||'filter ini'}`;
      if(message)message.textContent=state.duplicateAuditSearch
        ? 'Tidak ada kandidat yang cocok dengan status dan kata pencarian saat ini.'
        : 'Tidak ada kandidat pada status ini. Pilih filter lain atau ubah keputusan audit.';
    }else if(state.activeDataset==='duplicates'&&!rows.length){
      if(title)title.textContent='Tidak ada Audit Duplikat';
      if(message)message.textContent='Sesi ini tidak memiliki Duplikat Pasti atau Potensi Duplikat.';
    }else{
      if(title)title.textContent='Belum ada data';
      if(message)message.textContent='Mulai pengambilan data untuk mengisi tabel.';
    }
    empty.classList.toggle('hidden',Boolean(displayedRows.length));
  }
}

function datasetViewLabel(dataset = 'clean') {
  return { clean: state.activeCombinedDir ? 'Dataset Gabungan' : 'Hasil Cleaning', raw: 'Data Asli', duplicates: 'Audit Duplikat' }[dataset] || 'Hasil Cleaning';
}

async function exportData(format, schema = 'native', datasetOverride = null, options = {}) {
  if (state.showingPreview) return setStatus('Hasil preview belum menjadi dataset tersimpan. Jalankan proyek sebelum mengekspor.');
  if (!state.results.length && !state.activeRunDir && !state.activeCombinedDir) return setStatus('Belum ada hasil dataset yang dapat diekspor.');
  const exportDataset = ['clean','raw','duplicates'].includes(datasetOverride) ? datasetOverride : state.activeDataset;
  if (exportDataset === 'duplicates' && Number(state.datasetCounts?.duplicates || 0) <= 0) return setStatus(state.activeCombinedDir ? 'Dataset Gabungan tidak memiliki baris Audit Duplikat untuk diekspor.' : 'Run aktif tidak memiliki Audit Duplikat untuk diekspor.');
  try {
    advanceRuntimeFlow({stage:'exporting',message:`Menyiapkan ${datasetViewLabel(exportDataset)} dalam format ${String(format).toUpperCase()}…`});
    const result = await appApi.exportData({
      format,
      dataset: exportDataset,
      rows: state.activeCombinedDir ? state.results : (state.activeRunDir ? undefined : state.results),
      runDir: state.activeCombinedDir ? undefined : state.activeRunDir,
      combinedDirectory: state.activeCombinedDir || null,
      projectName: state.activeCombinedDir ? (state.activeCombinedManifest?.name || 'Dataset Gabungan') : state.project.name,
      startUrl: state.project.startUrl || $('urlInput').value.trim(),
      source: state.project.source,
      reviewSubject: unifiedProjectIdentity(),
      siteProfile: state.project.siteProfile || 'auto',
      schema,
      textOnly: Boolean(options.textOnly)
    });
    if (!result.canceled) {
      $('openResultFolderBtn').disabled = false;
      const label = result.textOnly ? 'Data Siap Analisis — Teks' : datasetViewLabel(result.dataset || exportDataset);
      setStatus(`${label} ${String(format).toUpperCase()} berhasil diekspor (${result.rows} baris).`);
      advanceRuntimeFlow({stage:'done',message:`Ekspor ${String(format).toUpperCase()} selesai.`,itemsCollected:state.datasetCounts.clean});
    } else {
      advanceRuntimeFlow({stage:'done',message:'Ekspor dibatalkan; dataset run tetap aman.',itemsCollected:state.datasetCounts.clean});
    }
  } catch (error) {
    advanceRuntimeFlow({stage:'error',message:`Ekspor ${String(format).toUpperCase()} gagal: ${error.message}`});
    setStatus(`Ekspor ${String(format).toUpperCase()} gagal: ${error.message}`);
  }
}

async function exportAllDatasets() {
  if (!state.activeRunDir || state.showingPreview) return setStatus('Belum ada dataset tersimpan.');
  try {
    advanceRuntimeFlow({stage:'exporting',message:'Menyiapkan folder dataset…'});
    const result = await appApi.exportDatasetBundle({
      runDir: state.activeRunDir,
      projectName: state.project.name,
      startUrl: state.project.startUrl || $('urlInput').value.trim(),
      source: state.project.source,
      reviewSubject: unifiedProjectIdentity(),
      siteProfile: state.project.siteProfile || 'auto'
    });
    if (!result.canceled) {
      $('openResultFolderBtn').disabled = false;
      setStatus(`Folder dataset diperbarui: ${result.counts.clean} hasil cleaning, ${result.counts.raw} data asli, ${result.counts.duplicates} catatan audit.`);
      advanceRuntimeFlow({stage:'done',message:'Folder dataset siap.',itemsCollected:result.counts.clean});
    }
  } catch (error) {
    advanceRuntimeFlow({stage:'error',message:`Ekspor paket gagal: ${error.message}`});
    setStatus(`Paket dataset gagal dibuat: ${error.message}`);
  }
}

async function exportLog() {
  if (state.showingPreview || (!state.activeRunDir && !$('logBox').textContent.trim())) return;
  try {
    advanceRuntimeFlow({stage:'exporting',message:'Menyiapkan log audit run…'});
    const result = await appApi.exportLog({
      runDir: state.activeRunDir,
      logText: $('logBox').textContent,
      rows: state.activeRunDir ? undefined : state.results,
      projectName: state.project.name,
      startUrl: state.project.startUrl || $('urlInput').value.trim(),
      source: state.project.source
    });
    if (!result.canceled) {
      $('openResultFolderBtn').disabled = false;
      setStatus('Log berhasil diekspor.');
      advanceRuntimeFlow({stage:'done',message:'Log audit berhasil diekspor.',itemsCollected:state.datasetCounts.clean});
    } else {
      advanceRuntimeFlow({stage:'done',message:'Ekspor log dibatalkan; data run tetap aman.',itemsCollected:state.datasetCounts.clean});
    }
  } catch (error) {
    advanceRuntimeFlow({stage:'error',message:`Ekspor log gagal: ${error.message}`});
    setStatus(`Ekspor log gagal: ${error.message}`);
  }
}

async function openResultLocation() {
  try {
    const result = await appApi.openResultLocation(state.activeRunDir);
    if (!result?.ok) setStatus(result?.error || 'Lokasi hasil belum tersedia.');
  } catch (error) {
    setStatus(`Folder hasil tidak dapat dibuka: ${error.message}`);
  }
}

function applyProjectMode(requestedMode, { userInitiated = false } = {}) {
  const mode = ['quick', 'multipage', 'crawl'].includes(requestedMode) ? requestedMode : 'quick';
  state.project.pagination = state.project.pagination || createDefaultProject().pagination;
  const oldType = state.project.pagination.type;
  if (['next', 'loadMore', 'scroll'].includes(oldType)) state.project.pagination.lastType = oldType;
  state.project.mode = mode;
  if (mode === 'multipage') {
    const restored = state.project.pagination.lastType;
    state.project.pagination.type = ['next', 'loadMore', 'scroll'].includes(restored) ? restored : 'scroll';
  } else {
    state.project.pagination.type = 'none';
  }
  if (state.project.acquisition) {
    if (mode === 'crawl') state.project.acquisition.scope = 'site-crawl';
    else if (mode === 'multipage' && state.project.acquisition.scope === 'current') state.project.acquisition.scope = 'multiple';
    else if (mode === 'quick' && state.project.acquisition.method === 'dom') state.project.acquisition.scope = 'current';
  }
  renderProjectMode();
  renderAcquisition();
  renderPagination();
  renderFlowCanvas();
  scheduleAutosave();
  if (userInitiated) {
    const messages = {
      quick: 'Mode Cepat aktif: runner dibatasi ke halaman yang sedang terbuka, satu kali ekstraksi.',
      multipage: `Mode Banyak Halaman aktif: navigasi ${state.project.pagination.type === 'scroll' ? 'scroll otomatis' : 'berbasis tombol'} ${state.project.acquisition?.scope === 'all' ? 'berjalan sampai sumber berakhir' : 'menggunakan batas langkah pengguna'}.`,
      crawl: 'Mode Jelajah aktif: menu pagination diganti dengan aturan URL, kedalaman, dan batas kunjungan crawler.'
    };
    setStatus(messages[mode]);
  }
}

function syncLegacyModeFromAcquisition({ updateControls = true } = {}) {
  state.project.acquisition = { ...createDefaultProject().acquisition, ...(state.project.acquisition || {}) };
  const method = resolvedAcquisitionMethod();
  let scope = state.project.acquisition.scope || 'current';
  // HAR/Network is an imported completed input batch; legacy runner mode is only relevant to DOM.
  let mode = 'quick';
  if (method === 'dom') mode = scope === 'site-crawl' ? 'crawl' : (scope === 'multiple' || scope === 'all' ? 'multipage' : 'quick');
  state.project.mode = mode;
  state.project.pagination = state.project.pagination || createDefaultProject().pagination;
  if (mode === 'multipage') {
    const restored = ['next','loadMore','scroll'].includes(state.project.pagination.lastType) ? state.project.pagination.lastType : 'next';
    state.project.pagination.type = restored;
    state.project.pagination.maxPages = scope === 'all' ? null : Math.max(1, Number(state.project.acquisition.limit || 5));
  } else state.project.pagination.type = 'none';
  if (updateControls) {
    if ($('projectMode')) $('projectMode').value = mode;
    if ($('maxPages')) $('maxPages').value = state.project.pagination.maxPages ?? '';
    if ($('paginationType')) $('paginationType').value = state.project.pagination.type || 'none';
  }
  return mode;
}

function renderAcquisition() {
  state.project.acquisition = { ...createDefaultProject().acquisition, ...(state.project.acquisition || {}) };
  const resolved = resolvedAcquisitionMethod();
  state.project.acquisition.method = resolved;
  if (resolved === 'network-json') state.project.acquisition.scope = 'all';
  const scope = state.project.acquisition.scope || 'current';
  if ($('acquisitionMethod')) $('acquisitionMethod').value = resolved;
  if ($('acquisitionScope')) $('acquisitionScope').value = scope;
  if ($('acquisitionLimit')) $('acquisitionLimit').value = state.project.acquisition.limit || 5;
  const isDom = resolved === 'dom';
  const isNetwork = resolved === 'network-json';
  document.body.classList.toggle('network-acquisition-mode', isNetwork);
  $('harInspectorWorkspace')?.classList.toggle('hidden', !isNetwork);
  $('acquisitionScopeRow')?.classList.toggle('hidden', !isDom);
  $('acquisitionLimitWrap')?.classList.toggle('hidden', !isDom || scope !== 'multiple');
  $('acquisitionNavigation')?.classList.toggle('hidden', !(isDom && ['multiple','all'].includes(scope)));
  $('crawlSettingsCard')?.classList.toggle('hidden', !(isDom && scope === 'site-crawl'));
  $('domFieldsCard')?.classList.toggle('hidden', !isDom);
  $('reliabilityCard')?.classList.toggle('hidden', !isDom);
  $('domSourceSetup')?.classList.toggle('hidden', !isDom);
  $('domRunAction')?.classList.toggle('hidden', !isDom);
  if ($('projectModePill')) $('projectModePill').textContent = ACQUISITION_DEFS[resolved]?.label || resolved;
  const recommendation = $('acquisitionRecommendation');
  if (recommendation) {
    recommendation.className = 'acquisition-recommendation policy-summary';
    const site = effectiveSiteProfile();
    const tripDomMultipage = isDom && site === 'trip' && ['multiple','all'].includes(scope);
    if (tripDomMultipage) {
      recommendation.classList.add('manual');
      recommendation.innerHTML = '<span>DOM Trip tetap tersedia untuk preview/validasi manual, tetapi paginator UI bersifat best effort.</span><b>Trip multipage: HAR / Network adalah jalur utama</b>';
    } else {
      recommendation.innerHTML = isNetwork ? '<span>Response Network lebih deterministik untuk dataset multipage.</span><b>HAR / Network · Direkomendasikan</b>' : '<span>Gunakan untuk interaksi visual dan pengujian selector.</span><b>Halaman Web / DOM · Alternatif</b>';
    }
  }
  const features = isNetwork ? []
    : scope === 'site-crawl' ? ['Tiket/Agoda/Trip','Jelajah URL','Checkpoint']
    : ['Tiket/Agoda/Trip', scope === 'current' ? 'Halaman aktif' : scope === 'all' ? 'Sampai habis' : `${state.project.acquisition.limit || 5} langkah`, 'Field DOM'];
  if ($('acquisitionFeatures')) { $('acquisitionFeatures').innerHTML = features.map(value => `<span>${escapeHtml(value)}</span>`).join(''); $('acquisitionFeatures').classList.add('hidden'); }
  renderSiteOptionsForMethod();
  renderNetworkImportStage();
  syncLegacyModeFromAcquisition();
}

function renderProjectMode() {
  const mode = state.project.mode || 'quick';
  if ($('projectMode')) $('projectMode').value = mode;
  const help = $('projectModeHelp');
  const features = $('projectModeFeatures');
  if (help) {
    const tripDom = resolvedAcquisitionMethod() === 'dom' && effectiveSiteProfile() === 'trip';
    help.textContent = mode === 'crawl' ? 'DOM: jelajah beberapa URL dalam cakupan.' : mode === 'multipage' ? (tripDom ? 'DOM Trip multipage bersifat best effort. Untuk pengambilan dataset gunakan HAR / Network.' : 'DOM: ambil review melalui beberapa halaman.') : 'DOM: ambil review dari halaman aktif.';
  }
  if (features) features.innerHTML = '';
}

function setProcessLogMode(mode = 'summary') {
  state.processLogMode = mode === 'technical' ? 'technical' : 'summary';
  const summary = state.processLogMode === 'summary';
  $('processLogSummaryBtn')?.classList.toggle('active', summary);
  $('processLogTechnicalBtn')?.classList.toggle('active', !summary);
  $('processLogSummaryBtn')?.setAttribute('aria-pressed', String(summary));
  $('processLogTechnicalBtn')?.setAttribute('aria-pressed', String(!summary));
  $('processSummaryBox')?.classList.toggle('hidden', !summary);
  $('logBox')?.classList.toggle('hidden', summary);
}

function renderProcessSummary(runState = {}, rawLog = '') {
  const root = $('processSummaryBox');
  if (!root) return;
  const live = Boolean(state.running && state.pendingRunDir);
  const status = live ? String($('runStatus')?.textContent || 'Berjalan') : humanRunStatus(runState?.status || $('runStatus')?.textContent || 'Selesai');
  const sourceCount = Number(runState?.rawItemsRead ?? state.datasetCounts?.raw ?? 0);
  const cleanCount = Number(runState?.itemsCollected ?? state.datasetCounts?.clean ?? 0);
  const exact = Number(runState?.exactDuplicates ?? runState?.duplicatesSkipped ?? state.datasetCounts?.exactDuplicates ?? 0);
  const possible = Number(runState?.possibleDuplicates ?? state.datasetCounts?.possibleDuplicates ?? 0);
  const text = Number(runState?.textRecords ?? state.datasetCounts?.text ?? 0);
  const withoutText = Number(runState?.withoutTextRecords ?? state.datasetCounts?.withoutText ?? Math.max(0, cleanCount - text));
  const nativeReviewIds = Number(runState?.nativeReviewIds ?? state.datasetCounts?.nativeReviewIds ?? 0);
  const syntheticReviewIds = Number(runState?.syntheticReviewIds ?? state.datasetCounts?.syntheticReviewIds ?? 0);
  const missingReviewIds = Number(runState?.missingReviewIds ?? state.datasetCounts?.missingReviewIds ?? 0);
  const source = String(runState?.siteName || state.project?.source?.siteName || SITE_PROFILE_DEFS[effectiveSiteProfile()]?.label || 'Sumber');
  const methodRaw = String(runState?.ingestionMode || runState?.acquisitionMethod || resolvedAcquisitionMethod());
  const method = /har|network/i.test(methodRaw) ? 'HAR / Network' : 'Halaman Web / DOM';
  const coverageNote = runState?.sourceEndReason === 'PAGINATION_END_REACHED'
    ? 'Coverage: akhir sumber terverifikasi.'
    : runState?.sourceEndReason === 'SOURCE_LIMIT_REACHED'
      ? 'Coverage: sumber mencapai batas retrieval; kelengkapan populasi tidak diklaim.'
      : runState?.completionReason === 'USER_STEP_LIMIT_REACHED'
        ? 'Coverage: selesai sesuai batas langkah; akhir sumber belum terverifikasi.'
        : '';
  const timeline = [
    `${sourceCount.toLocaleString('id-ID')} record sumber dibaca.`,
    `${cleanCount.toLocaleString('id-ID')} record tersedia pada Hasil Cleaning.`,
    exact ? `${exact.toLocaleString('id-ID')} Duplikat Pasti ditemukan.` : 'Tidak ada Duplikat Pasti.',
    possible ? `${possible.toLocaleString('id-ID')} Potensi Duplikat ditandai untuk diperiksa.` : 'Tidak ada Potensi Duplikat.',
    (text || withoutText) ? `${text.toLocaleString('id-ID')} dengan teks · ${withoutText.toLocaleString('id-ID')} tanpa teks.` : '',
    (nativeReviewIds || syntheticReviewIds || missingReviewIds) ? `Identitas review: ${nativeReviewIds.toLocaleString('id-ID')} ID sumber · ${syntheticReviewIds.toLocaleString('id-ID')} ID sintetis · ${missingReviewIds.toLocaleString('id-ID')} tanpa ID.` : '',
    coverageNote,
    `${live ? 'Status saat ini' : 'Status akhir'}: ${status}.`
  ].filter(Boolean);
  const cards = [
    ['Status', status], ['Sumber', source], ['Metode', method],
    ['Data sumber', sourceCount.toLocaleString('id-ID')], ['Hasil Cleaning', cleanCount.toLocaleString('id-ID')], ['Potensi Duplikat', possible.toLocaleString('id-ID')]
  ];
  root.innerHTML = cards.map(([label,value]) => `<div class="process-summary-card"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('')
    + `<div class="process-summary-timeline"><b>Ringkasan proses</b><ul>${timeline.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`;
}

function openProcessDetails(returnView = state.activeView || 'dataView') {
  state.processDetailsReturnView = returnView;
  const load = async () => {
    const runDir = currentRunReadDir();
    let runState = {};
    state.processLogRaw = '';
    if (runDir) {
      try {
        const data = await appApi.getRunResults(runDir, 1, Boolean(state.running));
        runState = data?.state || {};
      } catch {}
    }
    if (runDir && appApi.getRunLog) {
      try {
        const result = await appApi.getRunLog(runDir);
        if (result?.text != null) state.processLogRaw = String(result.text || '');
      } catch {}
    }
    if ($('logBox')) $('logBox').textContent = state.processLogRaw || '';
    renderProcessSummary(runState, state.processLogRaw);
    setProcessLogMode('summary');
    switchWorkspaceView('logView');
    if (state.running) scheduleLiveRunUiRefresh({ immediate: true });
  };
  load();
}

function duplicateRelationKey(row = {}) {
  const original = row?._originalRecord && typeof row._originalRecord === 'object' ? row._originalRecord : {};
  const sourceId = duplicateRecordId(original) !== 'ID tidak tersedia'
    ? duplicateRecordId(original)
    : String(row?._duplicateOf || row?._duplicateOfRunId || 'review-acuan');
  const duplicateId = duplicateRecordId(row);
  const status = String(row?._dedupeStatus || '').includes('exact') ? 'exact' : 'possible';
  return `${status}::${sourceId}::${duplicateId}`;
}

function duplicateDecisionFor(row = {}) {
  return state.duplicateDecisions?.[duplicateRelationKey(row)]?.decision || 'unreviewed';
}

function duplicateDecisionLabel(decision = 'unreviewed') {
  return ({ confirmed: 'Benar Duplikat', rejected: 'Bukan Duplikat', unreviewed: 'Belum Diputuskan' })[decision] || 'Belum Diputuskan';
}

function duplicateAuditStatusCounts(rows = state.activeDataset === 'duplicates' ? state.results : []) {
  const source = Array.isArray(rows) ? rows : [];
  const counts = { all: source.length, unreviewed: 0, confirmed: 0, rejected: 0 };
  for (const row of source) {
    const decision = duplicateDecisionFor(row);
    if (Object.prototype.hasOwnProperty.call(counts, decision)) counts[decision] += 1;
    else counts.unreviewed += 1;
  }
  return counts;
}

function syncDuplicateAuditFilterCounters() {
  const counts = duplicateAuditStatusCounts();
  const labels = { all: 'Semua', unreviewed: 'Belum', confirmed: 'Duplikat', rejected: 'Bukan' };
  document.querySelectorAll('[data-duplicate-filter]').forEach(button => {
    const key = button.dataset.duplicateFilter || 'all';
    const count = Number(counts[key] || 0);
    button.textContent = `${labels[key] || key} ${count.toLocaleString('id-ID')}`;
    button.title = key === 'unreviewed'
      ? `${count.toLocaleString('id-ID')} belum diputuskan`
      : key === 'confirmed'
        ? `${count.toLocaleString('id-ID')} benar duplikat`
        : key === 'rejected'
          ? `${count.toLocaleString('id-ID')} bukan duplikat`
          : `${count.toLocaleString('id-ID')} seluruh kandidat`;
  });
}

async function loadDuplicateDecisions() {
  state.duplicateDecisions = {};
  if (!state.activeRunDir || !appApi.getDuplicateDecisions) return state.duplicateDecisions;
  try {
    const result = await appApi.getDuplicateDecisions(state.activeRunDir);
    state.duplicateDecisions = result?.decisions && typeof result.decisions === 'object' ? result.decisions : {};
  } catch {}
  return state.duplicateDecisions;
}

async function saveDuplicateDecision(row, decision = 'unreviewed') {
  if (!state.activeRunDir || state.activeCombinedDir) return setStatus('Keputusan manual disimpan pada sesi sumber, bukan Dataset Gabungan.');
  const relationKey = duplicateRelationKey(row);
  const original = row?._originalRecord && typeof row._originalRecord === 'object' ? row._originalRecord : {};
  const payload = {
    relationKey,
    decision,
    sourceId: duplicateRecordId(original),
    duplicateId: duplicateRecordId(row),
    dedupeStatus: String(row?._dedupeStatus || ''),
    reviewSubject: String(rowFirst(row, ['review_subject','_objectName'], unifiedProjectIdentity()) || '')
  };
  try {
    const result = await appApi.saveDuplicateDecision(state.activeRunDir, payload);
    state.duplicateDecisions = result?.decisions && typeof result.decisions === 'object' ? result.decisions : state.duplicateDecisions;
    refreshDuplicateAuditView();
    setStatus(decision === 'unreviewed'
      ? 'Keputusan Potensi Duplikat dikembalikan ke Belum Diputuskan.'
      : `Keputusan audit disimpan: ${duplicateDecisionLabel(decision)}. Data asli dan Hasil Cleaning tidak diubah.`);
  } catch (error) {
    setStatus(`Keputusan audit tidak dapat disimpan: ${error.message}`);
  }
}

function duplicateAuditRows(rows = []) {
  const source = Array.isArray(rows) ? rows : [];
  if (state.activeDataset !== 'duplicates') return source;
  const filter = state.duplicateAuditFilter || 'all';
  const query = String(state.duplicateAuditSearch || '').trim().toLocaleLowerCase('id-ID');
  return source.filter(row => {
    const decision = duplicateDecisionFor(row);
    if (filter !== 'all' && decision !== filter) return false;
    if (!query) return true;
    const original = row?._originalRecord && typeof row._originalRecord === 'object' ? row._originalRecord : {};
    const haystack = [
      duplicateRecordId(row), duplicateRecordId(original),
      rowFirst(row,['review_text','reviewContentText','comment','content','text'],''),
      rowFirst(original,['review_text','reviewContentText','comment','content','text'],''),
      rowFirst(row,['reviewer_name','author','user_name','reviewer'],''),
      rowFirst(original,['reviewer_name','author','user_name','reviewer'],'')
    ].join(' ').toLocaleLowerCase('id-ID');
    return haystack.includes(query);
  });
}

function setDuplicateAuditFilter(filter = 'all') {
  state.duplicateAuditFilter = ['all','unreviewed','confirmed','rejected'].includes(filter) ? filter : 'all';
  document.querySelectorAll('[data-duplicate-filter]').forEach(button => button.classList.toggle('active', button.dataset.duplicateFilter === state.duplicateAuditFilter));
  refreshDuplicateAuditView();
}

function refreshDuplicateAuditView() {
  if (state.activeDataset !== 'duplicates') return;
  if (state.duplicateViewMode === 'map') renderDuplicateMap();
  else renderResults();
}

function duplicateRecordId(row = {}) {
  return String(row.review_id || row.reviewId || row.id || row._rowId || '').trim() || 'ID tidak tersedia';
}

function duplicateMatchFacts(row = {}, original = {}) {
  const pairs = [
    ['Review ID', ['review_id','reviewId','id','_rowId']],
    ['Teks', ['review_text','reviewContentText','comment','content','text']],
    ['Reviewer', ['reviewer_name','author','user_name','reviewer']],
    ['Rating', ['rating_score','reviewScore','score','rating']],
    ['Tanggal', ['review_date','review_date_raw','date','reviewDate']]
  ];
  return pairs.map(([label,names]) => {
    const a = String(rowFirst(row,names,'')).trim();
    const b = String(rowFirst(original,names,'')).trim();
    return { label, same: Boolean(a && b && a === b), left: b, right: a };
  }).filter(item => item.left || item.right);
}

function renderDuplicateMap() {
  const root = $('duplicateMapWorkspace');
  if (!root) return;
  const sourceRows = state.activeDataset === 'duplicates' ? (state.results || []) : [];
  const rows = duplicateAuditRows(sourceRows);
  if (!sourceRows.length) {
    root.innerHTML = '<div class="view-empty"><h3>Tidak ada duplikat untuk divisualisasikan</h3><p>Audit sesi ini tidak memiliki Duplikat Pasti atau Potensi Duplikat.</p></div>';
    return;
  }
  if (!rows.length) {
    root.innerHTML = '<div class="view-empty"><h3>Tidak ada hasil pada filter ini</h3><p>Ubah status verifikasi atau kata pencarian untuk melihat pasangan review lain.</p></div>';
    return;
  }

  const relations = rows.map(row => {
    const original = row?._originalRecord && typeof row._originalRecord === 'object' ? row._originalRecord : {};
    const status = String(row?._dedupeStatus || '').includes('exact') ? 'Duplikat Pasti' : 'Potensi Duplikat';
    const sourceId = duplicateRecordId(original) !== 'ID tidak tersedia' ? duplicateRecordId(original) : String(row?._duplicateOf || row?._duplicateOfRunId || 'Review acuan');
    const duplicateId = duplicateRecordId(row);
    const facts = duplicateMatchFacts(row, original);
    const relationKey = duplicateRelationKey(row);
    const decision = duplicateDecisionFor(row);
    return { row, original, status, sourceId, duplicateId, facts, relationKey, decision };
  });

  const grouped = new Map();
  for (const relation of relations) {
    const key = `${relation.status}::${relation.sourceId}`;
    if (!grouped.has(key)) grouped.set(key, { status: relation.status, sourceId: relation.sourceId, original: relation.original, relations: [] });
    grouped.get(key).relations.push(relation);
  }
  const clusters = [...grouped.values()];
  const maxGroups = 80;
  const shown = clusters.slice(0, maxGroups);
  const exactCount = relations.filter(item => item.status === 'Duplikat Pasti').length;
  const potentialCount = relations.length - exactCount;
  const confirmedCount = relations.filter(item => item.decision === 'confirmed').length;
  const rejectedCount = relations.filter(item => item.decision === 'rejected').length;
  const unreviewedCount = relations.length - confirmedCount - rejectedCount;

  const cards = shown.map(cluster => {
    const referenceText = String(rowFirst(cluster.original,['review_text','reviewContentText','comment','content','text'],'')).trim();
    const comparisons = cluster.relations.map((relation,relationIndex) => {
      const comparisonText = String(rowFirst(relation.row,['review_text','reviewContentText','comment','content','text'],'')).trim();
      const textDiffers = referenceText && comparisonText && referenceText !== comparisonText;
      const facts = relation.facts.map(item => {
        const identity = item.label === 'Review ID';
        const label = `${item.label}: ${item.same ? 'sama' : 'berbeda'}`;
        return `<span class="${item.same?'same':'different'} ${identity&&!item.same?'identity-different':''}">${escapeHtml(label)}</span>`;
      }).join('');
      const decisionButtons = ['unreviewed','confirmed','rejected'].map(value => `<button type="button" data-duplicate-decision="${value}" data-relation-key="${escapeHtml(relation.relationKey)}" class="${relation.decision===value?'active':''}">${escapeHtml(duplicateDecisionLabel(value))}</button>`).join('');
      return `<div class="duplicate-comparison">
        <div class="duplicate-node duplicate-node-comparison"><span>Review Pembanding${cluster.relations.length>1?` ${relationIndex+1}`:''}</span><b title="${escapeHtml(relation.duplicateId)}">${escapeHtml(relation.duplicateId)}</b></div>
        ${textDiffers ? `<p class="duplicate-map-text comparison-text">${escapeHtml(comparisonText.slice(0,180))}${comparisonText.length>180?'…':''}</p>` : ''}
        <div class="duplicate-facts">${facts}</div>
        ${state.activeCombinedDir ? '' : `<div class="duplicate-decision"><span class="duplicate-decision-label">Keputusan</span>${decisionButtons}<span class="duplicate-decision-state">${escapeHtml(duplicateDecisionLabel(relation.decision))}</span></div>`}
      </div>`;
    }).join('');
    const matched = cluster.relations[0]?.facts?.filter(item => item.same && item.label !== 'Review ID').map(item=>item.label) || [];
    const decisions = new Set(cluster.relations.map(item => item.decision));
    const verifiedClass = decisions.size === 1 && decisions.has('confirmed') ? 'is-verified-confirmed' : decisions.size === 1 && decisions.has('rejected') ? 'is-verified-rejected' : '';
    return `<article class="duplicate-map-group ${cluster.status === 'Duplikat Pasti' ? 'is-exact' : 'is-possible'} ${verifiedClass}">
      <div class="duplicate-map-status"><b>${escapeHtml(cluster.status)}</b><span>${cluster.relations.length.toLocaleString('id-ID')} review pembanding${matched.length?` · ${escapeHtml(matched.join(' · '))} sama`:''}</span></div>
      <div class="duplicate-map-cluster">
        <div class="duplicate-reference">
          <div class="duplicate-node"><span>Review Acuan</span><b title="${escapeHtml(cluster.sourceId)}">${escapeHtml(cluster.sourceId)}</b></div>
          ${referenceText ? `<p class="duplicate-map-text">${escapeHtml(referenceText.slice(0,220))}${referenceText.length>220?'…':''}</p>` : ''}
        </div>
        <div class="duplicate-connector" aria-hidden="true"><i></i><span>→</span></div>
        <div class="duplicate-comparisons">${comparisons}</div>
      </div>
    </article>`;
  }).join('');

  const summary = [
    ...(potentialCount ? [`${potentialCount.toLocaleString('id-ID')} Potensi Duplikat`] : []),
    ...(exactCount ? [`${exactCount.toLocaleString('id-ID')} Duplikat Pasti`] : []),
    `${clusters.length.toLocaleString('id-ID')} kelompok`,
    `${unreviewedCount.toLocaleString('id-ID')} belum diputuskan`,
    ...(confirmedCount ? [`${confirmedCount.toLocaleString('id-ID')} benar duplikat`] : []),
    ...(rejectedCount ? [`${rejectedCount.toLocaleString('id-ID')} bukan duplikat`] : [])
  ].join(' · ');
  root.innerHTML = `<div class="duplicate-map-summary"><div><b>Visualisasi Duplikat</b><span>${summary}</span></div>${clusters.length>maxGroups?`<small>Menampilkan ${maxGroups.toLocaleString('id-ID')} kelompok pertama.</small>`:''}</div><div class="duplicate-map-list">${cards}</div>`;
  root.querySelectorAll('[data-duplicate-decision]').forEach(button => button.addEventListener('click', () => {
    const relation = relations.find(item => item.relationKey === button.dataset.relationKey);
    if (relation) saveDuplicateDecision(relation.row, button.dataset.duplicateDecision || 'unreviewed');
  }));
}

async function openPotentialDuplicateAudit() {
  if (state.running) return setStatus('Tunggu proses selesai sebelum membuka Potensi Duplikat.');
  if (!state.activeRunDir) return setStatus('Audit Potensi Duplikat tersedia pada sesi hasil yang aktif.');
  if (Number(state.datasetCounts?.possibleDuplicates || 0) <= 0) return setStatus('Sesi aktif tidak memiliki Potensi Duplikat.');
  await setDataDatasetMode('duplicates');
  setDuplicateViewMode('map');
  setStatus(`Menampilkan ${Number(state.datasetCounts?.possibleDuplicates || 0).toLocaleString('id-ID')} Potensi Duplikat.`);
}

function syncDuplicateViewControls() {
  const audit = state.activeDataset === 'duplicates' && !state.showingPreview;
  const map = audit && state.duplicateViewMode === 'map';
  $('duplicateViewSwitch')?.classList.toggle('hidden', !audit);
  $('duplicateAuditTools')?.classList.toggle('hidden', !audit);
  document.querySelector('.duplicate-audit-filters')?.classList.toggle('hidden', Boolean(state.activeCombinedDir));
  $('duplicateListBtn')?.classList.toggle('active', audit && !map);
  $('duplicateMapBtn')?.classList.toggle('active', map);
  $('duplicateListBtn')?.setAttribute('aria-pressed', String(audit && !map));
  $('duplicateMapBtn')?.setAttribute('aria-pressed', String(map));
  document.querySelectorAll('[data-duplicate-filter]').forEach(button => button.classList.toggle('active', button.dataset.duplicateFilter === state.duplicateAuditFilter));
  syncDuplicateAuditFilterCounters();
  if ($('duplicateAuditSearch') && $('duplicateAuditSearch').value !== state.duplicateAuditSearch) $('duplicateAuditSearch').value = state.duplicateAuditSearch;
  $('dataTableShell')?.classList.toggle('hidden', map);
  $('duplicateMapWorkspace')?.classList.toggle('hidden', !map);
  if (map) renderDuplicateMap();
}

function setDuplicateViewMode(mode = 'list') {
  state.duplicateViewMode = mode === 'map' ? 'map' : 'list';
  syncDuplicateViewControls();
}

function syncDataViewControls() {
  const selected = state.activeDataset || 'clean';
  const clean = selected === 'clean';
  const raw = selected === 'raw';
  const duplicates = selected === 'duplicates';
  $('dataCompactModeBtn')?.classList.toggle('active',clean);
  $('dataFullModeBtn')?.classList.toggle('active',raw);
  $('dataDuplicateModeBtn')?.classList.toggle('active',duplicates);
  $('dataCompactModeBtn')?.setAttribute('aria-pressed',String(clean));
  $('dataFullModeBtn')?.setAttribute('aria-pressed',String(raw));
  $('dataDuplicateModeBtn')?.setAttribute('aria-pressed',String(duplicates));
  if($('toggleColumnsBtn')) $('toggleColumnsBtn').textContent = clean ? 'Tabel: Hasil Cleaning' : raw ? 'Tabel: Data Asli' : 'Tabel: Audit Duplikat';
  syncDuplicateViewControls();
}

async function setDataDatasetMode(dataset='clean',{openData=true}={}) {
  const selected = ['clean','raw','duplicates'].includes(dataset) ? dataset : 'clean';
  state.dataColumnMode = selected === 'clean' ? 'compact' : 'full';
  if(openData) switchWorkspaceView('dataView');
  await selectDataset(selected);
}

function setDataColumnMode(mode='compact',{openData=true}={}) {
  // Legacy compatibility: old commands map to the simplified data views.
  return setDataDatasetMode(mode === 'full' ? 'raw' : 'clean',{openData});
}

function openGuideDialog(dialogId) {
  const dialog=$(dialogId);
  if(!dialog)return;
  const buttons=[...dialog.querySelectorAll('.guide-nav [data-guide-target]')];
  buttons.forEach((item,index)=>item.classList.toggle('active',index===0));
  const content=dialog.querySelector('.guide-content'); if(content) content.scrollTop=0;
  dialog.showModal();
}

function openUsageGuide() { openGuideDialog('guideDialog'); }
function openFlowGuide() { openGuideDialog('flowGuideDialog'); }

function syncViewScopedPanels() {
  const showSetup = state.activeView === 'browserView';
  document.body.classList.toggle('setup-panel-hidden', !showSetup);
  // v0.83: Persiapan is not a persistent sidebar anymore. It belongs only to
  // Mengatur Data, so legacy collapsed state must never leak between views.
  document.body.classList.remove('left-panel-collapsed', 'right-panel-collapsed', 'browser-view-only-setup');
  const preparation = document.querySelector('.left-panel');
  if (preparation) preparation.setAttribute('aria-hidden', showSetup ? 'false' : 'true');
}

function switchWorkspaceView(viewId,{focusLive=false}={}) {
  const firstFlowVisit=!state.flowViewVisited;
  state.activeView=viewId||'browserView';
  document.querySelectorAll('.workspace-view').forEach(view=>view.classList.toggle('active',view.id===state.activeView));
  const mainTabView = ['browserView','flowView'].includes(state.activeView) ? 'browserView' : state.activeView === 'logView' ? 'dataView' : state.activeView;
  document.querySelectorAll('.workspace-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===mainTabView));
  const manageVisible = ['browserView','flowView'].includes(state.activeView);
  $('manageViewSwitch')?.classList.toggle('hidden', !manageVisible);
  document.querySelector('.center-workspace')?.classList.toggle('manage-context-active', manageVisible);
  $('managePreparationBtn')?.classList.toggle('active', state.activeView === 'browserView');
  $('manageFlowBtn')?.classList.toggle('active', state.activeView === 'flowView');
  $('managePreparationBtn')?.setAttribute('aria-pressed', String(state.activeView === 'browserView'));
  $('manageFlowBtn')?.setAttribute('aria-pressed', String(state.activeView === 'flowView'));
  syncViewScopedPanels();
  updateBrowserKeepAlive();
  syncBrowserMonitor();
  if(state.activeView==='flowView') {
    state.flowMode='project';
    state.flowViewVisited=true;
    renderFlowCanvas(false,{runtimeOnly:state.flowRenderedSignature!==''});
    requestAnimationFrame(()=>{
      if(focusLive||(firstFlowVisit&&state.running)) state.flowController?.setViewMode?.('focus');
      else if(firstFlowVisit) state.flowController?.setViewMode?.('overview');
    });
  }
  if(state.activeView==='historyView') renderHistoryWorkspace();
  if(state.activeView==='browserView') {
    requestAnimationFrame(()=>requestAnimationFrame(()=>resyncLiveBrowserSurface()));
  }
  if(state.running && (state.activeView==='dataView' || state.activeView==='logView')) scheduleLiveRunUiRefresh({ immediate: true });
}

function updateBrowserKeepAlive() {
  const browserView=$('browserView');
  if(!browserView)return;
  const parked=Boolean(state.running&&state.activeView!=='browserView');
  // Keep the guest surface fully composited underneath the active workspace. Using
  // opacity≈0 / negative z-index caused Chromium to stop visually repainting SPA
  // pagination even though the same webContents kept changing internally.
  browserView.classList.toggle('browser-keepalive',parked);
  browserView.setAttribute('aria-hidden',parked?'true':'false');
  browserView.dataset.liveBacking=parked?'true':'false';
  if(!parked && state.running) requestAnimationFrame(()=>resyncLiveBrowserSurface());
}

function browserMonitorShouldShow() {
  return Boolean(state.running && state.activeView !== 'browserView' && resolvedAcquisitionMethod() === 'dom');
}

function stopBrowserMonitorCapture() {
  if (state.browserMonitorTimer) clearInterval(state.browserMonitorTimer);
  state.browserMonitorTimer = null;
  state.browserMonitorBusy = false;
}

function updateBrowserMonitorText(payload = state.lastRunBrowserActivity) {
  const status = $('browserMonitorStatus');
  const meta = $('browserMonitorMeta');
  if (status) status.textContent = payload ? browserRunActivityLabel(payload) : 'Pengambilan berjalan';
  if (meta) {
    const tab = browserTabById();
    const host = (() => { try { return new URL(String(tab?.url || currentBrowserUrl() || '')).hostname.replace(/^www\./,''); } catch { return ''; } })();
    meta.textContent = `${host ? host + ' · ' : ''}Preview read-only · browser sumber tetap aktif`;
  }
}

async function refreshBrowserMonitorFrame({ force = false } = {}) {
  if (!browserMonitorShouldShow() || state.browserMonitorBusy || !appApi.captureBrowserPreview) return false;
  const now = Date.now();
  if (!force && now - Number(state.browserMonitorLastFrameAt || 0) < 1100) return false;
  let id = null;
  try { id = browser?.getWebContentsId?.() || null; } catch {}
  if (id == null) return false;
  state.browserMonitorBusy = true;
  try {
    const result = await appApi.captureBrowserPreview(id, { width: 360, height: 203 });
    if (!result?.ok || !result.dataUrl) return false;
    const image = $('browserMonitorImage');
    const placeholder = $('browserMonitorPlaceholder');
    if (image) {
      image.src = result.dataUrl;
      image.classList.add('ready');
    }
    placeholder?.classList.add('hidden');
    state.browserMonitorLastFrameAt = Date.now();
    return true;
  } catch {
    return false;
  } finally {
    state.browserMonitorBusy = false;
  }
}

function syncBrowserMonitor() {
  const dock = $('browserMonitorDock');
  const center = document.querySelector('.center-workspace');
  if (!dock || !center) return;
  const visible = browserMonitorShouldShow();
  dock.classList.toggle('hidden', !visible);
  center.classList.toggle('browser-monitor-visible', visible);
  updateBrowserMonitorText();
  if (!visible) {
    stopBrowserMonitorCapture();
    return;
  }
  refreshBrowserMonitorFrame({ force: true });
  if (!state.browserMonitorTimer) {
    state.browserMonitorTimer = setInterval(() => refreshBrowserMonitorFrame(), 1500);
  }
}

async function keepLiveBrowserResponsive(webContentsId=null) {
  let id=webContentsId;
  if(id==null){try{id=browser.getWebContentsId?.()||null;}catch{}}
  if(id==null||!appApi.setBrowserBackgroundThrottling)return false;
  try {
    const result=await appApi.setBrowserBackgroundThrottling(id,false);
    return Boolean(result?.ok);
  } catch { return false; }
}

function selectResultPane(name='data') {
  const showLog=name==='log';
  $('resultDataTab')?.classList.toggle('active',!showLog);
  $('resultLogTab')?.classList.toggle('active',showLog);
  $('resultDataTab')?.setAttribute('aria-selected',String(!showLog));
  $('resultLogTab')?.setAttribute('aria-selected',String(showLog));
  $('resultDataPane')?.classList.toggle('active',!showLog);
  $('resultLogPane')?.classList.toggle('active',showLog);
}

function safeStorageGet(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function safeStorageSet(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }

function loadAppearance() {
  const rawScale=Number(safeStorageGet('crawlloom.uiScale',1.1));
  state.appearance={
    theme:safeStorageGet('crawlloom.theme','system')||'system',
    uiScale:Number.isFinite(rawScale)?rawScale:1.1,
    textSize:safeStorageGet('crawlloom.textSize','normal')||'normal'
  };
  applyAppearance();
}

function resolvedTheme() {
  if(state.appearance.theme==='system') return window.matchMedia?.('(prefers-color-scheme: light)')?.matches?'light':'dark';
  return state.appearance.theme==='light'?'light':'dark';
}

function applyAppearance() {
  document.body.dataset.theme=resolvedTheme();
  document.body.dataset.textSize=state.appearance.textSize||'normal';
  document.documentElement.style.setProperty('--ui-scale',String(state.appearance.uiScale||1.1));
  if($('themeSelect')) $('themeSelect').value=state.appearance.theme;
  if($('uiScaleSelect')) $('uiScaleSelect').value=String(state.appearance.uiScale);
  if($('textSizeSelect')) $('textSizeSelect').value=state.appearance.textSize;
}

function saveAppearanceFromDialog() {
  state.appearance.theme=$('themeSelect').value;
  state.appearance.uiScale=Number($('uiScaleSelect').value)||1.1;
  state.appearance.textSize=$('textSizeSelect').value||'normal';
  safeStorageSet('crawlloom.theme',state.appearance.theme);
  safeStorageSet('crawlloom.uiScale',state.appearance.uiScale);
  safeStorageSet('crawlloom.textSize',state.appearance.textSize);
  applyAppearance();
  setStatus(`Tampilan diterapkan: tema ${state.appearance.theme==='system'?'mengikuti sistem':state.appearance.theme==='light'?'terang':'gelap'}, skala ${Math.round(state.appearance.uiScale*100)}%.`);
}

function stepUiScale(delta) {
  const values=[.9,1,1.1,1.2,1.3,1.5];
  let current=values.reduce((best,v)=>Math.abs(v-state.appearance.uiScale)<Math.abs(best-state.appearance.uiScale)?v:best,1.1);
  let i=values.indexOf(current); i=Math.max(0,Math.min(values.length-1,i+delta));
  state.appearance.uiScale=values[i];
  safeStorageSet('crawlloom.uiScale',values[i]); applyAppearance();
  setStatus(`Skala antarmuka ${Math.round(values[i]*100)}%. Zoom halaman web tidak berubah.`);
}

function openAppearanceDialog() {
  applyAppearance();
  $('appearanceDialog')?.showModal();
}

async function openAboutDialog() {
  try { const info=await appApi.getAppInfo(); if(info?.version) $('aboutVersion').textContent=`${info.version}`; } catch {}
  $('aboutDialog')?.showModal();
}

async function detectAccessState() {
  if(!browser.src) return 'unknown';
  try {
    return await browser.executeJavaScript(`(() => {
      const text=(document.body?.innerText||'').slice(0,25000).toLowerCase();
      const title=(document.title||'').toLowerCase();
      if(/access is temporarily restricted|unusual activity|akses\s+dibatasi\s+(?:untuk\s+)?sementara|akses\s+sementara\s+dibatasi|pemblokiran ini perlu|access denied|forbidden/.test(text+' '+title)) return 'restricted';
      if(/captcha|verify you are human|security check|challenge/.test(text+' '+title)) return 'challenge';
      if(!document.body) return 'unknown';
      return 'ok';
    })()`,true);
  } catch { return 'unknown'; }
}

function currentBrowserUrl() {
  try {
    const value = browser.getURL?.();
    if (/^(?:https?:|file:)\/\//i.test(String(value || ''))) return value;
  } catch {}
  return String($('urlInput')?.value || state.project.startUrl || '').trim();
}

function renderBrowserProfileBadge() {
  const badge = $('browserProfileBadge');
  if (!badge) return;
  const profile = state.browserProfile || {};
  const engineVersion = profile.chromiumVersion ? `Chromium ${profile.chromiumVersion}` : 'Embedded Chromium';
  const chromeReady = Boolean(profile.googleChromeInstalled);
  badge.textContent = chromeReady ? `${engineVersion} · Chrome siap` : `${engineVersion} · Chrome belum ditemukan`;
  badge.classList.toggle('good', chromeReady);
  badge.classList.toggle('warn', !chromeReady);
  const details = [
    `Engine: ${profile.engine || 'Electron Chromium'}`,
    profile.electronVersion ? `Electron: ${profile.electronVersion}` : '',
    profile.chromiumVersion ? `Chromium: ${profile.chromiumVersion}` : '',
    `Sesi persisten: ${profile.persistent ? 'aktif' : 'tidak aktif'}`,
    profile.acceptLanguages ? `Bahasa: ${profile.acceptLanguages}` : '',
    profile.googleChromePath ? `Google Chrome: ${profile.googleChromePath}` : 'Google Chrome: tidak ditemukan'
  ].filter(Boolean);
  badge.title = details.join('\n');
}

async function openCurrentPageInChrome() {
  const target = currentBrowserUrl();
  if (!/^https?:\/\//i.test(target)) return setStatus('Buka halaman HTTP/HTTPS terlebih dahulu sebelum mengirimnya ke Google Chrome.');
  try {
    const result = await appApi.openChromeUrl(target);
    setStatus(`Halaman dibuka di Google Chrome.`);
    if (result?.chromePath && state.browserProfile) {
      state.browserProfile.googleChromeInstalled = true;
      state.browserProfile.googleChromePath = result.chromePath;
      state.browserProfile.chromeProfileDir = result.profileDir || state.browserProfile.chromeProfileDir;
      renderBrowserProfileBadge();
    }
  } catch (error) {
    setStatus(`Google Chrome tidak dapat dibuka: ${error.message}`);
  }
}

function renderBrowserAccessNotice(accessState = state.runtimeFlow.accessStatus) {
  const notice = $('browserAccessNotice');
  if (!notice) return;
  const blocked = accessState === 'restricted' || accessState === 'challenge';
  notice.classList.toggle('hidden', !blocked);
  if (!blocked) return;
  const challenge = accessState === 'challenge';
  const site = effectiveSiteProfile();
  const traveloka = site === 'traveloka';
  if ($('browserAccessTitle')) $('browserAccessTitle').textContent = challenge
    ? 'Situs meminta verifikasi manusia'
    : 'Situs membatasi browser tertanam';
  if ($('browserAccessText')) $('browserAccessText').textContent = challenge
    ? 'Verifikasi situs harus diselesaikan secara manual di browser biasa. Workflow resmi MyDataset menggunakan HAR / Network.'
    : 'Browser tertanam tidak digunakan untuk akuisisi review. Buka sumber di Chrome/Edge, rekam Network, lalu impor HAR with content.';
  if ($('importBlockedNetworkJsonBtn')) $('importBlockedNetworkJsonBtn').classList.toggle('hidden', !['traveloka','tiket','agoda','trip','booking'].includes(site));
}

function initFlowCanvas() {
  if(!window.CrawlLoomFlowCanvas || !$('flowViewport')) return;
  state.flowController=window.CrawlLoomFlowCanvas.createController({
    viewport:$('flowViewport'),stage:$('flowStage'),nodesRoot:$('flowNodes'),edgesSvg:$('flowEdges'),
    inspector:$('flowInspector'),inspectorBody:$('flowInspectorBody'),minimap:$('flowMinimapContent'),zoomLabel:$('flowZoomLabel'),followButton:$('flowFollowBtn'),overviewButton:$('flowOverviewBtn')
  });
  renderFlowCanvas(state.activeView==='flowView');
}

function renderFlowCanvas(force=false,{runtimeOnly=false}={}) {
  if(!state.flowController || !window.CrawlLoomFlowCanvas) return;
  if(!force&&state.activeView!=='flowView'){state.flowDirty=true;return;}
  state.flowDirty=false;
  const runtime={
    ...state.runtimeFlow,
    currentUrl:state.runtimeFlow.currentUrl||$('urlInput')?.value||state.project.startUrl,
    rows:state.showingPreview?state.previewRows.length:(state.results.length||state.runtimeFlow.rows||0),
    duplicates:Number($('runDuplicates')?.textContent?.replace(/\D/g,'')||state.runtimeFlow.duplicates||0),
    runStatus:$('runStatus')?.textContent||state.runtimeFlow.runStatus||'Idle',
    running:state.running
  };
  state.flowMode='project';
  const graph=window.CrawlLoomFlowCanvas.projectGraph(state.project,runtime);
  const signature=JSON.stringify({mode:'project',project:state.project});
  const canUpdate=(runtimeOnly||signature===state.flowRenderedSignature)&&typeof state.flowController.updateRuntime==='function';
  if(canUpdate) {
    state.flowController.updateRuntime(graph);
    state.flowRenderedSignature=signature;
  } else {
    state.flowController.render(graph);
    state.flowRenderedSignature=signature;
  }
  if($('flowTitle')) $('flowTitle').textContent=graph.title||'Alur Proses';
}

function shortSessionId(run = {}) {
  const value = String(run.sessionId || run.runId || '').trim();
  if (!value) return 'Legacy';
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function updateHistoryModeControls() {
  const combined = state.historyMode === 'combined';
  $('historySessionsBtn')?.classList.toggle('active', !combined);
  $('historyCombinedBtn')?.classList.toggle('active', combined);
  $('historyMergeBar')?.classList.toggle('hidden', combined);
  const clearButton = $('historyClearBtn');
  if (clearButton) clearButton.classList.remove('hidden');
  if (!combined) {
    const selected = state.selectedSessionDirs.size;
    const minimum = state.combinedBaseDir ? 1 : 2;
    if ($('combineSessionsBtn')) {
      $('combineSessionsBtn').disabled = state.running || selected < minimum;
      $('combineSessionsBtn').textContent = state.combinedBaseDir ? 'Tambahkan Sesi Terpilih' : 'Gabungkan Sesi Terpilih';
    }
    if ($('combinedDatasetName')) {
      if (state.combinedBaseName && !$('combinedDatasetName').value.trim()) $('combinedDatasetName').value = state.combinedBaseName;
      $('combinedDatasetName').disabled = Boolean(state.combinedBaseDir);
    }
    const info = $('historyMergeBar')?.querySelector('small');
    const title = $('historyMergeBar')?.querySelector('b');
    if (title) title.textContent = state.combinedBaseDir ? 'Tambah Sesi ke Dataset Gabungan' : 'Gabungkan Dataset';
    if (info) info.textContent = state.combinedBaseDir
      ? 'Pilih sesi tambahan. Versi lama tetap utuh dan versi baru akan dibuat.'
      : 'Pilih minimal dua sesi. Sesi asli tidak diubah.';
  }
}

async function setHistoryMode(mode = 'sessions') {
  state.historyMode = mode === 'combined' ? 'combined' : 'sessions';
  updateHistoryModeControls();
  await renderHistoryWorkspace();
}

async function openCurrentDataSource() {
  try {
    if (state.activeCombinedDir) {
      await appApi.openCombinedDataset(state.activeCombinedDir);
      return setStatus('Folder dibuka.');
    }
    if (!state.activeRunDir) return setStatus('Belum ada sesi aktif yang memiliki Data Sumber.');
    const result = await appApi.openRunSource(state.activeRunDir);
    if (!result?.ok) setStatus(result?.error || 'Data Sumber belum tersedia.');
    else setStatus('Folder Data Sumber dibuka.');
  } catch (error) {
    setStatus(`Data Sumber tidak dapat dibuka: ${error.message}`);
  }
}

async function openCurrentDataFolder() {
  try {
    if (state.activeCombinedDir) {
      const result = await appApi.openCombinedDataset(state.activeCombinedDir);
      if (!result?.ok) return setStatus(result?.error || 'Folder tidak dapat dibuka.');
      return setStatus('Folder dibuka.');
    }
    if (!state.activeRunDir) return setStatus('Belum ada dataset aktif yang memiliki folder hasil.');
    const result = await appApi.openRunOutput(state.activeRunDir);
    if (!result?.ok) setStatus(result?.error || 'Folder tidak dapat dibuka.');
    else setStatus('Folder dibuka.');
  } catch (error) {
    setStatus(`Folder tidak dapat dibuka: ${error.message}`);
  }
}

async function requestCombinedCanonicalOverrides(runDirs = []) {
  const dialog = $('combinedIdentityDialog');
  const list = $('combinedIdentityRows');
  const shared = $('combinedCanonicalAll');
  if (!dialog || !list) return {};
  let runs = [];
  try { runs = await appApi.listRuns(); } catch {}
  const byDir = new Map((runs || []).map(run => [String(run.runDir || ''), run]));
  const selected = (runDirs || []).map(runDir => byDir.get(String(runDir || ''))).filter(Boolean);
  if (!selected.length) return {};

  list.innerHTML = '';
  if (shared) shared.value = '';
  const selectedKeys = [];
  for (const run of selected) {
    const key = String(run.sessionId || run.runId || '').trim();
    if (!key) continue;
    selectedKeys.push(key);
    const objectName = String(run.objectName || run.projectName || 'Objek tanpa nama').trim();
    const row = document.createElement('div');
    row.className = 'combined-identity-row';
    row.innerHTML = `<div class="identity-source"><b>${escapeHtml(objectName)}</b><span>${escapeHtml(runSiteLabel(run))} · ${escapeHtml(shortSessionId(run))}</span></div>`;
    list.appendChild(row);
  }

  return await new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue === 'cancel') return resolve(null);
      const overrides = {};
      const sharedValue = String(shared?.value || '').replace(/\s+/g, ' ').trim();
      if (sharedValue) selectedKeys.forEach(key => { overrides[key] = sharedValue; });
      resolve(overrides);
    };
    dialog.addEventListener('close', onClose, { once: true });
    try { dialog.showModal(); } catch { resolve({}); }
  });
}

async function combineSelectedSessions() {
  if (state.running) return setStatus('Tunggu run selesai sebelum membuat Dataset Gabungan.');
  const runDirs = [...state.selectedSessionDirs];
  const minimum = state.combinedBaseDir ? 1 : 2;
  if (runDirs.length < minimum) return setStatus(state.combinedBaseDir ? 'Pilih minimal satu sesi tambahan.' : 'Pilih minimal dua sesi untuk digabungkan.');
  const name = String($('combinedDatasetName')?.value || state.combinedBaseName || 'Dataset Gabungan').trim() || 'Dataset Gabungan';
  const canonicalOverrides = await requestCombinedCanonicalOverrides(runDirs);
  if (canonicalOverrides === null) return setStatus('Penggabungan dibatalkan.');
  try {
    if ($('combineSessionsBtn')) $('combineSessionsBtn').disabled = true;
    setStatus(state.combinedBaseDir ? 'Membuat versi baru Dataset Gabungan…' : 'Menggabungkan sesi…');
    const result = await appApi.createCombinedDataset({ name, runDirs, baseDatasetDir: state.combinedBaseDir || null, canonicalOverrides });
    const counts = result?.manifest?.counts || {};
    state.selectedSessionDirs.clear();
    state.combinedBaseDir = null;
    state.combinedBaseName = '';
    if ($('combinedDatasetName')) $('combinedDatasetName').value = '';
    state.historyMode = 'combined';
    updateHistoryModeControls();
    await renderHistoryWorkspace();
    const potentialIntra = Number(counts.intraSessionCandidateDuplicates || 0);
    const potentialCross = Number(counts.crossSessionCandidateDuplicates ?? counts.candidateDuplicates ?? 0);
    const statusParts = [`${Number(counts.sessions || 0).toLocaleString('id-ID')} sesi`, `${Number(counts.clean || 0).toLocaleString('id-ID')} data`];
    if (Number(counts.crossSessionExactDuplicates ?? counts.duplicates ?? 0) > 0) statusParts.push(`${Number(counts.crossSessionExactDuplicates ?? counts.duplicates ?? 0).toLocaleString('id-ID')} duplikat pasti lintas sumber`);
    if (potentialIntra > 0) statusParts.push(`${potentialIntra.toLocaleString('id-ID')} kandidat dari sesi sumber`);
    if (potentialCross > 0) statusParts.push(`${potentialCross.toLocaleString('id-ID')} kandidat lintas sumber`);
    setStatus(`Dataset Gabungan dibuat: ${statusParts.join(' · ')}.`);
  } catch (error) {
    updateHistoryModeControls();
    setStatus(`Dataset Gabungan gagal dibuat: ${error.message}`);
  }
}

async function showCombinedDataset(dataset) {
  try {
    const data = await appApi.getCombinedDataset(dataset.directory, 0, 'clean');
    const counts = data.manifest?.counts || dataset.counts || {};
    state.showingPreview = false;
    state.activeRunDir = null;
    state.activeCombinedDir = dataset.directory;
    state.activeCombinedManifest = data.manifest || dataset || null;
    state.duplicateDecisions = {};
    state.duplicateAuditFilter = 'all';
    state.duplicateAuditSearch = '';
    state.results = data.rows || [];
    state.datasetRows = { clean: state.results, duplicates: [], raw: [] };
    state.datasetCounts = {
      clean: Number(counts.clean || state.results.length),
      raw: Number(counts.input || counts.clean || state.results.length),
      // `duplicates` controls whether the Audit tab is available. For a combined
      // dataset it represents all audit rows (source-session + cross-session).
      duplicates: Number(counts.auditRows || 0),
      exactDuplicates: Number(counts.crossSessionExactDuplicates ?? counts.duplicates ?? 0),
      possibleDuplicates: Number(counts.intraSessionCandidateDuplicates || 0) + Number(counts.crossSessionCandidateDuplicates ?? counts.candidateDuplicates ?? 0),
      text: Number(counts.text || data.manifest?.composition?.clean?.withText || 0),
      withoutText: Number(counts.withoutText || data.manifest?.composition?.clean?.withoutText || 0),
      nativeReviewIds: 0,
      syntheticReviewIds: 0,
      missingReviewIds: 0
    };
    state.activeDataset = 'clean';
    setMetricLabels('combined');
    $('runStatus').textContent = 'Dataset Gabungan';
    $('runRaw').textContent = Number(counts.sessions || data.manifest?.sessions?.length || 0).toLocaleString('id-ID');
    $('runCollected').textContent = Number(state.datasetCounts.clean).toLocaleString('id-ID');
    $('runDuplicates').textContent = Number(state.datasetCounts.exactDuplicates || 0).toLocaleString('id-ID');
    if ($('runPossibleDuplicates')) $('runPossibleDuplicates').textContent = '0';
    updateDatasetUi();
    renderResults(state.datasetCounts.clean);
    switchWorkspaceView('dataView');
    setStatus(`Dataset Gabungan: ${Number(state.datasetCounts.clean).toLocaleString('id-ID')} baris.`);
  } catch (error) {
    setStatus(`Dataset Gabungan tidak dapat dibuka: ${error.message}`);
  }
}

async function renderHistoryWorkspace() {
  const root = $('historyWorkspaceList');
  if (!root) return;
  updateHistoryModeControls();
  root.innerHTML = '<div class="empty-list">Memuat riwayat…</div>';

  if (state.historyMode === 'combined') {
    let datasets = [];
    try { datasets = await appApi.listCombinedDatasets(); } catch {}
    root.innerHTML = '';
    const clearButton = $('historyClearBtn');
    if (clearButton) {
      clearButton.dataset.empty = String(!datasets.length);
      clearButton.disabled = state.running || !datasets.length;
      clearButton.textContent = datasets.length ? `Bersihkan Riwayat Gabungan (${datasets.length.toLocaleString('id-ID')})` : 'Bersihkan Riwayat Gabungan';
      clearButton.title = 'Hapus seluruh Dataset Gabungan; sesi sumber tetap aman';
    }
    if (!datasets.length) {
      root.innerHTML = '<div class="empty-list">Belum ada Dataset Gabungan. Pilih tab Sesi lalu gabungkan minimal dua sesi.</div>';
      return;
    }
    for (const dataset of datasets) {
      const card = document.createElement('div');
      card.className = 'history-card combined-history-card';
      const counts = dataset.counts || {};
      const exactCross = Number(counts.crossSessionExactDuplicates ?? counts.duplicates ?? 0);
      const potentialIntra = Number(counts.intraSessionCandidateDuplicates || 0);
      const potentialCross = Number(counts.crossSessionCandidateDuplicates ?? counts.candidateDuplicates ?? 0);
      const summaryParts = [`${Number(counts.sessions || 0).toLocaleString('id-ID')} sesi`, `${Number(counts.clean || 0).toLocaleString('id-ID')} data`];
      if (exactCross > 0) summaryParts.push(`${exactCross.toLocaleString('id-ID')} duplikat pasti lintas sumber`);
      if (potentialIntra > 0) summaryParts.push(`${potentialIntra.toLocaleString('id-ID')} kandidat sesi sumber`);
      if (potentialCross > 0) summaryParts.push(`${potentialCross.toLocaleString('id-ID')} kandidat lintas sumber`);
      summaryParts.push(escapeHtml(formatDate(dataset.createdAt)));
      card.innerHTML = `<div class="history-card-info"><b>${escapeHtml(dataset.name || 'Dataset Gabungan')}</b><span>${summaryParts.join(' · ')}</span></div><div class="history-card-actions"></div>`;
      const actions = card.querySelector('.history-card-actions');
      const view = document.createElement('button');
      view.textContent = 'Lihat Dataset';
      view.addEventListener('click', () => showCombinedDataset(dataset));
      actions.appendChild(view);
      const add = document.createElement('button');
      add.textContent = 'Tambah Sesi';
      add.title = 'Buat versi baru dengan menambahkan sesi tanpa mengubah versi ini';
      add.addEventListener('click', async () => {
        state.combinedBaseDir = dataset.directory;
        state.combinedBaseName = dataset.name || 'Dataset Gabungan';
        state.selectedSessionDirs.clear();
        if ($('combinedDatasetName')) $('combinedDatasetName').value = state.combinedBaseName;
        await setHistoryMode('sessions');
        setStatus(`Pilih sesi tambahan untuk “${state.combinedBaseName}”. Versi lama tetap aman.`);
      });
      actions.appendChild(add);
      const folder = document.createElement('button');
      folder.textContent = 'Buka Folder';
      folder.addEventListener('click', () => appApi.openCombinedDataset(dataset.directory));
      actions.appendChild(folder);
      const remove = document.createElement('button');
      remove.textContent = 'Hapus';
      remove.className = 'danger-soft';
      remove.title = 'Hapus versi Dataset Gabungan ini';
      remove.addEventListener('click', () => deleteCombinedHistoryDataset(dataset));
      actions.appendChild(remove);
      root.appendChild(card);
    }
    return;
  }

  const clearButton = $('historyClearBtn');
  if (clearButton) { clearButton.disabled = true; clearButton.textContent = 'Bersihkan Riwayat'; clearButton.dataset.empty = 'true'; clearButton.title = 'Hapus seluruh data run dan folder Dataset; file proyek tetap aman'; }
  let runs = [];
  try { runs = await appApi.listRuns(); } catch {}
  root.innerHTML = '';
  const validRunDirs = new Set(runs.map(run => run.runDir));
  for (const selected of [...state.selectedSessionDirs]) if (!validRunDirs.has(selected)) state.selectedSessionDirs.delete(selected);
  if (clearButton) {
    clearButton.dataset.empty = String(!runs.length);
    clearButton.disabled = state.running || !runs.length;
    clearButton.textContent = runs.length ? `Bersihkan Riwayat Sesi (${runs.length.toLocaleString('id-ID')})` : 'Bersihkan Riwayat';
  }
  if (!runs.length) {
    root.innerHTML = '<div class="empty-list">Belum ada sesi. Riwayat akan muncul setelah proses pertama dijalankan.</div>';
    updateHistoryModeControls();
    return;
  }

  for (const run of runs) {
    const card = document.createElement('div');
    card.className = 'history-card session-history-card';
    const rawCount = Number(run.rawItemsRead ?? run.itemsCollected ?? 0);
    const cleanCount = Number(run.itemsCollected || 0);
    const exact = Number(run.exactDuplicates ?? run.duplicatesSkipped ?? 0);
    const possible = Number(run.possibleDuplicates || 0);
    const select = document.createElement('label');
    select.className = 'history-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedSessionDirs.has(run.runDir);
    checkbox.disabled = state.running;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedSessionDirs.add(run.runDir);
      else state.selectedSessionDirs.delete(run.runDir);
      card.classList.toggle('selected', checkbox.checked);
      updateHistoryModeControls();
    });
    select.append(checkbox, document.createTextNode(' Pilih'));
    card.classList.toggle('selected', checkbox.checked);
    card.appendChild(select);

    const info = document.createElement('div');
    info.className = 'history-card-info';
    const summaryParts = [escapeHtml(runSiteLabel(run)), escapeHtml(runAcquisitionLabel(run)), `${cleanCount.toLocaleString('id-ID')} data`];
    if (exact > 0) summaryParts.push(`${exact.toLocaleString('id-ID')} duplikat pasti`);
    if (possible > 0) summaryParts.push(`${possible.toLocaleString('id-ID')} potensi duplikat`);
    summaryParts.push(escapeHtml(formatDate(run.updatedAt)));
    info.innerHTML = `<b>${escapeHtml(run.projectName || 'Proyek')}</b><span>${summaryParts.join(' · ')}</span>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'history-card-actions';
    const view = document.createElement('button');
    view.textContent = 'Lihat Dataset';
    view.addEventListener('click', async () => {
      const data = await appApi.getRunResults(run.runDir, 300);
      state.showingPreview = false;
      state.activeCombinedDir = null;
      state.activeCombinedManifest = null;
      state.activeRunDir = run.runDir;
      state.results = data.rows || [];
      state.datasetRows = { clean: state.results, duplicates: [], raw: [] };
      state.datasetCounts = data.counts || { clean:Number(data.state?.itemsCollected || state.results.length), raw:Number(data.state?.rawItemsRead || data.state?.itemsCollected || state.results.length), duplicates:Number(data.state?.exactDuplicates ?? data.state?.duplicatesSkipped ?? 0)+Number(data.state?.possibleDuplicates || 0), exactDuplicates:Number(data.state?.exactDuplicates ?? data.state?.duplicatesSkipped ?? 0), possibleDuplicates:Number(data.state?.possibleDuplicates || 0), text:Number(data.counts?.text||0), withoutText:Number(data.counts?.withoutText||0), nativeReviewIds:Number(data.counts?.nativeReviewIds||data.state?.nativeReviewIds||0), syntheticReviewIds:Number(data.counts?.syntheticReviewIds||data.state?.syntheticReviewIds||0), missingReviewIds:Number(data.counts?.missingReviewIds||data.state?.missingReviewIds||0) };
      state.activeDataset = 'clean';
      setMetricLabels('run');
      updateDatasetUi();
      renderResults(data.state?.itemsCollected);
      if (data.state) updateRunMetrics(data.state);
      switchWorkspaceView('dataView');
    });
    actions.appendChild(view);
    const source = document.createElement('button');
    source.textContent = 'Data Sumber';
    source.addEventListener('click', () => appApi.openRunSource(run.runDir));
    actions.appendChild(source);
    const folder = document.createElement('button');
    folder.textContent = 'Buka Folder';
    folder.addEventListener('click', () => appApi.openRunOutput(run.runDir));
    actions.appendChild(folder);
    const remove = document.createElement('button');
    remove.textContent = 'Hapus';
    remove.className = 'danger-soft';
    remove.title = 'Hapus sesi dan folder Dataset ini';
    remove.addEventListener('click', () => deleteHistoryRun(run));
    actions.appendChild(remove);
    card.appendChild(actions);
    root.appendChild(card);
  }
  updateHistoryModeControls();
}

async function deleteHistoryRun(run) {
  if(state.running)return setStatus('Jeda atau tunggu run selesai sebelum menghapus riwayat.');
  try{
    const result=await appApi.deleteRunHistory(run.runDir);
    if(result?.canceled)return;
    if(result?.deleted){
      if(state.activeRunDir===run.runDir)clearVisibleRunState();
      await renderHistoryWorkspace();
      setStatus(`Riwayat “${run.projectName||'Proyek'}” beserta folder Dataset telah dihapus. File proyek tetap aman.`);
    }else{
      await renderHistoryWorkspace();
      setStatus('Riwayat tersebut sudah tidak tersedia.');
    }
  }catch(error){setStatus(`Riwayat tidak dapat dihapus: ${error.message}`);}
}

async function deleteCombinedHistoryDataset(dataset) {
  if(state.running)return setStatus('Jeda atau tunggu run selesai sebelum menghapus Dataset Gabungan.');
  try{
    const result=await appApi.deleteCombinedHistory(dataset.directory);
    if(result?.canceled)return;
    if(result?.deleted){
      if(state.activeCombinedDir===dataset.directory)clearVisibleRunState();
      if(state.combinedBaseDir===dataset.directory){state.combinedBaseDir=null;state.combinedBaseName='';}
      await renderHistoryWorkspace();
      setStatus(`Dataset Gabungan “${dataset.name||'Dataset Gabungan'}” telah dihapus. Sesi sumber tetap aman.`);
    }else{
      await renderHistoryWorkspace();
      setStatus('Dataset Gabungan tersebut sudah tidak tersedia.');
    }
  }catch(error){setStatus(`Dataset Gabungan tidak dapat dihapus: ${error.message}`);}
}

async function clearHistoryWorkspace() {
  if(state.running)return setStatus('Jeda atau tunggu run selesai sebelum membersihkan riwayat.');
  try{
    if(state.historyMode==='combined'){
      const result=await appApi.clearCombinedHistory();
      if(result?.canceled)return;
      if(state.activeCombinedDir)clearVisibleRunState();
      state.combinedBaseDir=null;state.combinedBaseName='';
      await renderHistoryWorkspace();
      return setStatus(`${Number(result?.deleted||0).toLocaleString('id-ID')} Dataset Gabungan dibersihkan. Sesi sumber tetap aman.`);
    }
    const result=await appApi.clearRunHistory();
    if(result?.canceled)return;
    clearVisibleRunState();
    state.recoverableRun=null;
    renderRecoveryCard();
    await renderHistoryWorkspace();
    setStatus(`${Number(result?.deleted||0).toLocaleString('id-ID')} riwayat run dan folder Dataset dibersihkan. File proyek tetap aman.`);
  }catch(error){setStatus(`Riwayat tidak dapat dibersihkan: ${error.message}`);}
}

async function handleMenuCommand(command, payload = null) {
  switch(command){
    case 'project:new': openResetDialog('project'); break;
    case 'project:open': await openProject(); break;
    case 'project:save': await saveProject(false); break;
    case 'project:save-as': await saveProject(true); break;
    case 'browser:focus-url': switchWorkspaceView('browserView'); $('urlInput')?.focus(); $('urlInput')?.select(); break;
    case 'browser:back': switchWorkspaceView('browserView'); if (browser?.canGoBack?.()) browser.goBack(); break;
    case 'browser:forward': switchWorkspaceView('browserView'); if (browser?.canGoForward?.()) browser.goForward(); break;
    case 'browser:reload': switchWorkspaceView('browserView'); try { browser?.reload?.(); } catch {} break;
    case 'browser:new-tab': switchWorkspaceView('browserView'); createBrowserTab('', { active: true }); break;
    case 'browser:close-tab': closeBrowserTab(); break;
    case 'browser:use-active': switchWorkspaceView('browserView'); await refreshSourceIdentity({ claimPage: true, userInitiated: true }); break;
    case 'browser:open-chrome': await openCurrentPageInChrome(); break;
    case 'acquisition:open-har': switchWorkspaceView('browserView'); await focusNetworkJsonUpload(); await stageNetworkJsonFiles(); break;
    case 'folder:project': await appApi.openWorkspace(state.project.name); break;
    case 'folder:results': await openResultLocation(); break;
    // v0.74: export labels mirror the three result views instead of exposing
    // implementation terms such as "Situs", "Standar", or "Clean".
    case 'export:clean-csv': await exportData('csv','canonical','clean'); break;
    case 'export:clean-xlsx': await exportData('xlsx','canonical','clean'); break;
    case 'export:clean-json': await exportData('json','canonical','clean'); break;
    case 'export:text-csv': await exportData('csv','canonical','clean',{textOnly:true}); break;
    case 'export:raw-csv': await exportData('csv','native','raw'); break;
    case 'export:duplicates-csv': await exportData('csv','native','duplicates'); break;
    // Keep old command IDs as compatibility aliases for projects/shortcuts created
    // by previous versions.
    case 'export:csv': await exportData('csv','canonical','clean'); break;
    case 'export:standard-csv': await exportData('csv','canonical','clean'); break;
    case 'export:standard-xlsx': await exportData('xlsx','canonical','clean'); break;
    case 'export:json': await exportData('json','canonical','clean'); break;
    case 'export:bundle': await exportAllDatasets(); break;
    case 'export:log': await exportLog(); break;
    case 'results:clear': openResetDialog('results'); break;
    case 'field:remove-last': if(state.project.fields.length) removeFieldAt(state.project.fields.length-1); break;
    case 'view:browser': switchWorkspaceView('browserView'); break;
    case 'view:data': switchWorkspaceView('dataView'); break;
    case 'view:flow': switchWorkspaceView('flowView'); break;
    case 'view:history': switchWorkspaceView('historyView'); break;
    case 'view:process-details': openProcessDetails(state.activeView === 'flowView' ? 'flowView' : 'dataView'); break;
    case 'panel:toggle-left': toggleWorkspacePanel('left'); break;
    case 'panel:toggle-right': break; // right sidebar removed
    case 'panel:show-all':
      document.body.classList.remove('left-panel-collapsed','right-panel-collapsed');
      $('toggleLeftPanelBtn')?.setAttribute('aria-pressed','true');
      $('toggleRightPanelBtn')?.setAttribute('aria-pressed','true');
      try { localStorage.setItem('petikdata.layout.leftPanel','open'); localStorage.setItem('petikdata.layout.rightPanel','open'); } catch {}
      setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch {} }, 40);
      break;
    case 'appearance:theme': state.appearance.theme=['light','dark','system'].includes(payload)?payload:'system';safeStorageSet('crawlloom.theme',state.appearance.theme);applyAppearance();break;
    case 'theme:light': state.appearance.theme='light';safeStorageSet('crawlloom.theme','light');applyAppearance();break;
    case 'theme:dark': state.appearance.theme='dark';safeStorageSet('crawlloom.theme','dark');applyAppearance();break;
    case 'theme:system': state.appearance.theme='system';safeStorageSet('crawlloom.theme','system');applyAppearance();break;
    case 'appearance:scale-step': stepUiScale(Number(payload)>=0?1:-1); break;
    case 'ui:scale-up': stepUiScale(1); break;
    case 'ui:scale-down': stepUiScale(-1); break;
    case 'appearance:open': openAppearanceDialog(); break;
    case 'ui:appearance': openAppearanceDialog(); break;
    case 'run:preview': await previewCurrentPage(); break;
    case 'run:wizard': await startAcquisition(); break;
    case 'run:start': await startAcquisition(); break;
    case 'run:pause': await pauseRun(); break;
    case 'run:cancel': await appApi.cancelRun(); setStatus('Permintaan berhenti dikirim.'); break;
    case 'run:history': switchWorkspaceView('historyView'); break;
    case 'acquisition:method': {
      const method=['dom','network-json'].includes(payload)?payload:'network-json';
      state.project.acquisition=state.project.acquisition||{}; state.project.acquisition.method=method;
      if (method === 'network-json' && !['traveloka','tiket','agoda','trip','booking'].includes(state.project.siteProfile)) state.project.siteProfile = 'auto';
      else if (method === 'dom' && !['tiket','agoda','trip'].includes(state.project.siteProfile)) state.project.siteProfile = 'auto';
      if ($('acquisitionMethod')) $('acquisitionMethod').value=method;
      syncLegacyModeFromAcquisition(); renderSiteProfile(); renderAcquisition(); scheduleAutosave(); renderFlowCanvas();
      setStatus(`Metode pengambilan: ${method==='dom'?'Halaman Web / DOM':'HAR / Network'}.`);
      break;
    }
    case 'acquisition:scope': {
      const scope=['current','multiple','all','site-crawl'].includes(payload)?payload:'current';
      state.project.acquisition=state.project.acquisition||{}; state.project.acquisition.scope=scope;
      if ($('acquisitionScope')) $('acquisitionScope').value=scope;
      syncLegacyModeFromAcquisition(); renderAcquisition(); scheduleAutosave(); renderFlowCanvas();
      setStatus(`Cakupan pengambilan diperbarui.`);
      break;
    }
    case 'data:table-mode':
      await setDataColumnMode(payload==='full'?'full':'compact');
      break;
    case 'data:dataset-view':
      await setDataDatasetMode(payload);
      break;
    case 'data:duplicates-list':
      await setDataDatasetMode('duplicates'); setDuplicateViewMode('list');
      break;
    case 'data:duplicates-map':
      await setDataDatasetMode('duplicates'); setDuplicateViewMode('map');
      break;
    case 'field:add': await startPick('field'); break;
    case 'container:manual':
    case 'structure:manual': await startPick('item'); break;
    case 'pagination:pick':
    case 'navigation:pick': await startPick('pagination'); break;
    case 'tools:validate': await previewCurrentPage(); switchWorkspaceView('dataView'); break;
    case 'flow:technical': switchWorkspaceView('flowView');$('flowDetailBtn').dataset.on='true';state.flowController?.setTechnical(true);break;
    case 'help:system-flow':
    case 'help:flow': openFlowGuide(); break;
    case 'help:about': await openAboutDialog(); break;
    case 'help:guide': openUsageGuide(); break;
    case 'help:flow-guide': openFlowGuide(); break;
    default: break;
  }
}

function setStatus(message) { const box=$('statusBox'); if(!box) return; const text=String(message||'').trim(); box.textContent=text; box.classList.toggle('hidden', !text || text==='Siap.'); }
function escapeHtml(str) { return String(str ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function formatDate(value) { try { return new Date(value).toLocaleString('id-ID'); } catch { return String(value || ''); } }
