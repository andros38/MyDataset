const UTF8_BOM = '\uFEFF';

function toCsv(rows, options = {}) {
  const includeBom = options.bom !== false;
  if (!Array.isArray(rows) || !rows.length) return includeBom ? UTF8_BOM : '';
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const esc = value => {
    const str = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const body = [
    headers.map(esc).join(','),
    ...rows.map(row => headers.map(h => esc(row[h])).join(','))
  ].join('\r\n');
  // U+FEFF becomes EF BB BF when written as UTF-8. Excel detects this as UTF-8
  // instead of interpreting smart punctuation as Windows-1252 mojibake.
  return includeBom ? UTF8_BOM + body : body;
}

module.exports = { toCsv, UTF8_BOM };
