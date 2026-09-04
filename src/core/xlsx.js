const zlib = require('zlib');

function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colName(index) {
  let n = index + 1; let out = '';
  while (n > 0) { n -= 1; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zip(entries) {
  const local = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'));
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(0, 6); localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10); localHeader.writeUInt16LE(0, 12); localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18); localHeader.writeUInt32LE(raw.length, 22); localHeader.writeUInt16LE(name.length, 26); localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(20, 4); centralHeader.writeUInt16LE(20, 6); centralHeader.writeUInt16LE(0, 8); centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12); centralHeader.writeUInt16LE(0, 14); centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20); centralHeader.writeUInt32LE(raw.length, 24); centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); centralHeader.writeUInt16LE(0, 32); centralHeader.writeUInt16LE(0, 34); centralHeader.writeUInt16LE(0, 36); centralHeader.writeUInt32LE(0, 38); centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, end]);
}

function isIdentifier(header) {
  return /(?:^|_)(?:id|uuid|key)$/i.test(String(header || '')) || /^(?:review_id|reviewer_id)$/i.test(String(header || ''));
}
function isNumericField(header) {
  return /(?:score|max|normalized|count|page)$/i.test(String(header || '')) && !isIdentifier(header);
}
function widthFor(header, rows) {
  const values = rows.slice(0, 200).map(row => String(row?.[header] ?? ''));
  const max = Math.max(String(header).length, ...values.map(v => v.length));
  if (/review_text|original_text|reply_text/i.test(header)) return 42;
  if (/url/i.test(header)) return 34;
  if (/date|datetime|timestamp/i.test(header)) return Math.min(26, Math.max(14, max + 2));
  return Math.min(28, Math.max(10, max + 2));
}

function buildXlsx(rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const headers = options.headers?.length ? options.headers : [...new Set(safeRows.flatMap(row => Object.keys(row || {})))];
  const columns = headers.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${widthFor(h, safeRows)}" customWidth="1"/>`).join('');
  const rowXml = [];
  const headerCells = headers.map((h, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${xmlEscape(h)}</t></is></c>`).join('');
  rowXml.push(`<row r="1" ht="22" customHeight="1">${headerCells}</row>`);
  safeRows.forEach((row, rIndex) => {
    const r = rIndex + 2;
    const cells = headers.map((header, cIndex) => {
      const ref = `${colName(cIndex)}${r}`;
      const value = row?.[header];
      if (value == null || value === '') return `<c r="${ref}"/>`;
      if (isNumericField(header) && typeof value !== 'boolean' && Number.isFinite(Number(value))) return `<c r="${ref}" s="0"><v>${Number(value)}</v></c>`;
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const style = isIdentifier(header) ? 2 : 0;
      return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
    }).join('');
    rowXml.push(`<row r="${r}">${cells}</row>`);
  });
  const lastCol = colName(Math.max(0, headers.length - 1));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${rowXml.join('')}</sheetData><autoFilter ref="A1:${lastCol}${Math.max(1, safeRows.length + 1)}"/></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF305D8C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dataset" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  return zip([
    { name: '[Content_Types].xml', data: types }, { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook }, { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles }, { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
}

module.exports = { buildXlsx, isIdentifier, isNumericField };
