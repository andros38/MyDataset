const fs = require('fs');
const path = require('path');
const { projectDirectoryName } = require('./run-store');
const { toCsv } = require('./csv');
const { buildXlsx } = require('./xlsx');
const { sanitizeExportRows } = require('./normalizers');
const { standardizeRows, STANDARD_SCHEMA_VERSION, STANDARD_REVIEW_COLUMNS } = require('./canonical-review');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson(filePath) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; } }
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}
function runState(runDir) { return readJson(path.join(runDir, 'state.json')) || {}; }
function runProjectSnapshot(runDir) { return readJson(path.join(runDir, 'project.snapshot.json')) || {}; }
function runToken(runDir, state = {}) {
  const base = path.basename(runDir);
  const raw = /^Run\s+(.+)$/i.test(base) ? base.replace(/^Run\s+/i, '') : String(state.startedAt || base || Date.now()).replace(/[T:]/g, '-').replace(/\..*$/, '');
  return raw.replace(/\s+\((\d+)\)$/g, '_$1').replace(/\s+/g, '_').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/-+/g, '-').slice(0, 80) || 'hasil';
}
function runProjectName(runDir, state = null, project = null) {
  const currentState = state || runState(runDir);
  const currentProject = project || runProjectSnapshot(runDir);
  if (currentProject?.name) return currentProject.name;
  if (currentState?.projectName) return currentState.projectName;
  const parent = path.dirname(path.dirname(runDir));
  return path.basename(parent) || 'Proyek';
}
function extractRunDateTime(runDir, state = {}) {
  const pad = value => String(value).padStart(2, '0');
  const fromDate = value => ({ date:`${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}`, time:`${pad(value.getHours())}-${pad(value.getMinutes())}-${pad(value.getSeconds())}` });
  // Nama run dibuat dengan waktu lokal. Prioritaskan ini agar folder hasil sama
  // dengan waktu yang terlihat di Riwayat, bukan representasi UTC startedAt.
  const runName = path.basename(runDir).replace(/^Run\s+/i, '');
  const candidates = [runName, state.startedAt, state.finishedAt];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    if (/[TZ]|[+\-]\d{2}:?\d{2}$/i.test(raw)) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) return fromDate(parsed);
    }
    let match = raw.match(/(\d{4})-(\d{2})-(\d{2})[T\s_]+(\d{2})[:\-](\d{2})[:\-](\d{2})/);
    if (match) return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}-${match[5]}-${match[6]}` };
    match = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return { date: `${match[1]}-${match[2]}-${match[3]}`, time: '00-00-00' };
  }
  return fromDate(new Date());
}

// v0.98: pengguna hanya melihat dua kelompok utama di Documents/MyDataset:
// Dataset dan Dataset Gabungan.
function managedResultsRoot(workspaceDir) { return ensureDir(path.join(workspaceDir, 'Dataset')); }
function resultFolderBaseName(runDir, state = null) {
  const currentState = state || runState(runDir);
  const stamp = extractRunDateTime(runDir, currentState);
  return `${stamp.date}_${stamp.time}`;
}
function resultObjectDirectory(workspaceDir, runDir, state = null, project = null) {
  const currentState = state || runState(runDir);
  const currentProject = project || runProjectSnapshot(runDir);
  return path.join(managedResultsRoot(workspaceDir), projectDirectoryName(runProjectName(runDir, currentState, currentProject)));
}
function resultDirectoryCandidate(workspaceDir, runDir, suffix = '') {
  const state = runState(runDir); const project = runProjectSnapshot(runDir);
  return path.join(resultObjectDirectory(workspaceDir, runDir, state, project), `${resultFolderBaseName(runDir, state)}${suffix}`);
}
function resultDirectoryBelongsToRun(dir, runDir) {
  const summary = readJson(path.join(dir, 'ringkasan.json'));
  if (!summary) return false;
  const state = runState(runDir);
  if (summary.sessionId && state.sessionId) return String(summary.sessionId) === String(state.sessionId);
  if (summary.runId && state.runId) return String(summary.runId) === String(state.runId);
  // Kompatibilitas ringkasan v0.98 dan lebih lama.
  if (summary.runDir) {
    const normalize = value => process.platform === 'win32' ? path.resolve(String(value || '')).toLowerCase() : path.resolve(String(value || ''));
    return normalize(summary.runDir) === normalize(runDir);
  }
  return false;
}
function managedResultDirectory(workspaceDir, runDir) {
  const targetRun = path.resolve(runDir);
  const first = resultDirectoryCandidate(workspaceDir, targetRun);
  if (!fs.existsSync(first) || resultDirectoryBelongsToRun(first, targetRun)) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = resultDirectoryCandidate(workspaceDir, targetRun, `_${i}`);
    if (!fs.existsSync(candidate) || resultDirectoryBelongsToRun(candidate, targetRun)) return candidate;
  }
  return resultDirectoryCandidate(workspaceDir, targetRun, `_${runToken(targetRun)}`);
}
function legacyResultDirectories(workspaceDir, runDir) {
  const target = path.resolve(runDir); const parent = path.dirname(target);
  const state = runState(runDir); const project = runProjectSnapshot(runDir);
  const token = path.basename(target).replace(/^Run\s+/i, '') || runToken(runDir, state);
  const outputName = `Hasil ${token}`;
  const projectTitle = projectDirectoryName(runProjectName(runDir, state, project));
  const stamp = extractRunDateTime(runDir, state);
  // v0.98 memakai startedAt ISO mentah sehingga timestamp UTC dapat masuk nama folder.
  let v098Stamp = null;
  const oldRaw = String(state.startedAt || '').trim();
  const oldMatch = oldRaw.match(/(\d{4})-(\d{2})-(\d{2})[T\s_]+(\d{2})[:\-](\d{2})[:\-](\d{2})/);
  if (oldMatch) v098Stamp = `${oldMatch[1]}-${oldMatch[2]}-${oldMatch[3]}_${oldMatch[4]}-${oldMatch[5]}-${oldMatch[6]}`;
  const candidates = [
    ...(v098Stamp ? [path.join(workspaceDir, 'Dataset', projectTitle, v098Stamp)] : []),
    // v0.65-v0.97 flat layout.
    path.join(workspaceDir, `${projectTitle}_${stamp.date}_${stamp.time}`),
    path.join(workspaceDir, stamp.date, `${projectTitle} - ${stamp.time}`),
    path.join(workspaceDir, 'Hasil', projectTitle, runToken(runDir, state))
  ];
  if (path.basename(parent).toLowerCase() === 'runs') candidates.push(path.join(path.dirname(parent), 'Exports', outputName));
  candidates.push(path.join(workspaceDir, 'Exports', path.basename(parent), outputName));
  return [...new Set(candidates.map(item => path.resolve(item)))];
}
function directoryHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryHasFiles(target)) return true;
  }
  return false;
}
function pruneEmptyParents(startDir, stopDir) {
  let current = path.resolve(startDir); const stop = path.resolve(stopDir);
  while (current.startsWith(stop) && current !== stop) {
    try { if (!fs.existsSync(current) || fs.readdirSync(current).length) break; fs.rmdirSync(current); } catch { break; }
    current = path.dirname(current);
  }
}
function acquisitionMethodForRun(runDir, project, state) {
  const networkManifest = readJson(path.join(runDir, 'network-import-manifest.json')) || {};
  if (networkManifest.importType === 'har-network' || networkManifest.acquisitionSource === 'har') return 'har-network';
  if (networkManifest.importType === 'network-response') return 'network-json';
  return project?.acquisition?.method || state?.acquisitionMethod || 'dom';
}
function buildSourceContext(runDir, cleanRows, project, state) {
  const sample = cleanRows[0] || {};
  return {
    reviewSubject: project?.reviewSubject || project?.source?.objectName || state?.objectName || sample?._objectName || '',
    canonicalObject: project?.reviewSubject || project?.source?.objectName || state?.objectName || sample?._objectName || '',
    sourceObjectName: project?.source?.sourceObjectName || sample?._objectName || project?.source?.objectName || state?.objectName || '',
    objectName: project?.source?.objectName || state?.objectName || sample?._objectName || '',
    siteName: project?.source?.siteName || state?.siteName || '',
    siteProfile: project?.siteProfile || '',
    sourceUrl: project?.source?.sourceUrl || state?.sourceUrl || state?.currentUrl || sample?._sourceUrl || '',
    acquisitionMethod: acquisitionMethodForRun(runDir, project, state),
    sessionId: String(state?.sessionId || state?.runId || ''),
    runId: String(state?.runId || '')
  };
}
function copyJsonNormalized(source, target, acquisitionMethod) {
  const data = readJson(source); if (!data) return false;
  if (data.acquisitionMethod != null) data.acquisitionMethod = acquisitionMethod;
  if (data.acquisition?.method != null) data.acquisition.method = acquisitionMethod;
  if (data.importType != null && acquisitionMethod === 'har-network') data.importType = 'har-network';
  if (data.acquisitionSource != null && acquisitionMethod === 'har-network') data.acquisitionSource = 'har';
  // Manifest pada folder hasil harus menunjuk ke lokasi hasil yang benar, bukan
  // path teknis internal `source-input/...` milik run tersembunyi.
  if (path.basename(source).toLowerCase() === 'network-import-manifest.json' && Array.isArray(data.files)) {
    data.files = data.files.map(item => {
      const storedAs = String(item?.storedAs || '').replace(/\\/g, '/');
      if (!storedAs) return item;
      const basename = path.posix.basename(storedAs);
      return { ...item, storedAs: `bukti-network/${basename}` };
    });
  }
  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
  return true;
}
function resultSubdirectories(resultDir) {
  return {
    source: ensureDir(path.join(resultDir, '01-Sumber')),
    raw: ensureDir(path.join(resultDir, '02-Data-Asli')),
    result: ensureDir(path.join(resultDir, '03-Hasil')),
    audit: ensureDir(path.join(resultDir, '04-Audit'))
  };
}
function ensureManagedRunResults(workspaceDir, runDir) {
  const target = path.resolve(runDir);
  if (!fs.existsSync(target)) throw new Error('Folder run tidak ditemukan.');
  const state = runState(target); const project = runProjectSnapshot(target);
  const resultDir = ensureDir(managedResultDirectory(workspaceDir, target));
  const dirs = resultSubdirectories(resultDir);
  const cleanRows = sanitizeExportRows(readJsonl(path.join(target, 'data.jsonl')));
  const rawRows = sanitizeExportRows(readJsonl(path.join(target, 'raw-data.jsonl')));
  const duplicateRows = sanitizeExportRows(readJsonl(path.join(target, 'duplicates-data.jsonl')));
  const duplicateDecisionStore = readJson(path.join(target, 'duplicate-review-decisions.json')) || { decisions: {} };
  const duplicateDecisionCount = Object.keys(duplicateDecisionStore.decisions || {}).length;
  const context = buildSourceContext(target, cleanRows, project, state);
  const standardRows = standardizeRows(cleanRows, context);
  const textRows = standardRows.filter(row => String(row.review_text || '').trim());
  const identityCounts = cleanRows.reduce((acc, row) => {
    const reviewId = String(row?.review_id ?? row?.reviewId ?? row?.id ?? '').trim();
    const synthetic = String(row?._reviewIdSource || '').toLowerCase() === 'synthetic' || /^synthetic:/i.test(reviewId);
    if (synthetic) acc.synthetic += 1;
    else if (reviewId) acc.native += 1;
    else acc.missing += 1;
    return acc;
  }, { native: 0, synthetic: 0, missing: 0 });

  fs.writeFileSync(path.join(dirs.raw, 'data-asli.csv'), toCsv(rawRows), 'utf8');
  fs.writeFileSync(path.join(dirs.result, 'data-hasil-cleaning.csv'), toCsv(cleanRows), 'utf8');
  fs.writeFileSync(path.join(dirs.result, 'data-siap-analisis.csv'), toCsv(standardRows), 'utf8');
  fs.writeFileSync(path.join(dirs.result, 'data-siap-analisis-teks.csv'), toCsv(textRows), 'utf8');
  fs.writeFileSync(path.join(dirs.result, 'data-siap-analisis.xlsx'), buildXlsx(standardRows, { headers: STANDARD_REVIEW_COLUMNS }));

  const duplicatePath = path.join(dirs.audit, 'audit-duplikat.csv');
  if (duplicateRows.length) fs.writeFileSync(duplicatePath, toCsv(duplicateRows), 'utf8');
  else if (fs.existsSync(duplicatePath)) fs.unlinkSync(duplicatePath);
  const decisionAuditPath = path.join(dirs.audit, 'keputusan-potensi-duplikat.json');
  if (duplicateDecisionCount) fs.writeFileSync(decisionAuditPath, JSON.stringify(duplicateDecisionStore, null, 2), 'utf8');
  else if (fs.existsSync(decisionAuditPath)) fs.unlinkSync(decisionAuditPath);

  const sourceFiles = [
    ['source-manifest.json', 'source-manifest.json'],
    ['project.snapshot.json', 'project.snapshot.json'],
    ['network-import-manifest.json', 'network-import-manifest.json'],
    ['dataset-metadata.json', 'dataset-metadata.json']
  ];
  for (const [from, to] of sourceFiles) {
    const source = path.join(target, from); const dest = path.join(dirs.source, to);
    if (fs.existsSync(source)) copyJsonNormalized(source, dest, context.acquisitionMethod);
  }
  const sourceInput = path.join(target, 'source-input');
  const targetInput = path.join(dirs.source, 'bukti-network');
  if (fs.existsSync(sourceInput)) {
    fs.rmSync(targetInput, { recursive: true, force: true }); fs.cpSync(sourceInput, targetInput, { recursive: true });
  } else if (fs.existsSync(targetInput)) fs.rmSync(targetInput, { recursive: true, force: true });

  const sourceLog = path.join(target, 'run.log.txt'); const targetLog = path.join(resultDir, 'proses.log');
  if (fs.existsSync(sourceLog) && fs.statSync(sourceLog).size > 0) fs.copyFileSync(sourceLog, targetLog);
  else if (fs.existsSync(targetLog)) fs.unlinkSync(targetLog);

  const exactDuplicates = Number(state.exactDuplicates ?? state.duplicatesSkipped ?? 0);
  const possibleDuplicates = Number(state.possibleDuplicates || 0);
  const summary = {
    schemaVersion: 5,
    standardSchemaVersion: STANDARD_SCHEMA_VERSION,
    applicationManaged: true,
    layout: 'dataset-object-session-v099',
    projectName: runProjectName(target, state, project),
    objectName: context.objectName || context.reviewSubject || '',
    siteName: context.siteName || '', sourceUrl: context.sourceUrl || '', acquisitionMethod: context.acquisitionMethod || '',
    sessionId: context.sessionId || '', runId: context.runId || '', status: state.status || '',
    sourceEndReason: state.sourceEndReason || null, sourceEndMessage: state.sourceEndMessage || null,
    completionReason: state.completionReason || null, completionMessage: state.completionMessage || null,
    coverage: {
      sourceLimited: state.sourceEndReason === 'SOURCE_LIMIT_REACHED',
      stepLimited: state.completionReason === 'USER_STEP_LIMIT_REACHED',
      completeByObservedSourceEnd: state.sourceEndReason === 'PAGINATION_END_REACHED'
    },
    startedAt: state.startedAt || null, finishedAt: state.finishedAt || null,
    counts: {
      source: Number(state.rawItemsRead || rawRows.length || cleanRows.length),
      clean: cleanRows.length,
      text: textRows.length,
      withoutText: Math.max(0, cleanRows.length - textRows.length),
      exactDuplicates,
      duplicateCandidates: possibleDuplicates,
      duplicateAuditRows: duplicateRows.length,
      humanDuplicateDecisions: duplicateDecisionCount,
      nativeReviewIds: identityCounts.native,
      syntheticReviewIds: identityCounts.synthetic,
      missingReviewIds: identityCounts.missing
    },
    folders: { source:'01-Sumber', raw:'02-Data-Asli', result:'03-Hasil', audit:'04-Audit' },
    files: {
      rawCsv: '02-Data-Asli/data-asli.csv',
      cleanCsv: '03-Hasil/data-hasil-cleaning.csv',
      standardCleanCsv: '03-Hasil/data-siap-analisis.csv',
      textAnalysisCsv: '03-Hasil/data-siap-analisis-teks.csv',
      analysisXlsx: '03-Hasil/data-siap-analisis.xlsx',
      duplicatesCsv: duplicateRows.length ? '04-Audit/audit-duplikat.csv' : null,
      duplicateDecisions: duplicateDecisionCount ? '04-Audit/keputusan-potensi-duplikat.json' : null,
      datasetMetadata: fs.existsSync(path.join(target,'dataset-metadata.json')) ? '01-Sumber/dataset-metadata.json' : null,
      processLog: fs.existsSync(targetLog) ? 'proses.log' : null
    }
  };
  fs.writeFileSync(path.join(resultDir, 'ringkasan.json'), JSON.stringify(summary, null, 2), 'utf8');

  for (const legacy of legacyResultDirectories(workspaceDir, target)) {
    try {
      if (path.resolve(legacy) === path.resolve(resultDir)) continue;
      if (!fs.existsSync(legacy)) continue;
      const legacySummary = readJson(path.join(legacy, 'ringkasan.json'));
      if (legacySummary?.applicationManaged === true || !directoryHasFiles(legacy)) {
        fs.rmSync(legacy, { recursive: true, force: true }); pruneEmptyParents(path.dirname(legacy), workspaceDir);
      }
    } catch {}
  }
  return { directory: resultDir, sourceDir: dirs.source, rawDir: dirs.raw, dataDir: dirs.result, auditDir: dirs.audit, summary };
}
function deleteManagedRunResults(workspaceDir, runDir) {
  const targets = [managedResultDirectory(workspaceDir, runDir), ...legacyResultDirectories(workspaceDir, runDir)]; let deleted = 0;
  for (const target of [...new Set(targets.map(item => path.resolve(item)))]) {
    try { if (!fs.existsSync(target)) continue; fs.rmSync(target, { recursive:true, force:true, maxRetries:2, retryDelay:100 }); deleted += 1; pruneEmptyParents(path.dirname(target), workspaceDir); } catch {}
  }
  return { deleted };
}
function looksLikeManagedResultDirectory(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const summary = readJson(path.join(dir, 'ringkasan.json'));
  if (summary?.applicationManaged) return true;
  return fs.existsSync(path.join(dir, '03-Hasil', 'data-siap-analisis.csv')) || fs.existsSync(path.join(dir, 'data-bersih-standar.csv'));
}
function clearManagedHistoryResults(workspaceDir) {
  let deleted = 0;
  const root = path.join(workspaceDir, 'Dataset');
  if (fs.existsSync(root)) {
    for (const objectEntry of fs.readdirSync(root, { withFileTypes:true })) {
      if (!objectEntry.isDirectory()) continue;
      const objectDir = path.join(root, objectEntry.name);
      for (const sessionEntry of fs.readdirSync(objectDir, { withFileTypes:true })) {
        if (!sessionEntry.isDirectory()) continue;
        const sessionDir = path.join(objectDir, sessionEntry.name);
        if (!looksLikeManagedResultDirectory(sessionDir)) continue;
        try { fs.rmSync(sessionDir,{recursive:true,force:true}); deleted += 1; } catch {}
      }
      try { if (fs.existsSync(objectDir) && fs.readdirSync(objectDir).length === 0) fs.rmdirSync(objectDir); } catch {}
    }
    try { if (fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root); } catch {}
  }
  // Bersihkan layout lama yang dikelola aplikasi.
  if (fs.existsSync(workspaceDir)) {
    for (const entry of fs.readdirSync(workspaceDir, { withFileTypes:true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(workspaceDir, entry.name);
      if (/^.+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?$/.test(entry.name) && looksLikeManagedResultDirectory(target)) {
        try { fs.rmSync(target,{recursive:true,force:true}); deleted += 1; } catch {}
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        for (const child of fs.readdirSync(target, { withFileTypes:true })) {
          if (!child.isDirectory()) continue;
          const childDir = path.join(target, child.name);
          if (!looksLikeManagedResultDirectory(childDir)) continue;
          try { fs.rmSync(childDir,{recursive:true,force:true}); deleted += 1; } catch {}
        }
        try { if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target); } catch {}
      }
    }
  }
  for (const legacyRoot of [path.join(workspaceDir,'Hasil'), path.join(workspaceDir,'Exports')]) {
    if (fs.existsSync(legacyRoot)) { fs.rmSync(legacyRoot,{recursive:true,force:true}); deleted += 1; }
  }
  return { deleted };
}
module.exports = { managedResultsRoot, managedResultDirectory, legacyResultDirectories, ensureManagedRunResults, deleteManagedRunResults, clearManagedHistoryResults, runToken, directoryHasFiles, extractRunDateTime, resultFolderBaseName };
