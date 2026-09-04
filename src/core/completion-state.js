function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizedProfile(context = {}) {
  const direct = String(context.siteProfile || context.sourceProfile || '').trim().toLowerCase();
  if (direct) return direct;
  const source = String(context.sourceUrl || context.url || '').toLowerCase();
  if (/tiket\.com/.test(source)) return 'tiket';
  if (/trip\.com/.test(source)) return 'trip';
  if (/agoda\./.test(source)) return 'agoda';
  return '';
}

function tiketNoNextTerminalEvidence(state = {}, context = {}) {
  const pageNumber = finitePositive(state.pageNumber);
  const lastPageNumber = finitePositive(state.lastPageNumber);
  const itemCount = finitePositive(state.itemCount) || 0;
  const previousItemCount = finitePositive(context.previousItemCount) || 0;
  const numericPageControlCount = Math.max(0, Number(state.numericPageControlCount || 0));
  const configuredNextControlCount = Math.max(0, Number(state.configuredNextControlCount || 0));
  const nextControlCount = Math.max(0, Number(state.nextControlCount || 0));
  const pageNumberSource = String(state.pageNumberSource || '');
  const strongPageMarker = ['tiket-active-step', 'tiket-visual-active'].includes(pageNumberSource);
  const atRenderedLastPage = pageNumber != null && lastPageNumber != null && pageNumber === lastPageNumber;
  const shortFinalPage = previousItemCount > 0 && itemCount > 0 && itemCount < previousItemCount;
  return {
    matches: Boolean(
      itemCount > 0 &&
      strongPageMarker &&
      atRenderedLastPage &&
      shortFinalPage &&
      numericPageControlCount >= 2 &&
      nextControlCount === 0 &&
      configuredNextControlCount === 0
    ),
    pageNumber,
    lastPageNumber,
    itemCount,
    previousItemCount,
    numericPageControlCount,
    configuredNextControlCount,
    nextControlCount,
    pageNumberSource
  };
}

/**
 * Decide whether the current page itself contains high-confidence evidence that
 * the source has ended, without clicking or changing the source page.
 *
 * Generic sources remain deliberately conservative: the accepted proof is an
 * explicitly disabled Next control. Tiket receives one additional source-specific
 * proof because its paginator removes the selected chevron on the terminal page.
 * That proof is accepted only after repeated read-only samples agree on a strong
 * active page marker, the highest rendered numeric page, a short final page, and
 * the complete absence of both semantic and configured Next controls.
 */
function inspectTerminalStateAtStepLimit(state = {}, context = {}) {
  const itemCount = finitePositive(state.itemCount) || 0;
  const pageNumber = finitePositive(state.pageNumber);
  const nextControlCount = Math.max(0, Number(state.nextControlCount || 0));
  const explicitlyDisabledNext = state.nextDisabled === true || state.atLastPage === true || state.configuredNextDisabled === true;

  if (itemCount > 0 && explicitlyDisabledNext) {
    return {
      confirmed: true,
      code: 'PAGINATION_END_REACHED',
      evidence: 'EXPLICIT_NEXT_DISABLED',
      pageNumber,
      itemCount,
      nextControlCount,
      message: `Akhir sumber terverifikasi${pageNumber ? ` pada halaman ${pageNumber}` : ''}: kontrol halaman berikutnya tersedia tetapi dinonaktifkan oleh sumber.`
    };
  }

  const profile = normalizedProfile(context);
  if (profile === 'tiket') {
    const samples = Array.isArray(context.samples) && context.samples.length ? context.samples : [state];
    const evidence = samples.map(sample => tiketNoNextTerminalEvidence(sample, context));
    const valid = evidence.length >= 3 && evidence.every(item => item.matches);
    const first = evidence[0];
    const samePage = valid && evidence.every(item => item.pageNumber === first.pageNumber && item.lastPageNumber === first.lastPageNumber);
    const sameCount = valid && evidence.every(item => item.itemCount === first.itemCount);
    if (valid && samePage && sameCount) {
      return {
        confirmed: true,
        code: 'PAGINATION_END_REACHED',
        evidence: 'TIKET_STABLE_LAST_PAGE_NO_NEXT',
        pageNumber: first.pageNumber,
        itemCount: first.itemCount,
        nextControlCount: 0,
        message: `Akhir sumber Tiket terverifikasi pada halaman ${first.pageNumber}: tiga inspeksi read-only konsisten menunjukkan halaman numerik terakhir, halaman akhir lebih pendek dari halaman sebelumnya, dan kontrol Next tidak lagi tersedia.`
      };
    }
  }

  return {
    confirmed: false,
    code: null,
    evidence: nextControlCount === 0 ? 'NO_EXPLICIT_NEXT_EVIDENCE' : 'NEXT_STILL_AVAILABLE_OR_UNPROVEN',
    pageNumber,
    itemCount,
    nextControlCount,
    message: 'Akhir sumber belum dapat dibuktikan tanpa melakukan navigasi tambahan.'
  };
}

module.exports = { inspectTerminalStateAtStepLimit, tiketNoNextTerminalEvidence };
