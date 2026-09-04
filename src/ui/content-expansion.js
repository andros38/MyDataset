(function contentExpansionModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.MyDatasetContentExpansion = api; root.PetikDataContentExpansion = api; root.CrawlLoomContentExpansion = api; }
})(typeof window !== 'undefined' ? window : null, function createContentExpansionApi() {
  const EXPANSION_LABELS = [
    'selengkapnya',
    'lihat selengkapnya',
    'baca selengkapnya',
    'tampilkan selengkapnya',
    'read more',
    'show more',
    'see more',
    'view more',
    'continue reading'
  ];
  const COLLAPSE_LABELS = [
    'lihat lebih sedikit', 'baca lebih sedikit', 'tampilkan lebih sedikit',
    'read less', 'show less', 'see less', 'view less'
  ];
  const CONTENT_CONTROL_LABELS = [...EXPANSION_LABELS, ...COLLAPSE_LABELS]
    .sort((a, b) => b.length - a.length);

  function normalizeLabel(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\u2026\s]+|[.\u2026\s]+$/g, '')
      .toLocaleLowerCase('id-ID');
  }

  function hasTruncationMarker(value) {
    const text = String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    const normalized = normalizeLabel(text);
    return EXPANSION_LABELS.some(label => normalized === label || normalized.endsWith(` ${label}`));
  }

  function stripContentControlLabels(value) {
    let text = String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    let changed = true;
    while (changed && text) {
      changed = false;
      for (const label of CONTENT_CONTROL_LABELS) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const next = text.replace(new RegExp(`(?:\\s*(?:\\.{2,}|\\u2026+|[·•|–—-]+)\\s*)?${escaped}\\s*$`, 'iu'), '').trim();
        if (next !== text) { text = next; changed = true; break; }
      }
    }
    return text;
  }

  async function expansionRuntime(config) {
    const cfg = config && typeof config === 'object' ? config : {};
    const itemSelector = String(cfg.itemSelector || '').trim();
    const maxControls = Math.max(1, Math.min(200, Number(cfg.maxControls) || 80));
    const waitMs = Math.max(80, Math.min(5000, Number(cfg.waitMs) || 1500));
    const pollMs = Math.max(25, Math.min(250, Number(cfg.pollMs) || 70));
    const labels = [
      'selengkapnya', 'lihat selengkapnya', 'baca selengkapnya', 'tampilkan selengkapnya',
      'read more', 'show more', 'see more', 'view more', 'continue reading'
    ];
    const labelSet = new Set(labels);
    const normalize = value => String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\u2026\s]+|[.\u2026\s]+$/g, '')
      .toLocaleLowerCase('id-ID');
    const isExpansionLabel = value => labelSet.has(normalize(value));
    const controlLabel = node => {
      if (!node) return '';
      const values = [
        node.getAttribute && node.getAttribute('aria-label'),
        node.getAttribute && node.getAttribute('title'),
        node.innerText,
        node.textContent
      ];
      return values.find(isExpansionLabel) || '';
    };
    const hidden = node => {
      let current = node;
      for (let depth = 0; current && current.nodeType === 1 && depth < 16; depth += 1, current = current.parentElement) {
        if (current.getAttribute && current.getAttribute('aria-hidden') === 'true') return true;
        try {
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return true;
        } catch {}
      }
      return false;
    };
    const contentSelector = [
      '[data-testid*="review-comment" i]', '[data-testid*="review-content" i]',
      '[data-testid*="review-text" i]', '[data-testid*="comment" i]',
      '[class*="review_card_comment" i]', '[class*="review-comment" i]',
      '[class*="review_content" i]', '[class*="review-content" i]',
      '[class*="review_text" i]', '[class*="review-text" i]',
      '[class*="comment_content" i]', '[class*="comment-content" i]',
      '[class*="reviewbody" i]', '[class*="review-body" i]'
    ].join(',');
    const candidateSelector = [
      '[data-testid*="read-more" i]', '[data-testid*="show-more" i]',
      '[aria-label*="read more" i]', '[aria-label*="selengkapnya" i]',
      '[class*="read_more" i]', '[class*="read-more" i]', '[class*="readmore" i]',
      'button', 'a', '[role="button"]', 'span'
    ].join(',');
    const cleanText = value => {
      let text = String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      for (const label of [...labels].sort((a, b) => b.length - a.length)) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`(?:\\s*[.\\u2026]+\\s*)?${escaped}\\s*$`, 'i'), '').trim();
      }
      return text;
    };
    const findContent = (rootNode, control) => {
      if (control) {
        const closest = control.closest && control.closest(contentSelector);
        if (closest && rootNode.contains(closest)) return closest;
        let current = control.parentElement;
        for (let depth = 0; current && current !== rootNode && depth < 5; depth += 1, current = current.parentElement) {
          const text = cleanText(current.innerText || current.textContent || '');
          if (text.length > 12) return current;
        }
      }
      const candidates = [...rootNode.querySelectorAll(contentSelector)];
      candidates.sort((a, b) => cleanText(b.innerText || b.textContent || '').length - cleanText(a.innerText || a.textContent || '').length);
      return candidates[0] || rootNode;
    };
    const findControl = rootNode => {
      const candidates = [...rootNode.querySelectorAll(candidateSelector)];
      return candidates.find(node => !hidden(node) && Boolean(controlLabel(node))) || null;
    };
    const allRoots = itemSelector ? [...document.querySelectorAll(itemSelector)] : [];
    const rootEntries = allRoots
      .map((node, index) => ({ node, index }))
      .filter(entry => entry.node && entry.node.isConnected && !hidden(entry.node));
    const result = {
      found: 0,
      expanded: 0,
      failed: 0,
      unresolvedRecordIndexes: [],
      expandedRecordIndexes: [],
      labels: []
    };

    const prepared = [];
    for (const entry of rootEntries) {
      if (prepared.length >= maxControls) break;
      const currentRoot = () => entry.node && entry.node.isConnected
        ? entry.node
        : [...document.querySelectorAll(itemSelector)][entry.index] || null;
      const rootNode = currentRoot();
      const control = rootNode ? findControl(rootNode) : null;
      if (!rootNode || !control) continue;
      const label = normalize(controlLabel(control));
      const contentBefore = findContent(rootNode, control);
      const before = cleanText(contentBefore && (contentBefore.innerText || contentBefore.textContent || ''));
      prepared.push({ entry, currentRoot, control, label, before });
    }

    const outcomes = await Promise.all(prepared.map(async task => {
      let clickError = false;
      try {
        if (typeof task.control.click === 'function') task.control.click();
        else task.control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch {
        clickError = true;
      }
      const started = Date.now();
      while (!clickError && Date.now() - started < waitMs) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        const rootNode = task.currentRoot();
        if (!rootNode) break;
        const control = findControl(rootNode);
        const contentAfter = findContent(rootNode, control);
        const after = cleanText(contentAfter && (contentAfter.innerText || contentAfter.textContent || ''));
        if (after.length > task.before.length && (!control || normalize(controlLabel(control)) !== task.label)) {
          return { ...task, succeeded: true };
        }
      }
      return { ...task, succeeded: false };
    }));

    result.found = outcomes.length;
    for (const outcome of outcomes) {
      if (outcome.label && !result.labels.includes(outcome.label)) result.labels.push(outcome.label);
      if (outcome.succeeded) {
        result.expanded += 1;
        result.expandedRecordIndexes.push(outcome.entry.index);
      } else {
        result.failed += 1;
        result.unresolvedRecordIndexes.push(outcome.entry.index);
      }
    }
    return result;
  }

  function buildExpansionScript(config) {
    const safeConfig = config && typeof config === 'object' ? config : {};
    return `(${expansionRuntime.toString()})(${JSON.stringify(safeConfig)})`;
  }

  return {
    EXPANSION_LABELS: [...EXPANSION_LABELS],
    COLLAPSE_LABELS: [...COLLAPSE_LABELS],
    CONTENT_CONTROL_LABELS: [...CONTENT_CONTROL_LABELS],
    normalizeLabel,
    hasTruncationMarker,
    stripContentControlLabels,
    buildExpansionScript
  };
});
