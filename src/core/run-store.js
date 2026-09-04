const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { internalPath, ensureInternalWorkspace } = require('./workspace-layout');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function positiveIntOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.trunc(numeric) : null;
}

function slugify(value) {
  return String(value || 'project')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64) || 'project';
}

function projectDirectoryName(value) {
  let name = String(value || 'Proyek Tanpa Nama')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  if (!name) name = 'Proyek Tanpa Nama';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `Proyek ${name}`;
  return name;
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function normalizeFingerprintValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return value
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeFingerprintValue(item)]));
  }
  return value;
}

function fingerprintScope(row, project = {}) {
  const objectName = normalizeFingerprintValue(row?._objectName || project?.source?.objectName || '');
  const source = String(row?._sourceUrl || project?.source?.sourceUrl || project?.startUrl || '').trim();
  let site = '';
  let pathname = '';
  try {
    const parsed = new URL(source);
    site = parsed.hostname.toLowerCase().replace(/^www\./, '');
    pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {}
  if (objectName) return `${site}|${String(objectName).toLocaleLowerCase('id-ID')}`;
  return source ? `${site}|${pathname}` : '';
}


function normalizeSemanticFingerprintText(value) {
  const normalized = normalizeFingerprintValue(value);
  if (normalized == null) return '';
  return String(normalized)
    .toLocaleLowerCase('id-ID')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSemanticValue(row, patterns) {
  if (!row || typeof row !== 'object') return '';
  for (const [key, value] of Object.entries(row)) {
    if (value == null || String(value).trim() === '') continue;
    if (patterns.some(pattern => pattern.test(String(key)))) return value;
  }
  return '';
}

// Secondary review fingerprint used only when the visible semantic content is
// strong enough to identify the same review safely. It intentionally ignores
// optional fields such as room_type, stay_detail, or a missing review_date,
// because those values can change or disappear between pagination renders.
function semanticReviewDescriptor(row, project = {}) {
  const scope = fingerprintScope(row, project);
  const text = normalizeSemanticFingerprintText(firstSemanticValue(row, [
    /^review_text$/i, /^review_content$/i, /^comment_text$/i, /^comment$/i, /(?:review|comment).*(?:text|content|body)$/i
  ]));
  if (!text) return null;

  const reviewer = normalizeSemanticFingerprintText(firstSemanticValue(row, [
    /^reviewer_name$/i, /^author_name$/i, /^username$/i, /^user_name$/i, /^guest_name$/i
  ]));
  const title = normalizeSemanticFingerprintText(firstSemanticValue(row, [
    /^review_title$/i, /^comment_title$/i, /^title$/i
  ]));
  const ratingRaw = normalizeSemanticFingerprintText(firstSemanticValue(row, [
    /^rating_score$/i, /^review_score$/i, /^score$/i, /^rating$/i
  ]));
  const numericRating = Number(String(ratingRaw).replace(',', '.'));
  const rating = ratingRaw && Number.isFinite(numericRating) ? String(numericRating) : ratingRaw;
  const date = normalizeSemanticFingerprintText(firstSemanticValue(row, [
    /^review_date$/i, /^review_date_raw$/i, /^date$/i, /^reviewdate$/i
  ]));

  // Long review text + reviewer + rating is sufficiently specific even when
  // the date selector failed on one page. Short reviews need more anchors.
  let strong = false;
  let includeDate = false;
  let includeTitle = false;
  if (text.length >= 28 && reviewer && rating) strong = true;
  else if (text.length >= 60 && (reviewer || title) && rating) strong = true;
  else if (text.length >= 12 && reviewer && rating && date) { strong = true; includeDate = true; }
  else if (text.length >= 8 && reviewer && title && rating && date) { strong = true; includeDate = true; includeTitle = true; }
  if (!strong) return null;

  const payload = {
    _scope: scope,
    review_text: text,
    reviewer_name: reviewer || null,
    rating_score: rating || null
  };
  if (includeTitle && title) payload.review_title = title;
  if (includeDate && date) payload.review_date = date;
  return {
    fingerprint: crypto.createHash('sha256').update(stableStringify(payload)).digest('hex'),
    method: 'semantic-review',
    confidence: 'possible',
    scope,
    payload
  };
}

function fingerprintDescriptor(row, fields, project = {}) {
  const configured = Array.isArray(fields) && fields.length ? fields.map(f => f.name) : Object.keys(row || {}).filter(k => !k.startsWith('_'));
  // Identitas record yang ditemukan otomatis tidak harus menjadi field konfigurasi pengguna.
  // Karena itu cari ID kanonis pada seluruh row lebih dulu, lalu fallback ke field pengguna.
  const allNames = [...new Set([...Object.keys(row || {}), ...configured])];
  const canonicalId = allNames.find(name => /^(?:review|comment|writing|item|record|product)_?id$/i.test(String(name)) && row?.[name] != null && String(row[name]).trim() !== '');
  const scope = fingerprintScope(row, project);
  const payload = { _scope: scope };
  let method = 'composite-sha256';
  let confidence = 'possible';
  if (canonicalId) {
    payload._identityField = String(canonicalId).toLowerCase();
    payload._identityValue = normalizeFingerprintValue(row[canonicalId]);
    method = 'site-id';
    confidence = 'exact';
  } else {
    const values = [];
    for (const name of configured) {
      payload[name] = normalizeFingerprintValue(row?.[name] ?? null);
      if (payload[name] != null && String(payload[name]).trim() !== '') values.push({ name, value: payload[name] });
    }
    const reviewLike = configured.some(name => /review|comment|rating|travell?er/i.test(String(name)));
    const textEntry = values.find(entry => /(?:review|comment).*(?:text|content|body)|(?:text|content|body)$/i.test(String(entry.name)));
    const textLength = typeof textEntry?.value === 'string' ? textEntry.value.length : 0;
    if (reviewLike) {
      // Untuk review, hanya ID sumber yang sama boleh dianggap duplikat pasti.
      // Kemiripan isi tanpa ID sumber tetap kandidat agar record sah tidak terhapus otomatis.
      confidence = 'possible';
    } else {
      confidence = values.length >= 2 || (values.length === 1 && String(values[0].value).length >= 16) ? 'exact' : 'possible';
    }
  }
  return {
    fingerprint: crypto.createHash('sha256').update(stableStringify(payload)).digest('hex'),
    method,
    confidence,
    identityField: canonicalId || null,
    scope,
    payload
  };
}

function fingerprintRow(row, fields, project = {}) {
  return fingerprintDescriptor(row, fields, project).fingerprint;
}

function newRunId(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `Run ${stamp}`;
}


function newSessionId(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SES-${stamp}-${suffix}`;
}

function legacySessionId(runDir = '', state = {}) {
  const source = String(state.runId || runDir || state.startedAt || 'legacy');
  return `SES-LEGACY-${crypto.createHash('sha1').update(source).digest('hex').slice(0,8).toUpperCase()}`;
}

function availableRunDirectory(runsDir, now = new Date()) {
  const base = newRunId(now);
  let candidate = path.join(runsDir, base);
  let copy = 2;
  while (fs.existsSync(candidate)) candidate = path.join(runsDir, `${base} (${copy++})`);
  return candidate;
}

class RunStore {
  constructor({ workspaceDir, project, runDir = null, resume = false }) {
    if (!workspaceDir) throw new Error('workspaceDir wajib diisi.');
    if (!project || typeof project !== 'object') throw new Error('project wajib diisi.');

    this.project = project;
    this.projectSlug = slugify(project.name);
    this.projectFolder = projectDirectoryName(project.name);
    this.workspaceDir = workspaceDir;
    ensureInternalWorkspace(workspaceDir);
    this.projectDir = internalPath(workspaceDir, 'Projects', this.projectFolder);
    this.runDir = runDir || availableRunDirectory(path.join(this.projectDir, 'Runs'));
    this.statePath = path.join(this.runDir, 'state.json');
    // data.jsonl dipertahankan sebagai dataset clean agar run v0.29 tetap dapat
    // dilanjutkan tanpa migrasi destruktif.
    this.dataPath = path.join(this.runDir, 'data.jsonl');
    this.rawDataPath = path.join(this.runDir, 'raw-data.jsonl');
    this.duplicateDataPath = path.join(this.runDir, 'duplicates-data.jsonl');
    this.fingerprintPath = path.join(this.runDir, 'fingerprints.txt');
    this.projectSnapshotPath = path.join(this.runDir, 'project.snapshot.json');
    this.logPath = path.join(this.runDir, 'run.log.txt');
    this.sourceManifestPath = path.join(this.runDir, 'source-manifest.json');
    this.fingerprints = new Set();
    this.fingerprintIndex = new Map();
    this.semanticFingerprintIndex = new Map();

    ensureDir(this.runDir);

    if (resume && fs.existsSync(this.statePath)) {
      this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.state.schemaVersion = Math.max(5, Number(this.state.schemaVersion || 0));
      this.state.sessionId = this.state.sessionId || legacySessionId(this.runDir, this.state);
      this.state.confirmedSitePage = positiveIntOrNull(this.state.confirmedSitePage);
      this.state.expectedSitePage = positiveIntOrNull(this.state.expectedSitePage);
      const cleanRows = this.readRows();
      cleanRows.forEach((row, index) => {
        const descriptor = fingerprintDescriptor(row, project.fields, project);
        this.fingerprints.add(descriptor.fingerprint);
        const rowRef = `row-${String(index + 1).padStart(6, '0')}`;
        if (!this.fingerprintIndex.has(descriptor.fingerprint)) {
          this.fingerprintIndex.set(descriptor.fingerprint, {
            rowRef,
            page: row?._page ?? null,
            row,
            descriptor
          });
        }
        const semantic = semanticReviewDescriptor(row, project);
        if (semantic && !this.semanticFingerprintIndex.has(semantic.fingerprint)) {
          this.semanticFingerprintIndex.set(semantic.fingerprint, {
            rowRef,
            page: row?._page ?? null,
            row,
            descriptor: semantic
          });
        }
      });
      if (!fs.existsSync(this.rawDataPath)) {
        fs.writeFileSync(this.rawDataPath, cleanRows.map(row => JSON.stringify(row)).join('\n') + (cleanRows.length ? '\n' : ''), 'utf8');
      }
      if (!fs.existsSync(this.duplicateDataPath)) fs.writeFileSync(this.duplicateDataPath, '', 'utf8');
      if (!fs.existsSync(this.fingerprintPath)) {
        fs.writeFileSync(this.fingerprintPath, [...this.fingerprints].map(value => `${value}\n`).join(''), 'utf8');
      }
      // The JSONL file is authoritative. If the process stopped between an
      // append and the next checkpoint, recover the correct collected count.
      if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, '', 'utf8');
      this.state.schemaVersion = Math.max(4, Number(this.state.schemaVersion || 0));
      this.state.currentStep = Number(this.state.currentStep || this.state.currentPage || 1);
      this.state.confirmedSitePage = positiveIntOrNull(this.state.confirmedSitePage);
      this.state.expectedSitePage = positiveIntOrNull(this.state.expectedSitePage) ?? this.state.confirmedSitePage;
      this.state.pageFingerprints = Array.isArray(this.state.pageFingerprints) ? this.state.pageFingerprints.slice(-600) : [];
      this.state.contentFingerprints = Array.isArray(this.state.contentFingerprints) ? this.state.contentFingerprints.slice(-600) : [];
      this.state.pageHistory = Array.isArray(this.state.pageHistory) ? this.state.pageHistory.slice(-600) : [];
      this.state.lastPageItemKeys = Array.isArray(this.state.lastPageItemKeys) ? this.state.lastPageItemKeys.slice(-500) : [];
      this.state.paginationRecoveryCount = Number(this.state.paginationRecoveryCount || 0);
      this.state.failure = this.state.failure && typeof this.state.failure === 'object' ? this.state.failure : null;
      this.state.siteProfile = this.state.siteProfile || project.siteProfile || '';
      this.state.acquisitionMethod = this.state.acquisitionMethod || project.acquisition?.method || 'dom';
      this.state.itemsCollected = cleanRows.length;
      const identityCounts = cleanRows.reduce((acc, row) => {
        const reviewId = String(row?.review_id ?? row?.reviewId ?? row?.id ?? '').trim();
        const synthetic = String(row?._reviewIdSource || '').toLowerCase() === 'synthetic' || /^synthetic:/i.test(reviewId);
        if (synthetic) acc.synthetic += 1;
        else if (reviewId) acc.native += 1;
        else acc.missing += 1;
        return acc;
      }, { native: 0, synthetic: 0, missing: 0 });
      this.state.nativeReviewIds = identityCounts.native;
      this.state.syntheticReviewIds = identityCounts.synthetic;
      this.state.missingReviewIds = identityCounts.missing;
      this.state.rawItemsRead = Math.max(Number(this.state.rawItemsRead || 0), this.readRows({ dataset: 'raw' }).length);
      this.state.exactDuplicates = Number(this.state.exactDuplicates ?? this.state.duplicatesSkipped ?? 0);
      this.state.possibleDuplicates = Number(this.state.possibleDuplicates || 0);
      this.state.duplicatesSkipped = this.state.exactDuplicates;
      this.state.status = 'resuming';
      this.state.updatedAt = new Date().toISOString();
      this.persistState();
    } else {
      const now = new Date().toISOString();
      this.state = {
        schemaVersion: 5,
        runId: path.basename(this.runDir),
        sessionId: newSessionId(),
        projectName: project.name || 'Proyek',
        projectSlug: this.projectSlug,
        projectFolder: this.projectFolder,
        status: 'created',
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        currentPage: 1,
        currentStep: 1,
        confirmedSitePage: null,
        expectedSitePage: null,
        pageCompleted: false,
        lastPageFingerprint: null,
        lastPageContentFingerprint: null,
        pageFingerprints: [],
        contentFingerprints: [],
        pageHistory: [],
        lastPageItemKeys: [],
        paginationRecoveryCount: 0,
        failure: null,
        completionReason: null,
        completionMessage: null,
        currentUrl: project.startUrl || '',
        sourceUrl: project.source?.sourceUrl || project.startUrl || '',
        objectName: project.source?.objectName || '',
        siteName: project.source?.siteName || '',
        siteProfile: project.siteProfile || '',
        acquisitionMethod: project.acquisition?.method || 'dom',
        itemsCollected: 0,
        rawItemsRead: 0,
        nativeReviewIds: 0,
        syntheticReviewIds: 0,
        missingReviewIds: 0,
        exactDuplicates: 0,
        possibleDuplicates: 0,
        duplicatesSkipped: 0,
        errors: 0,
        lastRecordFingerprint: null,
        lastMessage: 'Run dibuat.',
        error: null
      };
      if (!fs.existsSync(this.dataPath)) fs.writeFileSync(this.dataPath, '', 'utf8');
      if (!fs.existsSync(this.rawDataPath)) fs.writeFileSync(this.rawDataPath, '', 'utf8');
      if (!fs.existsSync(this.duplicateDataPath)) fs.writeFileSync(this.duplicateDataPath, '', 'utf8');
      if (!fs.existsSync(this.fingerprintPath)) fs.writeFileSync(this.fingerprintPath, '', 'utf8');
      if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, '', 'utf8');
      atomicWriteJson(this.projectSnapshotPath, project);
      atomicWriteJson(this.sourceManifestPath, {
        schemaVersion: 1,
        sessionId: this.state.sessionId,
        runId: this.state.runId,
        objectName: this.state.objectName,
        siteName: this.state.siteName,
        siteProfile: this.state.siteProfile,
        acquisitionMethod: this.state.acquisitionMethod,
        sourceUrl: this.state.sourceUrl,
        inputType: this.state.acquisitionMethod === 'har-network' ? 'har' : (this.state.acquisitionMethod === 'network-json' ? 'xhr-json' : 'browser-dom'),
        startedAt: this.state.startedAt,
        note: this.state.acquisitionMethod === 'har-network'
          ? 'HAR diproses lokal; metadata sumber dan hash dipertahankan.'
          : (this.state.acquisitionMethod === 'network-json'
              ? 'Response Network yang relevan disimpan sebagai data sumber.'
              : 'Provenance halaman dan konfigurasi run dipertahankan untuk sumber DOM.')
      });
      this.persistState();
    }
  }

  persistState() {
    this.state.updatedAt = new Date().toISOString();
    atomicWriteJson(this.statePath, this.state);
  }

  checkpoint(partial = {}) {
    Object.assign(this.state, partial);
    this.persistState();
    try {
      const existing = fs.existsSync(this.sourceManifestPath) ? JSON.parse(fs.readFileSync(this.sourceManifestPath, 'utf8')) : {};
      atomicWriteJson(this.sourceManifestPath, {
        ...existing,
        sessionId: this.state.sessionId,
        runId: this.state.runId,
        objectName: this.state.objectName || existing.objectName || '',
        siteName: this.state.siteName || existing.siteName || '',
        siteProfile: this.state.siteProfile || existing.siteProfile || '',
        acquisitionMethod: this.state.acquisitionMethod || existing.acquisitionMethod || 'dom',
        sourceUrl: this.state.sourceUrl || this.state.currentUrl || existing.sourceUrl || '',
        updatedAt: this.state.updatedAt
      });
    } catch {}
    return { ...this.state };
  }

  appendRawRow(row) {
    fs.appendFileSync(this.rawDataPath, `${JSON.stringify(row)}\n`, 'utf8');
    this.state.rawItemsRead += 1;
    return row;
  }

  appendRow(row, options = {}) {
    const descriptor = fingerprintDescriptor(row, this.project.fields, this.project);
    const fp = descriptor.fingerprint;
    const semantic = semanticReviewDescriptor(row, this.project);
    const primaryOriginal = this.fingerprintIndex.get(fp) || null;
    const semanticOriginal = semantic ? (this.semanticFingerprintIndex.get(semantic.fingerprint) || null) : null;

    // v0.98: duplikat pasti hanya berasal dari identitas sumber yang benar-benar sama
    // (misalnya review_id yang sama pada sumber yang sama). Kemiripan semantik tidak
    // lagi menghapus record; ia hanya menjadi kandidat audit.
    const exactOriginal = primaryOriginal && descriptor.confidence === 'exact' ? primaryOriginal : null;
    const possibleOriginal = exactOriginal ? null : (semanticOriginal || primaryOriginal || null);
    const original = exactOriginal || possibleOriginal || null;
    const duplicateDescriptor = exactOriginal ? descriptor : (semanticOriginal ? semantic : descriptor);
    const duplicateFingerprint = exactOriginal ? fp : (semanticOriginal ? semantic.fingerprint : fp);

    // Caller baru dapat merekam Data Mentah sebelum transformasi. Caller legacy
    // tetap kompatibel karena appendRow masih merekam raw secara default.
    if (options.recordRaw !== false) this.appendRawRow(row);

    if (original) {
      const exact = Boolean(exactOriginal);
      const audit = {
        ...row,
        _dedupeStatus: exact ? 'exact_duplicate' : 'possible_duplicate',
        _dedupeMethod: duplicateDescriptor.method,
        _dedupeFingerprint: duplicateFingerprint,
        _duplicateOf: original.rowRef,
        _originalPage: original.page,
        _duplicatePage: row?._page ?? null,
        _identityField: duplicateDescriptor.identityField || null,
        _dedupeScope: duplicateDescriptor.scope,
        _originalRecord: original.row || null,
        _detectedAt: new Date().toISOString()
      };
      fs.appendFileSync(this.duplicateDataPath, `${JSON.stringify(audit)}\n`, 'utf8');

      if (exact) {
        this.state.exactDuplicates += 1;
        this.state.duplicatesSkipped = this.state.exactDuplicates;
        return { added: false, fingerprint: duplicateFingerprint, duplicate: true, possibleDuplicate: false, audit };
      }

      // Kandidat lemah tetap masuk clean-data agar ulasan sah tidak hilang.
      this.state.possibleDuplicates += 1;
    }

    fs.appendFileSync(this.dataPath, `${JSON.stringify(row)}\n`, 'utf8');
    const rowRef = `row-${String(this.state.itemsCollected + 1).padStart(6, '0')}`;
    if (!this.fingerprints.has(fp)) {
      fs.appendFileSync(this.fingerprintPath, `${fp}\n`, 'utf8');
      this.fingerprints.add(fp);
      this.fingerprintIndex.set(fp, {
        rowRef,
        page: row?._page ?? null,
        row,
        descriptor
      });
    }
    if (semantic && !this.semanticFingerprintIndex.has(semantic.fingerprint)) {
      this.semanticFingerprintIndex.set(semantic.fingerprint, {
        rowRef,
        page: row?._page ?? null,
        row,
        descriptor: semantic
      });
    }
    const reviewId = String(row?.review_id ?? row?.reviewId ?? row?.id ?? '').trim();
    const syntheticReviewId = String(row?._reviewIdSource || '').toLowerCase() === 'synthetic' || /^synthetic:/i.test(reviewId);
    if (syntheticReviewId) this.state.syntheticReviewIds = Number(this.state.syntheticReviewIds || 0) + 1;
    else if (reviewId) this.state.nativeReviewIds = Number(this.state.nativeReviewIds || 0) + 1;
    else this.state.missingReviewIds = Number(this.state.missingReviewIds || 0) + 1;
    this.state.itemsCollected += 1;
    this.state.lastRecordFingerprint = fp;
    return {
      added: true,
      fingerprint: fp,
      duplicate: false,
      possibleDuplicate: Boolean(original),
      audit: original ? { status: 'possible_duplicate', duplicateOf: original.rowRef } : null
    };
  }


  appendLog(message) {
    const line = String(message ?? '').trimEnd();
    if (!line) return;
    fs.appendFileSync(this.logPath, `${line}\n`, 'utf8');
  }

  readLog() {
    if (!fs.existsSync(this.logPath)) return '';
    return fs.readFileSync(this.logPath, 'utf8');
  }

  datasetPath(dataset = 'clean') {
    if (dataset === 'raw') return this.rawDataPath;
    if (dataset === 'duplicates') return this.duplicateDataPath;
    return this.dataPath;
  }

  readRows({ limit = Infinity, offset = 0, dataset = 'clean' } = {}) {
    const filePath = this.datasetPath(dataset);
    if (!fs.existsSync(filePath)) return [];
    const rows = [];
    let seen = 0;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (seen++ < offset) continue;
      try { rows.push(JSON.parse(line)); } catch {}
      if (rows.length >= limit) break;
    }
    return rows;
  }

  datasetCounts() {
    return {
      clean: Number(this.state.itemsCollected || 0),
      raw: Number(this.state.rawItemsRead || 0),
      duplicates: Number(this.state.exactDuplicates || 0) + Number(this.state.possibleDuplicates || 0),
      exactDuplicates: Number(this.state.exactDuplicates || 0),
      possibleDuplicates: Number(this.state.possibleDuplicates || 0),
      nativeReviewIds: Number(this.state.nativeReviewIds || 0),
      syntheticReviewIds: Number(this.state.syntheticReviewIds || 0),
      missingReviewIds: Number(this.state.missingReviewIds || 0)
    };
  }

  markRunning(message = 'Scraping berjalan.') {
    return this.checkpoint({ status: 'running', lastMessage: message, error: null, failure: null });
  }

  markPaused(message = 'Run dijeda oleh pengguna.') {
    return this.checkpoint({ status: 'paused', lastMessage: message });
  }

  markInterrupted(message = 'Run terhenti sebelum selesai.') {
    return this.checkpoint({ status: 'interrupted', lastMessage: message });
  }

  markStopped(message = 'Dihentikan pengguna. Data parsial dipertahankan.') {
    return this.checkpoint({ status: 'stopped', finishedAt: new Date().toISOString(), lastMessage: message });
  }

  markFailed(error) {
    this.state.errors += 1;
    return this.checkpoint({ status: 'failed', error: String(error?.message || error || 'Unknown error'), lastMessage: 'Run gagal.' });
  }

  markCompleted(message = 'Scraping selesai.') {
    return this.checkpoint({ status: 'completed', finishedAt: new Date().toISOString(), completionReason: null, completionMessage: null, lastMessage: message, error: null, failure: null });
  }

  markCompletedPartial(message = 'Proses selesai dengan capture parsial.') {
    return this.checkpoint({ status: 'completed_partial', finishedAt: new Date().toISOString(), sourceEndReason: null, sourceEndMessage: null, completionReason: null, completionMessage: null, lastMessage: message, error: null, failure: null });
  }

  markCompletedSourceLimit(message = 'Selesai pada batas sumber.') {
    return this.checkpoint({ status: 'completed_source_limit', finishedAt: new Date().toISOString(), sourceEndReason: 'SOURCE_LIMIT_REACHED', completionReason: null, completionMessage: null, lastMessage: message, error: null, failure: null });
  }

  markCompletedStepLimit(message = 'Selesai sesuai batas langkah pengguna.') {
    return this.checkpoint({
      status: 'completed_step_limit',
      finishedAt: new Date().toISOString(),
      sourceEndReason: null,
      sourceEndMessage: null,
      completionReason: 'USER_STEP_LIMIT_REACHED',
      completionMessage: message,
      lastMessage: message,
      error: null,
      failure: null
    });
  }
}

function abandonRecoverableRuns(workspaceDir, projectName) {
  const projectSlug = slugify(projectName);
  const projectDirs = [...new Set([
    internalPath(workspaceDir, 'Projects', projectDirectoryName(projectName), 'Runs'),
    internalPath(workspaceDir, 'Projects', projectSlug, 'Runs'),
    internalPath(workspaceDir, 'Runs', projectSlug),
    // Legacy v0.98 and older locations remain readable.
    path.join(workspaceDir, 'Projects', projectDirectoryName(projectName), 'Runs'),
    path.join(workspaceDir, 'Projects', projectSlug, 'Runs'),
    path.join(workspaceDir, 'Runs', projectSlug)
  ])];
  const recoverable = new Set(['created', 'running', 'resuming', 'paused', 'interrupted', 'failed']);
  let changed = 0;
  for (const projectDir of projectDirs) {
    if (!fs.existsSync(projectDir)) continue;
    for (const runName of fs.readdirSync(projectDir)) {
      const statePath = path.join(projectDir, runName, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!recoverable.has(state.status)) continue;
        state.status = 'abandoned';
        state.finishedAt = state.finishedAt || new Date().toISOString();
        state.updatedAt = new Date().toISOString();
        state.lastMessage = 'Run ditinggalkan karena pengguna memulai ulang proyek.';
        atomicWriteJson(statePath, state);
        changed += 1;
      } catch {}
    }
  }
  return changed;
}

function listProjectRunDirectories(workspaceDir) {
  const directories = [];
  const runRoots = [internalPath(workspaceDir, 'Runs'), path.join(workspaceDir, 'Runs')];
  for (const root of runRoots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const candidate = path.join(root, name);
      try { if (fs.statSync(candidate).isDirectory()) directories.push(candidate); } catch {}
    }
  }
  const projectRoots = [internalPath(workspaceDir, 'Projects'), path.join(workspaceDir, 'Projects')];
  for (const projectsRoot of projectRoots) {
    if (!fs.existsSync(projectsRoot)) continue;
    for (const name of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, name, 'Runs');
      try { if (fs.statSync(candidate).isDirectory()) directories.push(candidate); } catch {}
    }
  }
  return [...new Set(directories.map(item => path.resolve(item)))];
}

function scanRuns(workspaceDir, { limit = 30 } = {}) {
  const states = [];
  for (const projectDir of listProjectRunDirectories(workspaceDir)) {
    for (const runName of fs.readdirSync(projectDir)) {
      const runDir = path.join(projectDir, runName);
      const statePath = path.join(runDir, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.status === 'running' || state.status === 'resuming') {
          state.status = 'interrupted';
          state.lastMessage = 'Aplikasi sebelumnya berhenti saat run masih berjalan.';
          state.updatedAt = new Date().toISOString();
          atomicWriteJson(statePath, state);
        }
        // Enrich legacy state from the immutable project snapshot so History can
        // always show provenance without rewriting old run data.
        if (!state.siteProfile || !state.acquisitionMethod) {
          try {
            const snapshotPath = path.join(runDir, 'project.snapshot.json');
            if (fs.existsSync(snapshotPath)) {
              const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
              state.siteProfile = state.siteProfile || snapshot.siteProfile || '';
              state.acquisitionMethod = state.acquisitionMethod || snapshot.acquisition?.method || (state.ingestionMode === 'network-json' ? 'network-json' : 'dom');
            }
          } catch {}
        }
        states.push({ ...state, runDir });
      } catch {}
    }
  }
  return states.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

function resolveRunHistoryDirectory(workspaceDir, runDir) {
  const candidate = String(runDir || '').trim();
  if (!candidate) throw new Error('Lokasi riwayat run tidak tersedia.');

  const target = path.resolve(candidate);
  const roots = [
    { root:path.resolve(internalPath(workspaceDir, 'Projects')), kind:'project' },
    { root:path.resolve(internalPath(workspaceDir, 'Runs')), kind:'legacy' },
    { root:path.resolve(workspaceDir, 'Projects'), kind:'project' },
    { root:path.resolve(workspaceDir, 'Runs'), kind:'legacy' }
  ];
  for (const entry of roots) {
    const relative = path.relative(entry.root, target);
    const parts = relative.split(path.sep).filter(Boolean);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const valid = entry.kind === 'project'
      ? inside && parts.length === 3 && parts[1].toLowerCase() === 'runs'
      : inside && parts.length === 2;
    if (valid) return { root:entry.root, target, projectDir:path.dirname(target) };
  }
  throw new Error('Lokasi riwayat run berada di luar penyimpanan internal MyDataset.');
}

function deleteRunHistoryEntry(workspaceDir, runDir) {
  const { target, projectDir } = resolveRunHistoryDirectory(workspaceDir, runDir);
  if (!fs.existsSync(target)) return { deleted: 0, missing: true };
  if (!fs.statSync(target).isDirectory()) throw new Error('Riwayat run bukan sebuah folder yang valid.');

  fs.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
  try {
    if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length === 0) fs.rmdirSync(projectDir);
  } catch {}
  return { deleted: 1, missing: false };
}

function clearRunHistory(workspaceDir) {
  const count = scanRuns(workspaceDir, { limit: Number.MAX_SAFE_INTEGER }).length;
  for (const runsRoot of [internalPath(workspaceDir, 'Runs'), path.resolve(workspaceDir, 'Runs')]) {
    if (fs.existsSync(runsRoot)) fs.rmSync(runsRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    if (runsRoot === internalPath(workspaceDir, 'Runs')) ensureDir(runsRoot);
  }
  for (const projectsRoot of [internalPath(workspaceDir, 'Projects'), path.resolve(workspaceDir, 'Projects')]) {
    if (!fs.existsSync(projectsRoot)) continue;
    for (const name of fs.readdirSync(projectsRoot)) {
      const runsDir = path.join(projectsRoot, name, 'Runs');
      try {
        if (fs.existsSync(runsDir)) fs.rmSync(runsDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        if (projectsRoot === internalPath(workspaceDir, 'Projects')) ensureDir(runsDir);
      } catch {}
    }
  }
  return { deleted: count };
}

module.exports = {
  RunStore,
  scanRuns,
  abandonRecoverableRuns,
  resolveRunHistoryDirectory,
  deleteRunHistoryEntry,
  clearRunHistory,
  slugify,
  projectDirectoryName,
  newRunId,
  newSessionId,
  atomicWriteJson,
  fingerprintDescriptor,
  semanticReviewDescriptor,
  fingerprintRow,
  fingerprintScope,
  normalizeFingerprintValue,
  stableStringify
};
