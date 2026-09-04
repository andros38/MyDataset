const { app, BrowserWindow, ipcMain, dialog, shell, webContents, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { runProject } = require('./engine/runner');
const AcquisitionPolicy = require('./shared/acquisition-policy');
const {
  RunStore,
  scanRuns,
  abandonRecoverableRuns,
  resolveRunHistoryDirectory,
  deleteRunHistoryEntry,
  clearRunHistory,
  slugify,
  projectDirectoryName
} = require('./core/run-store');
const { workspacePaths, autosaveProject, loadAutosave, clearAutosave, recordRecent, listRecent, writeProject } = require('./core/project-store');
const {
  managedResultsRoot,
  managedResultDirectory,
  ensureManagedRunResults,
  deleteManagedRunResults,
  clearManagedHistoryResults,
  directoryHasFiles
} = require('./core/result-store');
const { toCsv } = require('./core/csv');
const { sanitizeExportRows } = require('./core/normalizers');
const { safeFileName, buildExportBaseName, buildCombinedExportBaseName, formatLocalDateTime, dateOnlyLocal, timeOnlyLocal } = require('./core/export-naming');
const { canonicalizeRows, standardizeRows, applyConditionalRatingNormalization, standardColumnsForRows, CANONICAL_SCHEMA_VERSION, STANDARD_SCHEMA_VERSION, CANONICAL_REVIEW_COLUMNS, STANDARD_REVIEW_COLUMNS } = require('./core/canonical-review');
const { buildXlsx } = require('./core/xlsx');
const { resolveSourceContext, isHttpSourceUrl, sourceUrlMatchesSite } = require('./core/source-context');
const { REVIEW_CAPTURE_SCRIPT } = require('./core/review-capture-script');
const { createCombinedDataset, listCombinedDatasets, readCombinedDataset, resolveCombinedDatasetDirectory, deleteCombinedDataset, clearCombinedDatasets } = require('./core/combined-dataset');
const {
  internalPath,
  ensureInternalWorkspace,
  hideLegacyTechnicalRoots
} = require('./core/workspace-layout');
const { inspectNetworkFiles, copySourceFiles, finalDatasetMetadata } = require('./core/network-import');
const {
  BROWSER_PARTITION,
  configurePersistentBrowserSession
} = require('./core/browser-profile');
const {
  launchGoogleChrome,
  chromeProfileInfo
} = require('./core/system-browser');

app.setName?.('MyDataset');
// MyDataset does not expose a LAN server. Disable Chromium's media-router and
// DIAL discovery so the portable build does not unnecessarily request inbound
// Windows Firewall access from its temporary extraction directory.
app.commandLine?.appendSwitch('disable-features', 'MediaRouter,DialMediaRouteProvider');

let mainWindow;
let workspaceDir;
let activeRun = null;
let lastExportTarget = null;
let lastExportRunDir = null;
let browserProfile = null;
const stagedNetworkImports = new Map();

function isTrustedBrowserNavigation(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function isTransientBlankNavigation(url) {
  return String(url || '').trim().toLowerCase() === 'about:blank';
}

function forwardBrowserTabRequest(url, details = {}) {
  if (!isTrustedBrowserNavigation(url)) return false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:new-tab-request', {
      url: String(url),
      frameName: String(details?.frameName || ''),
      disposition: String(details?.disposition || '')
    });
    return true;
  }
  shell.openExternal(String(url));
  return true;
}

function monitorTransientPopup(childWindow, initialDetails = {}) {
  if (!childWindow || childWindow.isDestroyed?.()) return;
  const contents = childWindow.webContents;
  if (!contents || contents.isDestroyed?.()) return;
  let completed = false;
  let timeout = null;

  const closeSoon = () => {
    if (timeout) clearTimeout(timeout);
    setImmediate(() => {
      try { if (!childWindow.isDestroyed()) childWindow.close(); } catch {}
    });
  };
  const finishWith = url => {
    if (completed || !isTrustedBrowserNavigation(url)) return false;
    completed = true;
    forwardBrowserTabRequest(url, initialDetails);
    closeSoon();
    return true;
  };
  const rejectUnsafe = url => {
    const value = String(url || '').trim();
    if (!value || isTransientBlankNavigation(value) || isTrustedBrowserNavigation(value)) return false;
    // A transient popup is allowed to exist only long enough to resolve to HTTP(S).
    // file:, javascript:, data: and custom schemes never leave this hidden window.
    completed = true;
    closeSoon();
    return true;
  };

  contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame === false) return;
    if (!finishWith(url)) rejectUnsafe(url);
  });
  contents.on('will-navigate', (event, url) => {
    if (finishWith(url) || rejectUnsafe(url)) event.preventDefault?.();
  });
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame === false) return;
    if (finishWith(url) || rejectUnsafe(url)) event.preventDefault?.();
  });
  contents.on('did-navigate', (_event, url) => {
    if (!finishWith(url)) rejectUnsafe(url);
  });
  contents.on('destroyed', () => { if (timeout) clearTimeout(timeout); });

  // Never leave a blank/blocked child window resident indefinitely.
  timeout = setTimeout(() => {
    if (completed) return;
    completed = true;
    closeSoon();
  }, 15000);
}


function installReviewCaptureForGuest(guest) {
  if (!guest || guest.isDestroyed?.()) return;
  try {
    const pending = guest.executeJavaScript(REVIEW_CAPTURE_SCRIPT, true);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 920,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#101317',
    title: 'MyDataset',
    webPreferences: {
      preload: path.join(__dirname, 'main-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      // The live scraper may keep working while the user inspects hasil or Alur Proses.
      // Chromium's default throttling can otherwise suspend the host/guest timers.
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.on?.('will-attach-webview', (_event, webPreferences, params) => {
    params.partition = BROWSER_PARTITION;
    if (browserProfile?.userAgent) params.userAgent = browserProfile.userAgent;
    webPreferences.backgroundThrottling = false;
    webPreferences.javascript = true;
    webPreferences.images = true;
    webPreferences.webSecurity = true;
  });

  mainWindow.webContents.on?.('did-attach-webview', (_event, guest) => {
    try {
      if (browserProfile?.userAgent) guest.setUserAgent(browserProfile.userAgent);
      guest.setBackgroundThrottling(false);
      // Install from the main process as well as the webview preload. This is the
      // reliable path for CSP-heavy sites such as Tiket.com because
      // webContents.executeJavaScript runs in the page's main world.
      const installReviewCapture = () => installReviewCaptureForGuest(guest);
      installReviewCapture();
      guest.on?.('dom-ready', installReviewCapture);
      guest.setWindowOpenHandler(details => {
        const url = String(details?.url || '').trim();
        if (isTrustedBrowserNavigation(url)) {
          forwardBrowserTabRequest(url, details);
          return { action: 'deny' };
        }
        if (isTransientBlankNavigation(url)) {
          // Agoda and several SPA sites open about:blank synchronously, keep the
          // Window reference, then assign popup.location to the real detail URL.
          // Keep that interim window hidden and sandboxed while the final URL is
          // observed; only HTTP(S) is forwarded back into a MyDataset tab.
          return {
            action: 'allow',
            outlivesOpener: false,
            overrideBrowserWindowOptions: {
              show: false,
              webPreferences: {
                partition: BROWSER_PARTITION,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                webSecurity: true
              }
            }
          };
        }
        // Explicitly reject file:, javascript:, data: and any unknown scheme.
        return { action: 'deny' };
      });
      guest.on?.('did-create-window', (childWindow, details) => {
        const initialUrl = String(details?.url || '').trim();
        if (isTransientBlankNavigation(initialUrl)) monitorTransientPopup(childWindow, details);
        else if (isTrustedBrowserNavigation(initialUrl)) {
          forwardBrowserTabRequest(initialUrl, details);
          try { childWindow.close(); } catch {}
        } else {
          try { childWindow.close(); } catch {}
        }
      });
    } catch (error) {
      console.warn('Profil browser tertanam tidak dapat diterapkan:', error.message);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
}



function prepareWorkspace() {
  const docs = app.getPath('documents');
  const next = path.join(docs, 'MyDataset');
  const petikDataRoot = path.join(docs, 'PetikData');
  const olderRoots = [path.join(docs, 'CrawlLoom Studio'), path.join(docs, 'CrawlStudio')];

  try {
    // v0.65 rename migration: move the complete PetikData workspace when
    // MyDataset does not exist yet, preserving Projects, Runs, Imports, history,
    // and managed result folders without duplicating user data.
    if (!fs.existsSync(next) && fs.existsSync(petikDataRoot)) {
      try {
        fs.renameSync(petikDataRoot, next);
      } catch {
        fs.cpSync(petikDataRoot, next, { recursive: true, errorOnExist: false });
      }
    }

    fs.mkdirSync(next, { recursive: true });

    // If both roots exist (for example after a previous interrupted migration),
    // copy only missing workspace structures. Never overwrite the MyDataset copy.
    for (const legacy of [petikDataRoot, ...olderRoots]) {
      if (!fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(next)) continue;
      for (const name of ['Autosave', 'Backups', 'Runs', 'Projects', 'Imports', 'Exports', 'Hasil']) {
        const from = path.join(legacy, name);
        const to = path.join(next, name);
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
      }
      const recent = path.join(legacy, 'recent-projects.json');
      const recentTarget = path.join(next, 'recent-projects.json');
      if (fs.existsSync(recent) && !fs.existsSync(recentTarget)) fs.copyFileSync(recent, recentTarget);

      // v0.64 placed result folders directly under PetikData by date. Copy those
      // legacy date folders only when the matching target is not already present.
      for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        const from = path.join(legacy, entry.name);
        const to = path.join(next, entry.name);
        if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
      }
    }
  } catch (error) {
    console.warn('Migrasi workspace lama dilewati:', error.message);
  }

  ensureInternalWorkspace(next);
  fs.mkdirSync(path.join(next, 'Dataset'), { recursive: true });
  fs.mkdirSync(path.join(next, 'Dataset Gabungan'), { recursive: true });
  // Pindahkan file pemulihan kecil ke penyimpanan internal tanpa menyentuh run
  // lama. Riwayat run v0.98 dan sebelumnya tetap dibaca dari lokasi legacy.
  try {
    const oldRecent = path.join(next, 'recent-projects.json');
    const newRecent = internalPath(next, 'recent-projects.json');
    if (fs.existsSync(oldRecent) && !fs.existsSync(newRecent)) fs.copyFileSync(oldRecent, newRecent);
    const oldAutosave = path.join(next, 'Autosave', 'current-project.json');
    const newAutosave = internalPath(next, 'Autosave', 'current-project.json');
    if (fs.existsSync(oldAutosave) && !fs.existsSync(newAutosave)) fs.copyFileSync(oldAutosave, newAutosave);
  } catch {}
  // Struktur teknis versi lama tetap dibaca untuk kompatibilitas, tetapi tidak
  // ditonjolkan di Explorer. Run baru disimpan di .mydataset (hidden di Windows).
  hideLegacyTechnicalRoots(next);

  // Hasil v0.65 berada langsung di root MyDataset sebagai
  // <judul>_<YYYY-MM-DD>_<HH-MM-SS>. Kerangka Hasil/Exports lama hanya dibuang
  // bila benar-benar kosong; isi lama tetap aman sampai run terkait dimigrasikan.
  try {
    for (const legacyName of ['Hasil', 'Exports']) {
      const legacyRoot = path.join(next, legacyName);
      if (fs.existsSync(legacyRoot) && !directoryHasFiles(legacyRoot)) fs.rmSync(legacyRoot, { recursive: true, force: true });
    }
    const projectsRoot = path.join(next, 'Projects');
    if (fs.existsSync(projectsRoot)) {
      for (const projectName of fs.readdirSync(projectsRoot)) {
        const legacyProjectExports = path.join(projectsRoot, projectName, 'Exports');
        if (fs.existsSync(legacyProjectExports) && !directoryHasFiles(legacyProjectExports)) fs.rmSync(legacyProjectExports, { recursive: true, force: true });
      }
    }
  } catch {}
  return next;
}

function sendMenuCommand(command, payload = null) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:command', command, payload);
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isActiveRunDirectory(runDir) {
  const activeDir = activeRun?.runStore?.runDir;
  return Boolean(activeDir && normalizedPath(activeDir) === normalizedPath(runDir));
}

const DATASET_FILES = Object.freeze({
  clean: 'data.jsonl',
  raw: 'raw-data.jsonl',
  duplicates: 'duplicates-data.jsonl'
});

function normalizeDataset(value) {
  return Object.prototype.hasOwnProperty.call(DATASET_FILES, value) ? value : 'clean';
}

function runDatasetPath(runDir, dataset = 'clean') {
  return path.join(runDir, DATASET_FILES[normalizeDataset(dataset)]);
}

function datasetLabel(dataset) {
  return { clean: 'clean', raw: 'raw', duplicates: 'duplicates' }[normalizeDataset(dataset)];
}

function runExportRoot(runDir) {
  return managedResultDirectory(workspaceDir, runDir);
}

function runOutputDirectory(runDir, dataset = 'clean') {
  const managed = ensureManagedRunResults(workspaceDir, runDir);
  const selected = normalizeDataset(dataset);
  if (selected === 'raw') return managed.rawDir;
  if (selected === 'duplicates') return managed.auditDir;
  return managed.dataDir;
}

function runLogDirectory(runDir) {
  return ensureManagedRunResults(workspaceDir, runDir).directory;
}

function rememberExport(target, runDir = null) {
  lastExportTarget = target ? path.resolve(target) : null;
  lastExportRunDir = runDir ? path.resolve(runDir) : null;
}

function writeExportFile(filePath, format, rows, metadata = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (format === 'xlsx') {
    const headers = Array.isArray(metadata.headers)
      ? metadata.headers
      : (metadata.schema === STANDARD_SCHEMA_VERSION ? STANDARD_REVIEW_COLUMNS : metadata.schema === CANONICAL_SCHEMA_VERSION ? CANONICAL_REVIEW_COLUMNS : undefined);
    fs.writeFileSync(filePath, buildXlsx(rows, { headers }));
    return;
  }
  const content = format === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows);
  fs.writeFileSync(filePath, content, 'utf8');
}

function readRunState(runDir) {
  const statePath = path.join(runDir, 'state.json');
  if (!fs.existsSync(statePath)) return null;
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; }
}

function readRunProject(runDir) {
  if (!runDir) return null;
  const snapshotPath = path.join(runDir, 'project.snapshot.json');
  if (!fs.existsSync(snapshotPath)) return null;
  try { return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch { return null; }
}


function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Berkas',
      submenu: [
        { label: 'Proyek Baru', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('project:new') },
        { label: 'Buka Proyek…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('project:open') },
        { label: 'Simpan Proyek', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand('project:save') },
        { label: 'Simpan Proyek Sebagai…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuCommand('project:save-as') },
        { type: 'separator' },
        {
          label: 'Impor Sumber Data',
          submenu: [
            { label: 'HAR / Network…', accelerator: 'CmdOrCtrl+Shift+H', click: () => sendMenuCommand('acquisition:open-har') }
          ]
        },
        {
          label: 'Ekspor Dataset Aktif',
          submenu: [
            { label: 'Data Siap Analisis (CSV)…', click: () => sendMenuCommand('export:clean-csv') },
            { label: 'Data Siap Analisis (Excel .xlsx)…', click: () => sendMenuCommand('export:clean-xlsx') },
            { label: 'Data Siap Analisis — Teks (CSV)…', click: () => sendMenuCommand('export:text-csv') },
            { type: 'separator' },
            { label: 'Data Asli (CSV)…', click: () => sendMenuCommand('export:raw-csv') },
            { label: 'Audit Duplikat (CSV)…', click: () => sendMenuCommand('export:duplicates-csv') },
            { type: 'separator' },
            { label: 'Paket Lengkap…', click: () => sendMenuCommand('export:bundle') }
          ]
        },
        { type: 'separator' },
        { label: 'Buka Folder Dataset Aktif', click: () => sendMenuCommand('folder:results') },
        { label: 'Buka Folder Utama MyDataset', click: () => shell.openPath(workspaceDir) },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Keluar' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Urungkan' },
        { role: 'redo', label: 'Ulangi' },
        { type: 'separator' },
        { role: 'cut', label: 'Potong' },
        { role: 'copy', label: 'Salin' },
        { role: 'paste', label: 'Tempel' },
        { role: 'selectAll', label: 'Pilih Semua' }
      ]
    },
    {
      label: 'Tampilan',
      submenu: [
        {
          label: 'Tema',
          submenu: [
            { label: 'Terang', click: () => sendMenuCommand('appearance:theme', 'light') },
            { label: 'Gelap', click: () => sendMenuCommand('appearance:theme', 'dark') },
            { label: 'Ikuti Sistem', click: () => sendMenuCommand('appearance:theme', 'system') }
          ]
        },
        { type: 'separator' },
        { label: 'Mengatur Data', accelerator: 'CmdOrCtrl+1', click: () => sendMenuCommand('view:browser') },
        { label: 'Lihat Hasil', accelerator: 'CmdOrCtrl+2', click: () => sendMenuCommand('view:data') },
        { label: 'Riwayat', accelerator: 'CmdOrCtrl+3', click: () => sendMenuCommand('view:history') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Layar Penuh', accelerator: 'F11' }
      ]
    },
    {
      label: 'Bantuan',
      submenu: [
        { label: 'Panduan Penggunaan', click: () => sendMenuCommand('help:guide') },
        { label: 'Cara Kerja Sistem', click: () => sendMenuCommand('help:flow-guide') },
        { type: 'separator' },
        { label: 'Tentang MyDataset', click: () => sendMenuCommand('help:about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  browserProfile = configurePersistentBrowserSession(session);
  workspaceDir = prepareWorkspace();
  workspacePaths(workspaceDir);
  createWindow();
  buildApplicationMenu();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (activeRun?.control) activeRun.control.pauseRequested = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:get-paths', () => ({
  webviewPreload: path.join(__dirname, 'webview-preload.js'),
  workspaceDir
}));

ipcMain.handle('app:get-info', () => ({ name: 'MyDataset', version: app.getVersion(), author: 'Ahmad Asyhari', description: 'Kumpulin dan rapikan data web untuk dataset-mu.' }));

ipcMain.handle('browser:set-background-throttling', (event, guestWebContentsId, allowed = false) => {
  let target = null;
  try { target = webContents.fromId(Number(guestWebContentsId)); } catch {}
  if (!target || target.isDestroyed?.()) return { ok: false, error: 'Tab browser belum siap.' };
  const host = target.hostWebContents;
  if (host && host.id !== event.sender.id) return { ok: false, error: 'Tab browser bukan milik jendela aktif.' };
  target.setBackgroundThrottling(Boolean(allowed));
  return { ok: true, throttlingAllowed: Boolean(allowed) };
});

ipcMain.handle('browser:refresh-surface', async (event, guestWebContentsId) => {
  let target = null;
  try { target = webContents.fromId(Number(guestWebContentsId)); } catch {}
  if (!target || target.isDestroyed?.()) return { ok:false, error:'Tab browser belum siap.' };
  const host = target.hostWebContents;
  if (host && host.id !== event.sender.id) return { ok:false, error:'Tab browser bukan milik jendela aktif.' };
  try { target.setBackgroundThrottling(false); } catch {}
  try { if (typeof target.invalidate === 'function') target.invalidate(); } catch {}
  try {
    await target.executeJavaScript(`(() => { try { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('scroll')); requestAnimationFrame(()=>document.documentElement?.getBoundingClientRect()); } catch {} return true; })()`, true);
  } catch {}
  try { if (typeof target.invalidate === 'function') target.invalidate(); } catch {}
  return { ok:true, url:target.getURL?.() || '' };
});

ipcMain.handle('browser:capture-preview', async (event, guestWebContentsId, options = {}) => {
  let target = null;
  try { target = webContents.fromId(Number(guestWebContentsId)); } catch {}
  if (!target || target.isDestroyed?.()) return { ok:false, error:'Tab browser belum siap.' };
  const host = target.hostWebContents;
  if (host && host.id !== event.sender.id) return { ok:false, error:'Tab browser bukan milik jendela aktif.' };
  const width = Math.max(160, Math.min(640, Number(options.width || 360)));
  const height = Math.max(90, Math.min(360, Number(options.height || 203)));
  try {
    const image = await target.capturePage();
    if (!image || image.isEmpty?.()) return { ok:false, error:'Preview browser belum tersedia.' };
    const resized = image.resize({ width: Math.round(width), height: Math.round(height) });
    return { ok:true, dataUrl: resized.toDataURL(), url: target.getURL?.() || '' };
  } catch (error) {
    return { ok:false, error:String(error?.message || error || 'Preview browser gagal.') };
  }
});

ipcMain.handle('browser:open-external', async (_event, value) => {
  let target;
  try { target = new URL(String(value || '')); } catch { throw new Error('URL browser sistem tidak valid.'); }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Hanya URL HTTP/HTTPS yang dapat dibuka.');
  await shell.openExternal(target.toString());
  return { ok: true, url: target.toString() };
});

ipcMain.handle('browser:open-chrome', async (_event, value) => {
  let target;
  try { target = new URL(String(value || '')); } catch { throw new Error('URL Google Chrome tidak valid.'); }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Hanya URL HTTP/HTTPS yang dapat dibuka di Google Chrome.');
  return launchGoogleChrome({ url: target.toString(), workspaceDir });
});

function networkImportSiteProfile(project = {}) {
  const migrated = AcquisitionPolicy.migrateProject(project || {}).project;
  const selected = AcquisitionPolicy.normalizedSite(migrated.siteProfile, { url: migrated.startUrl || migrated.source?.sourceUrl || '' });
  if (selected && !['traveloka','tiket','agoda','trip','booking'].includes(selected)) throw new Error('HAR / Network mendukung Traveloka, Tiket, Agoda, Trip, dan Booking.');
  return selected || 'auto';
}

function safeNetworkSourceUrl(payload = {}, requestedProject = {}) {
  const requestedUrl = String(payload.sourceUrl || requestedProject?.source?.sourceUrl || requestedProject.startUrl || '').trim();
  const profile = networkImportSiteProfile(requestedProject);
  return isHttpSourceUrl(requestedUrl) && sourceUrlMatchesSite(requestedUrl, profile) ? requestedUrl : '';
}

function inspectNetworkSelection(filePaths, payload = {}) {
  const requestedProject = payload.project && typeof payload.project === 'object' ? payload.project : {};
  const profile = networkImportSiteProfile(requestedProject);
  const inspectionProject = { ...requestedProject, siteProfile: profile };
  const safeRequestedUrl = safeNetworkSourceUrl(payload, requestedProject);
  const importInfo = inspectNetworkFiles(filePaths, { project: inspectionProject, sourceUrl: safeRequestedUrl, sourceSelection: payload.sourceSelection || '', allowSourceUrlOverride: payload.allowSourceUrlOverride === true });
  return { requestedProject, safeRequestedUrl, importInfo };
}

function publicNetworkStage(stageId, importInfo) {
  return {
    canceled: false,
    stageId,
    adapter: importInfo.adapter,
    sourceType: importInfo.sourceType || 'json',
    files: importInfo.files.map(item => ({
      name: item.name,
      size: item.size,
      modifiedAt: item.modifiedAt,
      responses: item.responses,
      reviews: item.reviews,
      sha256: item.sha256,
      sourceFormat: item.sourceFormat || ''
    })),
    responseCount: importInfo.responseCount,
    rawResponseOccurrences: Number(importInfo.rawResponseOccurrences ?? importInfo.responseCount ?? 0),
    totalReviews: importInfo.totalReviews,
    uniqueSourceReviews: Number(importInfo.uniqueSourceReviews ?? importInfo.totalReviews ?? 0),
    textReviewCount: Number(importInfo.textReviewCount || 0),
    emptyTextReviewCount: Number(importInfo.emptyTextReviewCount || 0),
    sourceDuplicateReviewIds: Number(importInfo.sourceDuplicateReviewIds || 0),
    lastHasNext: importInfo.lastHasNext,
    sourceContext: importInfo.sourceContext || {},
    sourceCandidates: Array.isArray(importInfo.sourceCandidates) ? importInfo.sourceCandidates : [],
    selectedSourceId: String(importInfo.selectedSourceId || ''),
    captureMetadata: importInfo.captureMetadata || null,
    datasetMetadata: importInfo.datasetMetadata || importInfo.captureMetadata?.datasetMetadata || null,
    importedAt: importInfo.importedAt
  };
}

async function pickNetworkFiles() {
  return dialog.showOpenDialog(mainWindow, {
    title: 'Pilih HAR / Network',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'HAR Chrome', extensions: ['har'] }]
  });
}

async function processNetworkFiles(filePaths, payload = {}) {
  if (activeRun) throw new Error('Masih ada run aktif. Jeda atau tunggu hingga selesai sebelum memproses HAR/Network.');
  const { requestedProject, safeRequestedUrl, importInfo } = inspectNetworkSelection(filePaths, payload);
  const sourceContext = importInfo.sourceContext || {};
  const requestedIdentity = String(requestedProject.reviewSubject || requestedProject.name || '').trim();
  const requestedIsGeneric = /^(?:proyek baru|new project|proyek|project|impor xhr json|impor har)$/i.test(requestedIdentity);
  const detectedIdentity = String(sourceContext.objectName || '').trim();
  const identity = String((!requestedIsGeneric ? requestedIdentity : '') || detectedIdentity || 'Impor HAR Network').trim() || 'Impor HAR Network';
  const project = {
    ...requestedProject,
    version: Math.max(22, Number(requestedProject.version || 0)),
    name: identity,
    reviewSubject: identity,
    dataTarget: requestedProject.dataTarget || 'reviews',
    siteProfile: importInfo.platform || AcquisitionPolicy.normalizedSite('', { url: sourceContext.sourceUrl || safeRequestedUrl || '' }) || 'traveloka',
    acquisition: { ...(requestedProject.acquisition || {}), method: importInfo.sourceType === 'har' ? 'har-network' : 'network-json', scope: 'all' },
    mode: 'quick',
    startUrl: sourceContext.sourceUrl || safeRequestedUrl || '',
    source: {
      ...(requestedProject.source || {}),
      objectName: identity,
      sourceObjectName: String(sourceContext.objectName || identity),
      siteName: sourceContext.siteName || AcquisitionPolicy.labelForSite(importInfo.platform || '') || 'Sumber',
      sourceUrl: sourceContext.sourceUrl || safeRequestedUrl || '',
      canonicalUrl: sourceContext.canonicalUrl || sourceContext.sourceUrl || safeRequestedUrl || '',
      actualUrl: sourceContext.sourceUrl || safeRequestedUrl || '',
      objectId: String(sourceContext.objectId || ''),
      entityType: String(sourceContext.entityType || ''),
      detectedBy: sourceContext.detectedBy || (importInfo.sourceType === 'har' ? 'har-network' : (sourceContext.objectName ? 'network-import+url' : 'network-import')),
      importedNetworkData: true,
      importSourceType: importInfo.sourceType || 'json'
    },
    pagination: { ...(requestedProject.pagination || {}), type: 'none', maxPages: Math.max(1, importInfo.responseCount || 1) }
  };

  const runStore = new RunStore({ workspaceDir, project });
  const control = { pauseRequested: false, cancelRequested: false };
  activeRun = { runStore, control, project, mode: 'network-json-import' };
  const logs = [];
  const log = message => {
    const line = String(message || '').trim();
    if (!line) return;
    logs.push(line);
    runStore.appendLog(line);
  };

  try {
    runStore.markRunning('Memproses sumber HAR/Network yang sudah dipilih.');
    sendRunProgress({ stage: 'starting', message: 'Menyiapkan sesi dan provenance sumber…', page: 1, runDir: runStore.runDir, itemsCollected: 0, rawItemsRead: 0 });
    sendRunProgress({ stage: 'loading', message: `Membaca ${importInfo.files.length} file HAR dan endpoint review…`, page: 1, runDir: runStore.runDir, itemsCollected: 0, rawItemsRead: 0 });
    const storedFiles = copySourceFiles(runStore.runDir, importInfo.files);
    sendRunProgress({ stage: 'extracting', message: `Mengekstrak ${importInfo.totalReviews} record sumber dari response review…`, page: 1, runDir: runStore.runDir, itemsCollected: 0, rawItemsRead: 0 });
    log(`Mode input: ${importInfo.sourceType === 'har' ? 'HAR Chrome' : 'JSON Network'} · adapter ${importInfo.adapter}.`);
    log(`Sumber: ${storedFiles.length} file · ${importInfo.responseCount} response · ${importInfo.totalReviews} record mentah · ${Number(importInfo.canonicalSourceReviews ?? importInfo.uniqueSourceReviews ?? importInfo.rows.length)} kandidat canonical · ${Number(importInfo.textReviewCount || 0)} dengan teks · ${Number(importInfo.emptyTextReviewCount || 0)} tanpa teks.`);
    sendRunProgress({ stage: 'normalizing', message: 'Memvalidasi pagination, provenance, dan field review sebelum pemeriksaan duplikat…', page: importInfo.responseCount || 1, runDir: runStore.runDir, itemsCollected: 0, rawItemsRead: 0, duplicatesSkipped: 0, possibleDuplicates: 0 });

    const rawInputRows = Array.isArray(importInfo.rawRows) ? importInfo.rawRows : importInfo.rows;
    for (let index = 0; index < rawInputRows.length; index += 1) {
      if (control.cancelRequested) throw new Error('Impor dibatalkan.');
      const base = rawInputRows[index] || {};
      runStore.appendRawRow({
        ...base,
        _sessionId: runStore.state.sessionId,
        _runId: runStore.state.runId,
        _acquisitionMethod: importInfo.sourceType === 'har' ? 'har-network' : 'network-json',
        _acquisitionSource: importInfo.sourceType || 'json'
      });
    }

    for (let index = 0; index < importInfo.rows.length; index += 1) {
      if (control.cancelRequested) throw new Error('Impor dibatalkan.');
      const base = importInfo.rows[index] || {};
      const enriched = {
        ...base,
        _sessionId: runStore.state.sessionId,
        _runId: runStore.state.runId,
        _acquisitionMethod: importInfo.sourceType === 'har' ? 'har-network' : 'network-json',
        _acquisitionSource: importInfo.sourceType || 'json'
      };
      // Data Mentah sudah disimpan di atas. Jalur cleaning/canonical hanya menerima
      // record yang diizinkan adapter (mis. Agoda native; partner tetap di provenance).
      runStore.appendRow(enriched, { recordRaw: false });
      if ((index + 1) % 250 === 0 || index === importInfo.rows.length - 1) {
        sendRunProgress({
          stage: 'deduplicating',
          message: `Memproses ${index + 1}/${importInfo.rows.length} review canonical dari response Network…`,
          page: enriched?._page || 1,
          runDir: runStore.runDir,
          itemsCollected: runStore.state.itemsCollected,
          rawItemsRead: runStore.state.rawItemsRead,
          duplicatesSkipped: runStore.state.exactDuplicates,
          possibleDuplicates: runStore.state.possibleDuplicates
        });
      }
    }

    const datasetMetadata = finalDatasetMetadata(importInfo, {
      entity: project.reviewSubject || project.source?.objectName || sourceContext.objectName || '',
      sourceUrl: project.source?.sourceUrl || project.startUrl || '',
      rawRecords: runStore.state.rawItemsRead,
      sourceUniqueRecords: Number(importInfo.uniqueSourceReviews ?? importInfo.totalReviews ?? runStore.state.rawItemsRead),
      cleanRecords: runStore.state.itemsCollected,
      exactDuplicates: runStore.state.exactDuplicates,
      possibleDuplicates: runStore.state.possibleDuplicates
    });
    fs.writeFileSync(path.join(runStore.runDir, 'dataset-metadata.json'), JSON.stringify(datasetMetadata, null, 2), 'utf8');

    const manifest = {
      schemaVersion: 3,
      canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
      standardSchemaVersion: STANDARD_SCHEMA_VERSION,
      applicationVersion: app.getVersion(),
      importType: importInfo.sourceType === 'har' ? 'har-network' : 'network-response',
      acquisitionMethod: importInfo.sourceType === 'har' ? 'har-network' : 'network-json',
      acquisitionSource: importInfo.sourceType === 'har' ? 'har' : (importInfo.sourceType || 'json'),
      siteProfile: project.siteProfile,
      adapter: importInfo.adapter,
      importedAt: importInfo.importedAt,
      source: project.source,
      files: storedFiles.map(({ path: _path, ...item }) => item),
      responseCount: importInfo.responseCount,
      rawReviews: importInfo.totalReviews,
      sourceUniqueReviews: Number(importInfo.uniqueSourceReviews ?? importInfo.totalReviews ?? 0),
      textReviews: Number(importInfo.textReviewCount || 0),
      emptyTextReviews: Number(importInfo.emptyTextReviewCount || 0),
      sourceDuplicateReviewIds: Number(importInfo.sourceDuplicateReviewIds || 0),
      cleanReviews: runStore.state.itemsCollected,
      exactDuplicates: runStore.state.exactDuplicates,
      possibleDuplicates: runStore.state.possibleDuplicates,
      lastHasNext: importInfo.lastHasNext,
      paginationComplete: datasetMetadata?.pagination?.complete === true,
      captureComplete: datasetMetadata?.pagination?.complete === true,
      collectionMayBeIncomplete: datasetMetadata?.pagination?.complete === false || importInfo.lastHasNext === true,
      datasetMetadataFile: 'dataset-metadata.json',
      datasetMetadata
    };
    fs.writeFileSync(path.join(runStore.runDir, 'network-import-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    sendRunProgress({ stage: 'checkpoint', message: 'Menyimpan dataset, metadata, dan audit ke folder hasil…', page: importInfo.responseCount || 1, runDir: runStore.runDir, itemsCollected: runStore.state.itemsCollected, rawItemsRead: runStore.state.rawItemsRead, duplicatesSkipped: runStore.state.exactDuplicates, possibleDuplicates: runStore.state.possibleDuplicates });
    const cleanRowsForCounts = runStore.readRows();
    const cleanTextCount = cleanRowsForCounts.reduce((count,row)=>count+(String(row?.review_text||'').trim()?1:0),0);
    runStore.checkpoint({
      currentPage: Math.max(1, importInfo.responseCount || 1),
      pageCompleted: true,
      currentUrl: project.startUrl || '',
      sourceUrl: project.source?.sourceUrl || '',
      objectName: project.source?.objectName || '',
      siteName: project.source?.siteName || AcquisitionPolicy.labelForSite(project.siteProfile) || 'Sumber',
      ingestionMode: importInfo.sourceType === 'har' ? 'har-network' : 'network-json',
      sourceAdapter: importInfo.adapter,
      textRecords: cleanTextCount,
      withoutTextRecords: Math.max(0, cleanRowsForCounts.length - cleanTextCount)
    });
    const capturePartial = datasetMetadata?.pagination?.complete === false;
    const completenessNote = capturePartial
      ? ` Pagination ${AcquisitionPolicy.labelForSite(project.siteProfile) || 'sumber'} belum lengkap; hasil ditandai HAR parsial.`
      : '';
    log(`${capturePartial ? 'Selesai — HAR parsial' : 'Selesai'}: ${runStore.state.rawItemsRead} record sumber → ${runStore.state.itemsCollected} record hasil; ${runStore.state.exactDuplicates} duplikat pasti, ${runStore.state.possibleDuplicates} potensi duplikat.${completenessNote}`);
    if (capturePartial && typeof runStore.markCompletedPartial === 'function') runStore.markCompletedPartial(`Impor HAR/Network selesai — HAR parsial.${completenessNote}`);
    else runStore.markCompleted(`Impor HAR/Network selesai.${completenessNote}`);
    ensureManagedRunResults(workspaceDir, runStore.runDir);
    sendRunProgress({ stage: capturePartial ? 'partial' : 'done', message: capturePartial ? `Impor selesai — HAR parsial: ${runStore.state.itemsCollected} record hasil.` : `Impor HAR/Network selesai: ${runStore.state.itemsCollected} record hasil.`, page: importInfo.responseCount || 1, runDir: runStore.runDir, itemsCollected: runStore.state.itemsCollected, rawItemsRead: runStore.state.rawItemsRead, duplicatesSkipped: runStore.state.exactDuplicates, possibleDuplicates: runStore.state.possibleDuplicates });

    return {
      canceled: false,
      ok: true,
      runDir: runStore.runDir,
      rows: runStore.readRows({ limit: 300 }),
      totalRows: runStore.state.itemsCollected,
      state: { ...runStore.state },
      logs,
      source: project.source,
      projectSiteProfile: project.siteProfile,
      importSummary: {
        adapter: importInfo.adapter,
        files: storedFiles.length,
        responses: importInfo.responseCount,
        sourceType: importInfo.sourceType || 'json',
        rawReviews: importInfo.totalReviews,
        sourceUniqueReviews: Number(importInfo.uniqueSourceReviews ?? importInfo.totalReviews ?? 0),
        textReviews: Number(importInfo.textReviewCount || 0),
        emptyTextReviews: Number(importInfo.emptyTextReviewCount || 0),
        cleanReviews: runStore.state.itemsCollected,
        exactDuplicates: runStore.state.exactDuplicates,
        possibleDuplicates: runStore.state.possibleDuplicates,
        lastHasNext: importInfo.lastHasNext,
        paginationComplete: datasetMetadata?.pagination?.complete === true,
        collectionMayBeIncomplete: datasetMetadata?.pagination?.complete === false || importInfo.lastHasNext === true,
        datasetMetadata
      }
    };
  } catch (error) {
    runStore.markFailed(error);
    try { if (runStore.state.itemsCollected || runStore.state.rawItemsRead) ensureManagedRunResults(workspaceDir, runStore.runDir); } catch {}
    sendRunProgress({ stage: 'error', message: `Proses HAR/Network gagal: ${error.message}`, runDir: runStore.runDir, itemsCollected: runStore.state.itemsCollected, rawItemsRead: runStore.state.rawItemsRead, duplicatesSkipped: runStore.state.exactDuplicates, possibleDuplicates: runStore.state.possibleDuplicates });
    return {
      canceled: false, ok: false, runDir: runStore.runDir,
      rows: runStore.readRows({ limit: 300 }), totalRows: runStore.state.itemsCollected,
      state: { ...runStore.state }, logs, error: error.message,
      source: project.source, projectSiteProfile: project.siteProfile
    };
  } finally {
    activeRun = null;
  }
}

ipcMain.handle('data:stage-network-json', async (_event, payload = {}) => {
  if (activeRun) throw new Error('Masih ada run aktif. Jeda atau tunggu hingga selesai sebelum memilih HAR/Network.');
  const picked = await pickNetworkFiles();
  if (picked.canceled || !picked.filePaths.length) return { canceled: true };
  const { importInfo } = inspectNetworkSelection(picked.filePaths, payload);
  const stageId = `network_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  stagedNetworkImports.set(stageId, { filePaths: [...picked.filePaths], createdAt: Date.now() });
  // Avoid unbounded stale selections if the app is left open for a long time.
  for (const [id, value] of stagedNetworkImports) {
    if (id !== stageId && Date.now() - Number(value?.createdAt || 0) > 6 * 60 * 60 * 1000) stagedNetworkImports.delete(id);
  }
  return publicNetworkStage(stageId, importInfo);
});

ipcMain.handle('data:clear-network-json-stage', (_event, stageId = '') => {
  if (stageId) stagedNetworkImports.delete(String(stageId));
  return { ok: true };
});

ipcMain.handle('data:process-network-json', async (_event, payload = {}) => {
  const stageId = String(payload.stageId || '').trim();
  const staged = stagedNetworkImports.get(stageId);
  if (!staged?.filePaths?.length) throw new Error('Pilihan file HAR/Network sudah tidak tersedia. Pilih file kembali.');
  const result = await processNetworkFiles(staged.filePaths, payload);
  if (result?.ok || result?.canceled) stagedNetworkImports.delete(stageId);
  return result;
});

ipcMain.handle('browser:get-profile', () => {
  const chrome = chromeProfileInfo({ workspaceDir });
  return {
    partition: BROWSER_PARTITION,
    persistent: true,
    userAgent: browserProfile?.userAgent || '',
    acceptLanguages: browserProfile?.acceptLanguages || '',
    engine: 'Electron Chromium',
    chromiumVersion: process.versions.chrome || '',
    electronVersion: process.versions.electron || '',
    googleChromeInstalled: chrome.installed,
    googleChromePath: chrome.chromePath,
    chromeProfileDir: chrome.profileDir
  };
});

ipcMain.handle('url-context-menu:show', event => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const contextMenu = Menu.buildFromTemplate([
    { role: 'undo', label: 'Urungkan' },
    { role: 'redo', label: 'Ulangi' },
    { type: 'separator' },
    { role: 'cut', label: 'Potong' },
    { role: 'copy', label: 'Salin' },
    { role: 'paste', label: 'Tempel' },
    { role: 'delete', label: 'Hapus' },
    { type: 'separator' },
    { role: 'selectAll', label: 'Pilih Semua' }
  ]);
  contextMenu.popup({ window: owner });
  return { ok: true };
});

ipcMain.handle('source:identify', (_event, signals = {}) => resolveSourceContext(signals));

ipcMain.handle('project:autosave', (_event, project, projectPath) => {
  return autosaveProject(workspaceDir, project, projectPath || null);
});

ipcMain.handle('project:get-recovery', () => ({
  autosave: loadAutosave(workspaceDir),
  recent: listRecent(workspaceDir),
  runs: scanRuns(workspaceDir, { limit: 20 })
}));

ipcMain.handle('project:reset-state', (_event, payload = {}) => {
  const projectName = String(payload.projectName || '').trim();
  const abandonRecoverable = payload.abandonRecoverable !== false;
  clearAutosave(workspaceDir);
  const abandonedRuns = abandonRecoverable && projectName
    ? abandonRecoverableRuns(workspaceDir, projectName)
    : 0;
  return { ok: true, abandonedRuns };
});

ipcMain.handle('project:save', async (_event, project, currentPath = null, saveAs = false) => {
  let filePath = currentPath;
  if (!filePath || saveAs) {
    const projectDirectory = internalPath(workspaceDir, 'Projects', projectDirectoryName(project.name));
    fs.mkdirSync(projectDirectory, { recursive: true });
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Simpan Proyek MyDataset',
      defaultPath: path.join(projectDirectory, `${safeFileName(project.name || 'proyek')}.loom.json`),
      filters: [{ name: 'MyDataset Project', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    filePath = result.filePath;
  }
  writeProject(filePath, project);
  recordRecent(workspaceDir, filePath, project);
  autosaveProject(workspaceDir, project, filePath);
  return { canceled: false, filePath };
});

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Buka Proyek MyDataset',
    properties: ['openFile'],
    filters: [{ name: 'MyDataset Project', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const project = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  recordRecent(workspaceDir, filePath, project);
  autosaveProject(workspaceDir, project, filePath);
  return { canceled: false, filePath, project };
});

ipcMain.handle('project:open-recent', (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File proyek tidak ditemukan.');
  const project = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  recordRecent(workspaceDir, filePath, project);
  autosaveProject(workspaceDir, project, filePath);
  return { canceled: false, filePath, project };
});

ipcMain.handle('project:run', async (_event, project, guestWebContentsId = null) => {
  if (activeRun) throw new Error('Masih ada run aktif. Jeda atau tunggu hingga selesai.');
  const runStore = new RunStore({ workspaceDir, project });
  const control = { pauseRequested: false, cancelRequested: false };
  let targetWebContents = null;
  if (guestWebContentsId != null) {
    try { targetWebContents = webContents.fromId(Number(guestWebContentsId)); } catch {}
    if (targetWebContents?.isDestroyed?.()) targetWebContents = null;
  }
  activeRun = { runStore, control, project, mode: targetWebContents ? 'live-tab' : 'background' };
  try {
    const result = await runProject(project, sendRunProgress, {
      runStore,
      control,
      resume: false,
      targetWebContents,
      useCurrentPage: Boolean(targetWebContents)
    });
    if (runStore.state.itemsCollected || runStore.state.rawItemsRead) ensureManagedRunResults(workspaceDir, runStore.runDir);
    return result;
  } catch (error) {
    try { if (runStore.state.itemsCollected || runStore.state.rawItemsRead) ensureManagedRunResults(workspaceDir, runStore.runDir); } catch {}
    throw error;
  } finally {
    activeRun = null;
  }
});

ipcMain.handle('run:resume', async (_event, runDir, guestWebContentsId = null) => {
  if (activeRun) throw new Error('Masih ada run aktif.');
  const snapshotPath = path.join(runDir, 'project.snapshot.json');
  if (!fs.existsSync(snapshotPath)) throw new Error('Snapshot proyek untuk run ini tidak ditemukan.');
  const project = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const runStore = new RunStore({ workspaceDir, project, runDir, resume: true });
  const control = { pauseRequested: false, cancelRequested: false };
  let targetWebContents = null;
  if (guestWebContentsId != null) {
    try { targetWebContents = webContents.fromId(Number(guestWebContentsId)); } catch {}
    if (targetWebContents?.isDestroyed?.()) targetWebContents = null;
  }
  let executionProject = project;
  if (targetWebContents && /^file:\/\//i.test(String(targetWebContents.getURL?.() || ''))) {
    executionProject = {
      ...project,
      mode: 'quick',
      pagination: { ...(project.pagination || {}), type: 'none', maxPages: 1 }
    };
  }
  activeRun = { runStore, control, project: executionProject, mode: targetWebContents ? 'live-tab' : 'background' };
  try {
    const result = await runProject(executionProject, sendRunProgress, { runStore, control, resume: true, targetWebContents, useCurrentPage: Boolean(targetWebContents) });
    if (runStore.state.itemsCollected || runStore.state.rawItemsRead) ensureManagedRunResults(workspaceDir, runStore.runDir);
    return result;
  } catch (error) {
    try { if (runStore.state.itemsCollected || runStore.state.rawItemsRead) ensureManagedRunResults(workspaceDir, runStore.runDir); } catch {}
    throw error;
  } finally {
    activeRun = null;
  }
});

ipcMain.handle('run:pause', () => {
  if (!activeRun) return { ok: false, message: 'Tidak ada run aktif.' };
  activeRun.control.pauseRequested = true;
  return { ok: true, message: 'Permintaan pause dikirim. MyDataset akan berhenti pada titik aman berikutnya.' };
});

ipcMain.handle('run:cancel', () => {
  if (!activeRun) return { ok: false, message: 'Tidak ada run aktif.' };
  activeRun.control.cancelRequested = true;
  return { ok: true };
});

ipcMain.handle('run:mark-stopped', (_event, runDir = '') => {
  const target = String(runDir || '').trim();
  if (!target || !fs.existsSync(target)) return { ok:false, message:'Run tidak ditemukan.' };
  const snapshotPath = path.join(target, 'project.snapshot.json');
  if (!fs.existsSync(snapshotPath)) return { ok:false, message:'Snapshot proyek run tidak ditemukan.' };
  const project = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const runStore = new RunStore({ workspaceDir, project, runDir: target, resume: true });
  runStore.markStopped('Dihentikan pengguna setelah kegagalan. Data parsial dipertahankan.');
  return { ok:true, state:{...runStore.state} };
});

ipcMain.handle('run:list', () => scanRuns(workspaceDir, { limit: 100 }));

ipcMain.handle('combined:list', () => listCombinedDatasets(workspaceDir, { limit: 100 }));
ipcMain.handle('combined:create', (_event, payload = {}) => createCombinedDataset(workspaceDir, payload));
ipcMain.handle('combined:read', (_event, directory, limit = 300, dataset = 'clean') => readCombinedDataset(workspaceDir, directory, limit, dataset));
ipcMain.handle('combined:open', async (_event, directory) => {
  const { target } = resolveCombinedDatasetDirectory(workspaceDir, directory);
  const error = await shell.openPath(target);
  return { ok: !error, error: error || '' };
});
ipcMain.handle('combined:delete-history', async (_event, directory) => {
  const { target, manifest } = resolveCombinedDatasetDirectory(workspaceDir, directory);
  const version = path.basename(target);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Hapus Dataset Gabungan?',
    message: `Hapus “${manifest.name || 'Dataset Gabungan'}” versi ${version}?`,
    detail: 'Folder dan riwayat Dataset Gabungan versi ini akan dihapus permanen. Dataset sesi sumber tetap aman.',
    buttons: ['Batal', 'Hapus'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return { ok:false, canceled:true, deleted:0 };
  return { ok:true, ...deleteCombinedDataset(workspaceDir, target) };
});
ipcMain.handle('combined:clear-history', async () => {
  const datasets = listCombinedDatasets(workspaceDir, { limit:Number.MAX_SAFE_INTEGER });
  if (!datasets.length) return { ok:true, deleted:0 };
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Bersihkan Dataset Gabungan?',
    message: `Hapus seluruh ${datasets.length.toLocaleString('id-ID')} riwayat Dataset Gabungan?`,
    detail: 'Seluruh folder Dataset Gabungan akan dihapus permanen. Dataset sesi sumber tetap aman.',
    buttons: ['Batal', 'Bersihkan Semua'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return { ok:false, canceled:true, deleted:0 };
  return { ok:true, ...clearCombinedDatasets(workspaceDir) };
});
ipcMain.handle('run:open-source', async (_event, runDir) => {
  const targetRun = path.resolve(String(runDir || ''));
  ensureManagedRunResults(workspaceDir, targetRun);
  const managed = ensureManagedRunResults(workspaceDir, targetRun);
  const target = managed.sourceDir || managed.directory;
  const error = await shell.openPath(target);
  return { ok: !error, error: error || '', directory: target };
});

ipcMain.handle('run:delete-history', async (_event, runDir) => {
  const { target } = resolveRunHistoryDirectory(workspaceDir, runDir);
  if (isActiveRunDirectory(target)) throw new Error('Run yang sedang berjalan tidak dapat dihapus. Jeda atau tunggu proses selesai.');

  const run = scanRuns(workspaceDir, { limit: Number.MAX_SAFE_INTEGER })
    .find(item => normalizedPath(item.runDir) === normalizedPath(target));
  if (!run) return { ok: true, deleted: 0, missing: true };

  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Hapus riwayat run?',
    message: `Hapus riwayat “${run.projectName || 'Proyek'}”?`,
    detail: 'Data run, checkpoint, dan folder Dataset yang dikelola MyDataset akan dihapus permanen. File proyek tetap aman. File yang Anda simpan manual di lokasi lain tidak disentuh.',
    buttons: ['Batal', 'Hapus Riwayat'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return { ok: false, canceled: true, deleted: 0 };

  const managedResults = deleteManagedRunResults(workspaceDir, target);
  const result = deleteRunHistoryEntry(workspaceDir, target);
  return { ok: true, ...result, managedResultsDeleted: managedResults.deleted };
});

ipcMain.handle('run:clear-history', async () => {
  if (activeRun) throw new Error('Riwayat tidak dapat dibersihkan ketika run masih berjalan. Jeda atau tunggu proses selesai.');
  const runs = scanRuns(workspaceDir, { limit: Number.MAX_SAFE_INTEGER });
  if (!runs.length) return { ok: true, deleted: 0 };

  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Bersihkan seluruh riwayat?',
    message: `Hapus seluruh ${runs.length.toLocaleString('id-ID')} riwayat run dan checkpoint?`,
    detail: 'Tindakan ini tidak dapat dibatalkan. Seluruh data run/checkpoint dan folder Dataset akan dihapus. File proyek tetap aman.',
    buttons: ['Batal', 'Bersihkan Semua'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return { ok: false, canceled: true, deleted: 0 };

  const managedResults = clearManagedHistoryResults(workspaceDir);
  return { ok: true, ...clearRunHistory(workspaceDir), managedResultsDeleted: managedResults.deleted };
});

ipcMain.handle('run:results', (_event, runDir, limit = 300, tail = false) => {
  const runState = readRunState(runDir);
  const safeLimit = Math.max(1, Number(limit) || 300);
  // Live UI reads use a bounded tail scan so a long crawl does not re-read the
  // entire JSONL checkpoint every refresh. Normal/final reads keep the original
  // first-N behavior.
  const allCleanRows = tail ? null : readJsonl(runDatasetPath(runDir, 'clean'));
  const rows = tail ? readJsonlTail(runDatasetPath(runDir, 'clean'), safeLimit) : allCleanRows.slice(0, safeLimit);
  const cleanCount = Number(runState?.itemsCollected ?? (allCleanRows ? allCleanRows.length : rows.length) ?? 0);
  const text = runState?.textRecords != null
    ? Number(runState.textRecords || 0)
    : (allCleanRows ? allCleanRows.reduce((count, row) => count + (String(row?.review_text || '').trim() ? 1 : 0), 0) : 0);
  const withoutText = runState?.withoutTextRecords != null
    ? Number(runState.withoutTextRecords || 0)
    : (allCleanRows ? Math.max(0, allCleanRows.length - text) : 0);
  const identityCounts = allCleanRows
    ? allCleanRows.reduce((acc, row) => {
        const reviewId = String(row?.review_id ?? row?.reviewId ?? row?.id ?? '').trim();
        const synthetic = String(row?._reviewIdSource || '').toLowerCase() === 'synthetic' || /^synthetic:/i.test(reviewId);
        if (synthetic) acc.synthetic += 1;
        else if (reviewId) acc.native += 1;
        else acc.missing += 1;
        return acc;
      }, { native: 0, synthetic: 0, missing: 0 })
    : {
        native: Number(runState?.nativeReviewIds || 0),
        synthetic: Number(runState?.syntheticReviewIds || 0),
        missing: Number(runState?.missingReviewIds || 0)
      };
  return {
    rows,
    state: runState,
    counts: {
      clean: cleanCount,
      raw: Number(runState?.rawItemsRead ?? runState?.itemsCollected ?? cleanCount),
      duplicates: Number(runState?.exactDuplicates ?? runState?.duplicatesSkipped ?? 0) + Number(runState?.possibleDuplicates || 0),
      exactDuplicates: Number(runState?.exactDuplicates ?? runState?.duplicatesSkipped ?? 0),
      possibleDuplicates: Number(runState?.possibleDuplicates || 0),
      text,
      withoutText,
      nativeReviewIds: Number(identityCounts.native || 0),
      syntheticReviewIds: Number(identityCounts.synthetic || 0),
      missingReviewIds: Number(identityCounts.missing || 0)
    }
  };
});

ipcMain.handle('run:dataset', (_event, runDir, dataset = 'clean', limit = 300) => {
  const selected = normalizeDataset(dataset);
  const runState = readRunState(runDir);
  const rows = readJsonl(runDatasetPath(runDir, selected));
  const requestedLimit = Number(limit);
  return {
    dataset: selected,
    rows: requestedLimit === 0 ? rows : rows.slice(0, Math.max(1, requestedLimit || 300)),
    state: runState
  };
});

function duplicateDecisionStorePath(runDir) {
  return path.join(runDir, 'duplicate-review-decisions.json');
}

function readDuplicateDecisionStore(runDir) {
  const filePath = duplicateDecisionStorePath(runDir);
  try {
    if (!fs.existsSync(filePath)) return { schemaVersion: 1, updatedAt: null, decisions: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      schemaVersion: 1,
      updatedAt: parsed?.updatedAt || null,
      decisions: parsed?.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {}
    };
  } catch {
    return { schemaVersion: 1, updatedAt: null, decisions: {} };
  }
}

function writeDuplicateDecisionStore(runDir, store) {
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    decisions: store?.decisions && typeof store.decisions === 'object' ? store.decisions : {}
  };
  fs.writeFileSync(duplicateDecisionStorePath(runDir), JSON.stringify(payload, null, 2), 'utf8');

  // Keputusan manusia adalah audit tambahan; Data Asli dan Hasil Cleaning tidak diubah.
  try {
    const resultDir = managedResultDirectory(workspaceDir, runDir);
    if (fs.existsSync(resultDir)) {
      const auditDir = path.join(resultDir, '04-Audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const auditFile = path.join(auditDir, 'keputusan-potensi-duplikat.json');
      if (Object.keys(payload.decisions).length) fs.writeFileSync(auditFile, JSON.stringify(payload, null, 2), 'utf8');
      else if (fs.existsSync(auditFile)) fs.rmSync(auditFile, { force: true });
      const summaryPath = path.join(resultDir, 'ringkasan.json');
      if (fs.existsSync(summaryPath)) {
        try {
          const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
          summary.files = { ...(summary.files || {}), duplicateDecisions: Object.keys(payload.decisions).length ? '04-Audit/keputusan-potensi-duplikat.json' : null };
          summary.audit = { ...(summary.audit || {}), humanDuplicateDecisions: Object.keys(payload.decisions).length };
          fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
        } catch {}
      }
    }
  } catch {}
  return payload;
}

ipcMain.handle('run:duplicate-decisions:get', (_event, runDir = '') => {
  const { target } = resolveRunHistoryDirectory(workspaceDir, runDir);
  if (!fs.existsSync(target)) return { ok: false, decisions: {}, error: 'Sesi tidak ditemukan.' };
  const store = readDuplicateDecisionStore(target);
  return { ok: true, ...store };
});

ipcMain.handle('run:duplicate-decisions:set', (_event, runDir = '', payload = {}) => {
  if (activeRun) throw new Error('Keputusan audit tidak dapat diubah ketika proses masih berjalan.');
  const { target } = resolveRunHistoryDirectory(workspaceDir, runDir);
  if (!fs.existsSync(target)) throw new Error('Sesi tidak ditemukan.');
  const relationKey = String(payload?.relationKey || '').trim();
  if (!relationKey) throw new Error('Identitas pasangan duplikat tidak tersedia.');
  const decision = String(payload?.decision || 'unreviewed');
  if (!['unreviewed', 'confirmed', 'rejected'].includes(decision)) throw new Error('Keputusan audit tidak valid.');
  const store = readDuplicateDecisionStore(target);
  if (decision === 'unreviewed') delete store.decisions[relationKey];
  else {
    store.decisions[relationKey] = {
      decision,
      decidedAt: new Date().toISOString(),
      sourceId: String(payload?.sourceId || ''),
      duplicateId: String(payload?.duplicateId || ''),
      dedupeStatus: String(payload?.dedupeStatus || ''),
      reviewSubject: String(payload?.reviewSubject || '')
    };
  }
  const written = writeDuplicateDecisionStore(target, store);
  return { ok: true, ...written };
});

ipcMain.handle('run:log', (_event, runDir = '') => {
  const target = path.resolve(String(runDir || ''));
  if (!target || !fs.existsSync(target)) return { ok:false, text:'', error:'Sesi tidak ditemukan.' };
  const logPath = path.join(target, 'run.log.txt');
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { ok:true, text };
});

ipcMain.handle('data:export', async (_event, payload) => {
  const { format, rows, runDir, projectName, startUrl, source = null, combinedDirectory = null, textOnly = false } = payload;
  const dataset = normalizeDataset(payload.dataset);
  const exportSchema = payload.schema === 'canonical' || payload.schema === 'standard' ? 'canonical' : 'native';
  const supported = new Set(['csv', 'json', 'xlsx']);
  if (!supported.has(format)) throw new Error(`Format ekspor tidak didukung: ${format}`);
  const ext = format;

  let finalRows = Array.isArray(rows) ? rows : [];
  let runState = null;
  let runProject = null;
  let combinedManifest = null;
  let combinedTarget = null;
  const isCombined = Boolean(combinedDirectory);

  if (isCombined) {
    const resolved = resolveCombinedDatasetDirectory(workspaceDir, combinedDirectory);
    combinedTarget = resolved.target;
    combinedManifest = resolved.manifest;
    finalRows = readCombinedDataset(workspaceDir, combinedTarget, 0, dataset === 'duplicates' ? 'duplicates' : 'clean').rows;
  } else if (runDir) {
    runProject = readRunProject(runDir);
    finalRows = readJsonl(runDatasetPath(runDir, dataset));
    runState = readRunState(runDir);
  }

  const effectiveSource = runProject?.source || source || null;
  const effectiveProjectName = isCombined ? (combinedManifest?.name || 'Dataset Gabungan') : (runProject?.name || projectName);
  const effectiveStartUrl = isCombined ? '' : (runProject?.startUrl || startUrl);
  const effectiveReviewSubject = isCombined ? '' : (runProject?.reviewSubject || effectiveSource?.objectName || payload.reviewSubject || '');
  const effectiveSiteProfile = isCombined ? '' : (runProject?.siteProfile || payload.siteProfile || '');
  let acquisitionMethod = '';
  let sessionId = '';
  let runId = '';
  if (!isCombined && runDir) {
    const networkManifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'network-import-manifest.json'), 'utf8')); } catch { return null; } })();
    acquisitionMethod = networkManifest?.importType === 'har-network'
      ? 'har-network'
      : (networkManifest?.importType === 'network-response'
          ? 'network-json'
          : (runProject?.acquisition?.method || runState?.acquisitionMethod || 'dom'));
    sessionId = String(runState?.sessionId || runState?.runId || '');
    runId = String(runState?.runId || '');
  }

  // Export cleanup also repairs runs created by older MyDataset versions.
  finalRows = sanitizeExportRows(finalRows);
  if (exportSchema === 'canonical') {
    finalRows = standardizeRows(finalRows, {
      reviewSubject: effectiveReviewSubject,
      objectName: effectiveSource?.objectName || effectiveReviewSubject,
      siteName: effectiveSource?.siteName || '',
      siteProfile: effectiveSiteProfile,
      sourceUrl: effectiveSource?.sourceUrl || effectiveStartUrl || '',
      acquisitionMethod,
      sessionId,
      runId
    });
    // rating_normalized exists only for a merged dataset with mixed rating_max.
    // Legacy combined datasets are recalculated here so exports follow the same rule.
    if (isCombined) finalRows = applyConditionalRatingNormalization(finalRows).rows;
  }
  if (textOnly) finalRows = finalRows.filter(row => String(row.review_text || '').trim());

  const preferredObjectName = isCombined ? '' : (finalRows[0]?._objectName || effectiveReviewSubject || runState?.objectName || '');
  const sourceContext = isCombined ? { objectName:'', siteName:'', sourceUrl:'' } : resolveSourceContext({
    url: finalRows[0]?._sourceUrl || effectiveSource?.sourceUrl || effectiveStartUrl || runState?.sourceUrl || runState?.currentUrl || '',
    preferredObjectName
  });
  const resolvedObjectName = preferredObjectName || sourceContext.objectName;
  const exportDatasetLabel = textOnly && dataset === 'clean' ? 'siap-analisis-teks' : (exportSchema === 'canonical' ? (dataset === 'clean' ? 'siap-analisis' : `${datasetLabel(dataset)}-standard`) : datasetLabel(dataset));
  const baseName = isCombined
    ? buildCombinedExportBaseName({ name: combinedManifest?.name || 'Dataset Gabungan', rows: finalRows, manifest: combinedManifest, dataset: exportDatasetLabel, countOverride: finalRows.length })
    : buildExportBaseName({
        rows: finalRows,
        projectName: effectiveProjectName,
        startUrl: effectiveStartUrl,
        runState,
        objectName: resolvedObjectName,
        siteName: effectiveSource?.siteName || runState?.siteName || sourceContext.siteName,
        dataset: exportDatasetLabel,
        countOverride: finalRows.length
      });
  const formatLabels = { csv: 'CSV', json: 'JSON', xlsx: 'Excel XLSX' };
  if (runDir && !isCombined) fs.mkdirSync(runOutputDirectory(runDir, dataset), { recursive: true });
  const defaultDirectory = isCombined ? path.join(combinedTarget, combinedManifest?.folders?.result || '') : (runDir ? runOutputDirectory(runDir, dataset) : '');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: isCombined ? 'Ekspor Dataset Gabungan' : 'Ekspor hasil crawling & scraping',
    defaultPath: defaultDirectory ? path.join(defaultDirectory, `${baseName}.${ext}`) : `${baseName}.${ext}`,
    filters: [{ name: formatLabels[format], extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const combinedSites = isCombined
    ? (combinedManifest?.composition?.clean?.bySource || []).map(item => String(item.source || '')).filter(Boolean).join(' + ')
    : '';
  writeExportFile(result.filePath, format, finalRows, {
    headers: isCombined && exportSchema === 'canonical' ? standardColumnsForRows(finalRows) : undefined,
    projectName: effectiveProjectName,
    objectName: isCombined ? 'Dataset Gabungan' : resolvedObjectName,
    siteName: isCombined ? combinedSites : (effectiveSource?.siteName || runState?.siteName || sourceContext.siteName),
    siteProfile: effectiveSiteProfile || runState?.siteProfile || '',
    acquisitionMethod: isCombined ? 'combined-dataset' : acquisitionMethod,
    sourceUrl: isCombined ? '' : sourceContext.sourceUrl,
    dataset: exportDatasetLabel,
    schema: exportSchema === 'canonical' ? STANDARD_SCHEMA_VERSION : 'site-native',
    exportedAt: formatLocalDateTime(new Date())
  });
  rememberExport(result.filePath, isCombined ? null : runDir);
  return { canceled: false, filePath: result.filePath, rows: finalRows.length, format, dataset, schema: exportSchema, combined: isCombined, textOnly: Boolean(textOnly) };
});

ipcMain.handle('data:export-bundle', async (_event, payload = {}) => {
  const { runDir, projectName, startUrl, source = null } = payload;
  if (!runDir) throw new Error('Paket dataset hanya tersedia setelah run disimpan.');
  const runState = readRunState(runDir);
  const runProject = readRunProject(runDir);
  const effectiveSource = runProject?.source || source || null;
  const effectiveProjectName = runProject?.name || projectName;
  const effectiveStartUrl = runProject?.startUrl || startUrl;
  const effectiveReviewSubject = runProject?.reviewSubject || effectiveSource?.objectName || payload.reviewSubject || '';
  const effectiveSiteProfile = runProject?.siteProfile || payload.siteProfile || '';
  const datasets = {
    clean: sanitizeExportRows(readJsonl(runDatasetPath(runDir, 'clean'))),
    raw: sanitizeExportRows(readJsonl(runDatasetPath(runDir, 'raw'))),
    duplicates: sanitizeExportRows(readJsonl(runDatasetPath(runDir, 'duplicates')))
  };
  const sample = datasets.clean[0] || datasets.raw[0] || datasets.duplicates[0] || null;
  const preferredObjectName = sample?._objectName || effectiveReviewSubject || runState?.objectName || '';
  const sourceContext = resolveSourceContext({
    url: sample?._sourceUrl || effectiveSource?.sourceUrl || effectiveStartUrl || runState?.sourceUrl || runState?.currentUrl || '',
    preferredObjectName
  });
  const resolvedObjectName = preferredObjectName || sourceContext.objectName;
  const managed = ensureManagedRunResults(workspaceDir, runDir);
  const root = managed.directory;
  const dataDirectory = managed.dataDir;
  const rawDirectory = managed.rawDir;
  const auditDirectory = managed.auditDir;

  const bundleNetworkManifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'network-import-manifest.json'), 'utf8')); } catch { return null; } })();
  const acquisitionMethod = bundleNetworkManifest?.importType === 'har-network'
    ? 'har-network'
    : (bundleNetworkManifest?.importType === 'network-response'
        ? 'network-json'
        : (runProject?.acquisition?.method || runState?.acquisitionMethod || 'dom'));
  const siteProfile = runProject?.siteProfile || runState?.siteProfile || effectiveSiteProfile || '';
  const commonMeta = {
    projectName: effectiveProjectName,
    objectName: resolvedObjectName,
    siteName: effectiveSource?.siteName || runState?.siteName || sourceContext.siteName,
    siteProfile,
    acquisitionMethod,
    sourceUrl: sourceContext.sourceUrl,
    exportedAt: formatLocalDateTime(new Date())
  };
  const files = [];

  // Semua dataset siap pakai langsung terlihat di folder judul.
  for (const format of ['csv', 'json']) {
    const filePath = path.join(dataDirectory, `data-hasil-cleaning.${format}`);
    writeExportFile(filePath, format, datasets.clean, { ...commonMeta, dataset: 'clean' });
    files.push(filePath);
  }
  const standardClean = standardizeRows(datasets.clean, {
    reviewSubject: effectiveReviewSubject || resolvedObjectName,
    objectName: resolvedObjectName,
    siteName: effectiveSource?.siteName || runState?.siteName || sourceContext.siteName,
    siteProfile: effectiveSiteProfile,
    sourceUrl: sourceContext.sourceUrl,
    acquisitionMethod,
    sessionId: String(runState?.sessionId || runState?.runId || ''),
    runId: String(runState?.runId || '')
  });
  for (const format of ['csv', 'xlsx', 'json']) {
    const filePath = path.join(dataDirectory, `data-siap-analisis.${format}`);
    writeExportFile(filePath, format, standardClean, { ...commonMeta, dataset: 'analysis-ready', schema: STANDARD_SCHEMA_VERSION });
    files.push(filePath);
  }
  const textOnly = standardClean.filter(row => String(row.review_text || '').trim());
  const textOnlyPath = path.join(dataDirectory, 'data-siap-analisis-teks.csv');
  writeExportFile(textOnlyPath, 'csv', textOnly, { ...commonMeta, dataset: 'analysis-text', schema: STANDARD_SCHEMA_VERSION });
  files.push(textOnlyPath);

  // Data asli, hasil analisis, audit, dan log dipisahkan berdasarkan fungsi.
  for (const format of ['csv', 'json']) {
    const rawPath = path.join(rawDirectory, `data-asli.${format}`);
    writeExportFile(rawPath, format, datasets.raw, { ...commonMeta, dataset: 'raw' });
    files.push(rawPath);
    const duplicatePath = path.join(auditDirectory, `audit-duplikat.${format}`);
    writeExportFile(duplicatePath, format, datasets.duplicates, { ...commonMeta, dataset: 'duplicates' });
    files.push(duplicatePath);
  }
  const sourceLog = path.join(runDir, 'run.log.txt');
  const logPath = path.join(root, 'proses.log');
  fs.writeFileSync(logPath, fs.existsSync(sourceLog) ? fs.readFileSync(sourceLog, 'utf8') : 'Belum ada log run.\n', 'utf8');
  files.push(logPath);

  const networkImportManifest = path.join(runDir, 'network-import-manifest.json');
  const datasetMetadataPath = path.join(runDir, 'dataset-metadata.json');
  const sourceBundleDirectory = managed.sourceDir;
  // ensureManagedRunResults() sudah membuat salinan sumber yang dinormalisasi dan
  // portable. Jangan menimpa kembali dengan file internal mentah karena file lama
  // dapat membawa path absolut atau label acquisition legacy.
  const collectPortableFiles = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) collectPortableFiles(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  collectPortableFiles(sourceBundleDirectory);

  const manifest = {
    schemaVersion: 5,
    applicationManaged: true,
    layout: 'dataset-object-session-v099',
    canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
    standardSchemaVersion: STANDARD_SCHEMA_VERSION,
    applicationVersion: app.getVersion(),
    projectName: runState?.projectName || projectName || '',
    objectName: resolvedObjectName,
    siteName: effectiveSource?.siteName || runState?.siteName || sourceContext.siteName,
    siteProfile,
    acquisitionMethod,
    sourceUrl: sourceContext.sourceUrl,
    sessionId: String(runState?.sessionId || runState?.runId || ''),
    runId: String(runState?.runId || ''),
    status: String(runState?.status || ''),
    startedAt: runState?.startedAt || null,
    finishedAt: runState?.finishedAt || null,
    exportedAt: formatLocalDateTime(new Date()),
    input: fs.existsSync(networkImportManifest) ? {
      type: acquisitionMethod === 'har-network' ? 'har-network' : 'network-response',
      manifest: fs.existsSync(path.join(sourceBundleDirectory, 'network-import-manifest.json')) ? '01-Sumber/network-import-manifest.json' : null,
      datasetMetadata: fs.existsSync(path.join(sourceBundleDirectory, 'dataset-metadata.json')) ? '01-Sumber/dataset-metadata.json' : null
    } : { type: 'browser-dom' },
    folders: { root: '.', source: '01-Sumber', raw: '02-Data-Asli', result: '03-Hasil', audit: '04-Audit' },
    counts: {
      source: datasets.raw.length,
      raw: datasets.raw.length,
      clean: datasets.clean.length,
      text: textOnly.length,
      withoutText: Math.max(0, datasets.clean.length - textOnly.length),
      duplicates: datasets.duplicates.length,
      exactDuplicates: Number(runState?.exactDuplicates ?? runState?.duplicatesSkipped ?? 0),
      duplicateCandidates: Number(runState?.possibleDuplicates || 0)
    },
    files: {
      rawCsv: '02-Data-Asli/data-asli.csv',
      cleanCsv: '03-Hasil/data-hasil-cleaning.csv',
      standardCleanCsv: '03-Hasil/data-siap-analisis.csv',
      textAnalysisCsv: '03-Hasil/data-siap-analisis-teks.csv',
      analysisXlsx: '03-Hasil/data-siap-analisis.xlsx',
      duplicatesCsv: datasets.duplicates.length ? '04-Audit/audit-duplikat.csv' : null
    }
  };
  const manifestPath = path.join(root, 'ringkasan.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  files.push(manifestPath);

  rememberExport(root, runDir);
  return { canceled: false, directory: root, files, counts: manifest.counts };
});

ipcMain.handle('log:export', async (_event, payload = {}) => {
  const { runDir, logText, rows, projectName, startUrl, source = null } = payload;
  let finalRows = Array.isArray(rows) ? rows : [];
  let text = String(logText || '');
  let runState = null;

  if (runDir) {
    const logPath = path.join(runDir, 'run.log.txt');
    finalRows = readJsonl(runDatasetPath(runDir, 'clean'));
    runState = readRunState(runDir);
    if (fs.existsSync(logPath)) text = fs.readFileSync(logPath, 'utf8');
  }

  if (!text.trim() && runState) {
    text = [
      `Status: ${runState.status || '-'}`,
      `Project: ${runState.projectName || projectName || '-'}`,
      `Data Asli: ${runState.rawItemsRead || runState.itemsCollected || finalRows.length || 0}`,
      `Hasil Cleaning: ${runState.itemsCollected || finalRows.length || 0}`,
      `Duplikat pasti dilewati: ${runState.exactDuplicates ?? runState.duplicatesSkipped ?? 0}`,
      `Kemungkinan duplikat dipertahankan: ${runState.possibleDuplicates || 0}`,
      `Halaman terakhir: ${runState.currentPage || '-'}`,
      `Pesan terakhir: ${runState.lastMessage || '-'}`
    ].join('\n');
  }
  if (!text.trim()) text = 'Belum ada log run yang tersedia.';

  const preferredObjectName = finalRows[0]?._objectName || source?.objectName || runState?.objectName || '';
  const sourceContext = resolveSourceContext({
    url: finalRows[0]?._sourceUrl || source?.sourceUrl || startUrl || runState?.sourceUrl || runState?.currentUrl || '',
    preferredObjectName
  });
  const resolvedObjectName = preferredObjectName || sourceContext.objectName;
  const baseName = buildExportBaseName({
    rows: finalRows, projectName, startUrl, runState,
    objectName: resolvedObjectName,
    siteName: source?.siteName || runState?.siteName || sourceContext.siteName,
    dataset: 'log',
    countOverride: finalRows.length || Number(runState?.itemsCollected || 0)
  });
  if (runDir) fs.mkdirSync(runLogDirectory(runDir), { recursive: true });
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Ekspor log MyDataset',
    defaultPath: runDir ? path.join(runLogDirectory(runDir), `${baseName}.txt`) : `${baseName}.txt`,
    filters: [{ name: 'Text Log', extensions: ['txt'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const header = [
    'MyDataset - Run Log',
    `Objek uji: ${resolvedObjectName || '-'}`,
    `Situs: ${source?.siteName || runState?.siteName || sourceContext.siteName || '-'}`,
    `URL sumber: ${sourceContext.sourceUrl || '-'}`,
    `Waktu mulai uji: ${runState?.startedAt ? formatLocalDateTime(runState.startedAt) : finalRows[0]?._scrapedAt || '-'}`,
    `Export: ${formatLocalDateTime(new Date())}`,
    `Data Asli: ${runState?.rawItemsRead || finalRows.length || 0}`,
    `Hasil Cleaning: ${finalRows.length || runState?.itemsCollected || 0}`,
    `Duplikat pasti: ${runState?.exactDuplicates ?? runState?.duplicatesSkipped ?? 0}`,
    `Kemungkinan duplikat: ${runState?.possibleDuplicates || 0}`,
    '----------------------------------------'
  ].join('\n');
  fs.writeFileSync(result.filePath, `${header}\n${text.trim()}\n`, 'utf8');
  rememberExport(result.filePath, runDir);
  return { canceled: false, filePath: result.filePath, rows: finalRows.length || runState?.itemsCollected || 0 };
});

ipcMain.handle('app:open-workspace', (_event, projectName = '') => {
  const target = projectName
    ? path.join(workspaceDir, 'Dataset', projectDirectoryName(projectName))
    : workspaceDir;
  fs.mkdirSync(target, { recursive: true });
  return shell.openPath(target);
});

ipcMain.handle('app:open-run-output', (_event, runDir) => {
  const { target } = resolveRunHistoryDirectory(workspaceDir, runDir);
  const output = ensureManagedRunResults(workspaceDir, target).directory;
  return shell.openPath(output).then(error => ({ ok: !error, directory: output, error: error || '' }));
});

ipcMain.handle('app:open-result-location', (_event, runDir = null) => {
  // Jika ada run aktif/riwayat, "Buka Folder Dataset" selalu membuka folder
  // terkelola yang sinkron dengan run tersebut. Jangan lagi mengarahkan
  // pengguna ke file ekspor manual terakhir di lokasi lain.
  if (runDir) {
    const { target } = resolveRunHistoryDirectory(workspaceDir, runDir);
    const output = ensureManagedRunResults(workspaceDir, target).directory;
    return shell.openPath(output).then(error => ({ ok: !error, target: output, error: error || '' }));
  }
  if (lastExportTarget && fs.existsSync(lastExportTarget)) {
    const stat = fs.statSync(lastExportTarget);
    if (stat.isFile()) {
      shell.showItemInFolder(lastExportTarget);
      return { ok: true, target: lastExportTarget, revealed: true };
    }
    return shell.openPath(lastExportTarget).then(error => ({ ok: !error, target: lastExportTarget, error: error || '' }));
  }
  return { ok: false, error: 'Belum ada hasil atau run yang dapat dibuka.' };
});

function sendRunProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('run:progress', payload);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function readJsonlTail(filePath, limit = 300) {
  if (!fs.existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number(limit) || 300);
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return [];
    const chunks = [];
    const chunkSize = 64 * 1024;
    let position = size;
    let newlines = 0;
    while (position > 0 && newlines <= safeLimit + 1) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      chunks.unshift(chunk);
      for (let i = 0; i < chunk.length; i += 1) if (chunk[i] === 0x0a) newlines += 1;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let lines = text.split(/\r?\n/);
    // When reading from the middle of the file, the first line is only a
    // fragment. Discard it rather than risking a partial JSON record.
    if (position > 0) lines = lines.slice(1);
    const rows = [];
    for (let index = lines.length - 1; index >= 0 && rows.length < safeLimit; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows.reverse();
  } finally {
    fs.closeSync(fd);
  }
}
