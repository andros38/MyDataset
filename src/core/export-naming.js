const { websiteNameFromUrl } = require('./source-context');

function safeFileName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim() || 'MyDataset';
}

function filenameToken(value, fallback = '') {
  const clean = safeFileName(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

function scrapedStamp(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):?(\d{2}):?(\d{2})/);
  return match ? { date: match[1], time: match[2] + '-' + match[3] + '-' + match[4] } : null;
}

function exportStampFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const stamp = scrapedStamp(row?._scrapedAt);
    if (stamp) return stamp;
  }
  return null;
}

function dateOnlyLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function timeOnlyLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
}

function formatLocalDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  return dateOnlyLocal(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + offset;
}

function fallbackStamp(runState = null) {
  const date = new Date(runState?.startedAt || new Date());
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return { date: dateOnlyLocal(valid), time: timeOnlyLocal(valid) };
}


function displaySiteToken(value = '') {
  const raw = String(value || '').trim();
  if (/traveloka/i.test(raw)) return 'Traveloka';
  if (/tiket/i.test(raw)) return 'Tiket';
  if (/agoda/i.test(raw)) return 'Agoda';
  if (/trip/i.test(raw)) return 'Trip';
  if (/booking/i.test(raw)) return 'Booking';
  return filenameToken(raw, 'Sumber');
}

function buildCombinedExportBaseName({ name = 'Dataset Gabungan', rows = [], manifest = null, dataset = 'clean-standard', countOverride = null } = {}) {
  const sources = Array.isArray(manifest?.composition?.clean?.bySource)
    ? manifest.composition.clean.bySource.map(item => item?.source).filter(Boolean)
    : [...new Set((rows || []).map(row => row?.source_site).filter(Boolean))];
  const preferredOrder = new Map([['Traveloka',0],['Tiket',1],['Agoda',2],['Trip',3],['Booking',4]]);
  const sourceToken = sources.map(displaySiteToken).filter(Boolean).sort((a,b)=>(preferredOrder.get(a)??99)-(preferredOrder.get(b)??99)||a.localeCompare(b)).join('-');
  const stamp = fallbackStamp(manifest?.createdAt ? { startedAt: manifest.createdAt } : null);
  const explicitCount = Number(countOverride);
  const count = Number.isFinite(explicitCount) && countOverride != null ? explicitCount : (Array.isArray(rows) ? rows.length : 0);
  const parts = [filenameToken(name || 'Dataset Gabungan', 'Dataset-Gabungan')];
  if (sourceToken) parts.push(filenameToken(sourceToken));
  parts.push(stamp.date, stamp.time);
  if (dataset) parts.push(filenameToken(dataset, 'clean-standard').toLowerCase());
  parts.push(String(count) + '-data');
  return safeFileName(parts.filter(Boolean).join('_'));
}

function buildExportBaseName({ rows = [], projectName = '', startUrl = '', runState = null, objectName = '', siteName = '', dataset = '', countOverride = null } = {}) {
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const source = first?._sourceUrl || startUrl || runState?.sourceUrl || runState?.currentUrl || '';
  const object = first?._objectName || objectName || runState?.objectName || '';
  const site = siteName || runState?.siteName || websiteNameFromUrl(source) || '';
  const genericProject = /^(?:proyek baru|new project|proyek|project)$/i.test(String(projectName || '').trim());
  const primary = object || (!genericProject ? projectName : '') || site || 'Website';
  const stamp = exportStampFromRows(rows) || fallbackStamp(runState);
  const explicitCount = Number(countOverride);
  const count = Number.isFinite(explicitCount) && countOverride != null
    ? explicitCount
    : (Array.isArray(rows) && rows.length ? rows.length : Number(runState?.itemsCollected || 0));
  const parts = [filenameToken(primary, 'Website')];
  if (site && filenameToken(site).toLowerCase() !== filenameToken(primary).toLowerCase()) parts.push(filenameToken(site));
  parts.push(stamp.date, stamp.time);
  if (dataset) parts.push(filenameToken(dataset, 'clean').toLowerCase());
  parts.push(String(count) + '-data');
  return safeFileName(parts.filter(Boolean).join('_'));
}

module.exports = {
  safeFileName,
  filenameToken,
  websiteNameFromUrl,
  scrapedStamp,
  exportStampFromRows,
  dateOnlyLocal,
  timeOnlyLocal,
  formatLocalDateTime,
  buildExportBaseName,
  buildCombinedExportBaseName,
  displaySiteToken
};
