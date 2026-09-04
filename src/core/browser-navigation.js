function normalizedHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/i.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function sameNavigationTarget(a, b) {
  const left = normalizedHttpUrl(a);
  const right = normalizedHttpUrl(b);
  if (!left || !right) return false;
  try {
    const l = new URL(left); const r = new URL(right);
    return l.origin === r.origin && (l.pathname === r.pathname || l.href === r.href);
  } catch {
    return false;
  }
}

function classifyLoadFailure(event = {}, activeUrl = '') {
  const code = Number(event.errorCode);
  const description = String(event.errorDescription || '');
  const failedUrl = String(event.validatedURL || '');
  // Chromium can emit failures for subframes/resources while the top-level page
  // is perfectly usable. Those must never replace the main browser status.
  if (event.isMainFrame === false) return { actionable: false, reason: 'subframe' };
  // -3 is ERR_ABORTED: normal during redirects, SPA transitions, or stop/reload.
  if (code === -3 || /ERR_ABORTED/i.test(description)) return { actionable: false, reason: 'aborted' };
  // Ignore stale failures from a previous navigation once the active tab has
  // already committed to a different URL.
  if (failedUrl && activeUrl && normalizedHttpUrl(failedUrl) && normalizedHttpUrl(activeUrl) && !sameNavigationTarget(failedUrl, activeUrl)) {
    return { actionable: false, reason: 'stale-navigation' };
  }
  const dns = code === -105 || /ERR_NAME_NOT_RESOLVED/i.test(description);
  return {
    actionable: true,
    reason: dns ? 'dns' : 'main-frame',
    code,
    description,
    failedUrl,
    message: dns ? 'Alamat domain tidak dapat ditemukan oleh DNS.' : (description || 'Halaman gagal dimuat.')
  };
}

module.exports = { normalizedHttpUrl, sameNavigationTarget, classifyLoadFailure };
