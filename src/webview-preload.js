const { ipcRenderer, webFrame } = require('electron');
const SelectorEngine = require('./core/selector-engine');
const { REVIEW_CAPTURE_SCRIPT } = require('./core/review-capture-script');

let selectMode = false;
let selectionTarget = null;
let lastHovered = null;
let lastHoverStyle = null;
const persistentHighlights = new Map();

installReviewPayloadCapture();

ipcRenderer.on('host-message', (_event, message) => {
  if (!message) return;

  if (message.type === 'selection-mode') {
    selectMode = Boolean(message.enabled);
    selectionTarget = selectMode ? (message.target || null) : null;
    document.documentElement.style.cursor = selectMode ? 'crosshair' : '';
    if (!selectMode) clearHover();
    return;
  }

  if (message.type === 'clear-highlights') {
    clearPersistentHighlights();
    return;
  }

  if (message.type === 'highlight-selector') {
    clearPersistentHighlights();
    highlightSelector(message.selector, message.color || '#21c77a');
    return;
  }

  if (message.type === 'highlight-relative') {
    clearPersistentHighlights();
    highlightRelative(message.rootSelector, message.fieldSelector, message.color || '#4d91ff');
  }
});

function clearHover() {
  if (lastHovered && lastHoverStyle) {
    lastHovered.style.outline = lastHoverStyle.outline;
    lastHovered.style.outlineOffset = lastHoverStyle.outlineOffset;
    lastHovered.style.backgroundColor = lastHoverStyle.backgroundColor;
  }
  lastHovered = null;
  lastHoverStyle = null;
}

function rememberPersistent(el) {
  if (persistentHighlights.has(el)) return;
  persistentHighlights.set(el, {
    outline: el.style.outline,
    outlineOffset: el.style.outlineOffset,
    boxShadow: el.style.boxShadow
  });
}

function clearPersistentHighlights() {
  for (const [el, previous] of persistentHighlights) {
    try {
      el.style.outline = previous.outline;
      el.style.outlineOffset = previous.outlineOffset;
      el.style.boxShadow = previous.boxShadow;
    } catch {}
  }
  persistentHighlights.clear();
}

function highlightElements(elements, color) {
  let index = 0;
  for (const el of elements) {
    if (!(el instanceof Element)) continue;
    rememberPersistent(el);
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '-2px';
    el.style.boxShadow = `0 0 0 2px ${color}22`;
    index += 1;
    if (index >= 300) break;
  }
}

function highlightSelector(selector, color) {
  if (!selector) return;
  try { highlightElements([...document.querySelectorAll(selector)], color); }
  catch {}
}

function highlightRelative(rootSelector, fieldSelector, color) {
  if (!rootSelector || !fieldSelector) return;
  try {
    const roots = [...document.querySelectorAll(rootSelector)];
    const matches = [];
    for (const root of roots) {
      if (fieldSelector === ':scope') matches.push(root);
      else {
        try { matches.push(...root.querySelectorAll(fieldSelector)); } catch {}
      }
    }
    highlightElements(matches, color);
  } catch {}
}

window.addEventListener('mouseover', event => {
  if (!selectMode) return;
  event.stopPropagation();
  const el = event.target;
  if (!(el instanceof Element) || lastHovered === el) return;
  clearHover();
  lastHovered = el;
  lastHoverStyle = {
    outline: el.style.outline,
    outlineOffset: el.style.outlineOffset,
    backgroundColor: el.style.backgroundColor
  };
  const color = selectionTarget === 'item' ? '#7c5cff' : selectionTarget === 'pagination' ? '#d8a542' : '#4d91ff';
  el.style.outline = `3px solid ${color}`;
  el.style.outlineOffset = '2px';
}, true);

window.addEventListener('mouseout', event => {
  if (!selectMode) return;
  if (event.target === lastHovered) clearHover();
}, true);

// Capture navigation that should leave the current embedded document. Trip.com
// sometimes renders hotel cards as JavaScript-driven containers: the clicked
// node is not necessarily the <a>, and target=_blank is not consistently present.
// Resolve a concrete hotel-detail URL before the site's SPA handler runs, then
// open it as a managed MyDataset tab. Ordinary same-tab links remain untouched.
function absoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || ''), location.href);
    return /^https?:$/i.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function isTripHotelDetailUrl(value) {
  try {
    const url = new URL(String(value || ''), location.href);
    if (!/(^|\.)trip\.com$/i.test(url.hostname) || !/^https?:$/i.test(url.protocol)) return false;
    const full = `${url.pathname}${url.search}`;
    return /hotel-detail-\d+/i.test(full)
      || /(?:hotel|property)[/_-]?(?:detail|info)/i.test(url.pathname)
      || /[?&](?:hotelId|hotel_id|masterHotelId|propertyId|property_id)=\d+/i.test(url.search);
  } catch { return false; }
}

function tripHotelDetailUrlFromClick(target, event = null) {
  if (!(target instanceof Element) || !/(^|\.)trip\.com$/i.test(location.hostname)) return '';
  const candidates = [];
  const add = value => {
    const href = absoluteHttpUrl(value);
    if (href && isTripHotelDetailUrl(href) && !candidates.includes(href)) candidates.push(href);
  };

  const nodes = [];
  try {
    for (const node of event?.composedPath?.() || []) if (node instanceof Element && !nodes.includes(node)) nodes.push(node);
  } catch {}
  let node = target;
  for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) if (!nodes.includes(node)) nodes.push(node);

  const likelyCard = nodes.find(el => {
    const blob = `${el.getAttribute?.('data-testid') || ''} ${el.getAttribute?.('data-element-name') || ''} ${el.className || ''}`;
    return /hotel|property|list.*card|search.*item/i.test(String(blob));
  }) || target.closest?.('article,li,[role="listitem"]');
  if (likelyCard && !nodes.includes(likelyCard)) nodes.push(likelyCard);

  for (const current of nodes) {
    if (!(current instanceof Element)) continue;
    if (current.matches?.('a[href]')) add(current.getAttribute('href') || current.href);
    for (const attr of ['href','data-href','data-url','data-link','data-target-url','data-jump-url','data-hotel-url','data-detail-url']) {
      const value = current.getAttribute?.(attr);
      if (value) add(value);
    }
    try {
      for (const anchor of [...current.querySelectorAll('a[href]')].slice(0,80)) add(anchor.getAttribute('href') || anchor.href);
    } catch {}
  }

  if (!candidates.length) {
    // Some Trip list cards keep the anchor outside the title's direct ancestry.
    // Use the clicked visible title as a last DOM-only lookup; no URL is invented.
    const clickedText = String(target.textContent || '').replace(/\s+/g,' ').trim();
    if (clickedText.length >= 3 && clickedText.length <= 140) {
      try {
        for (const anchor of [...document.querySelectorAll('a[href]')]) {
          const text = String(anchor.textContent || '').replace(/\s+/g,' ').trim();
          if (!text || !(text.includes(clickedText) || clickedText.includes(text))) continue;
          add(anchor.getAttribute('href') || anchor.href);
          if (candidates.length) break;
        }
      } catch {}
    }
  }

  return candidates[0] || '';
}

window.addEventListener('click', event => {
  if (selectMode) return;

  const tripHotelUrl = tripHotelDetailUrlFromClick(event.target, event);
  if (tripHotelUrl) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.sendToHost('open-tab-request', { url: tripHotelUrl, reason: 'trip-hotel-detail' });
    return;
  }

  const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!target) return;
  const requestedTarget = String(target.getAttribute('target') || '').toLowerCase();
  if (requestedTarget !== '_blank') return;
  const href = absoluteHttpUrl(target.getAttribute('href') || target.href || '');
  if (!href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.sendToHost('open-tab-request', { url: href, reason: 'target-blank' });
}, true);

window.addEventListener('click', event => {
  if (!selectMode) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const el = event.target;
  if (!(el instanceof Element)) return;

  const info = describeElement(el);
  ipcRenderer.sendToHost('element-picked', info);

  const oldOutline = el.style.outline;
  el.style.outline = '3px solid #21c77a';
  setTimeout(() => { try { el.style.outline = oldOutline; } catch {} }, 450);
}, true);

function describeElement(el) {
  const uniqueSelector = SelectorEngine.buildUniqueSelector(el, document);
  const reusable = SelectorEngine.reusableSelector(el, document, { preferRepeated: false });
  const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 280);
  return {
    selector: uniqueSelector,
    reusableSelector: reusable.selector,
    reusableCount: reusable.count,
    xpath: SelectorEngine.buildXPath(el),
    tag: el.tagName.toLowerCase(),
    text,
    href: el.href || '',
    src: el.src || '',
    value: 'value' in el ? el.value : '',
    suggestedName: SelectorEngine.suggestFieldName(el),
    attributes: Object.fromEntries([...el.attributes].slice(0, 30).map(attr => [attr.name, attr.value])),
    containerCandidates: selectionTarget === 'item' ? SelectorEngine.containerCandidates(el, document, 9) : []
  };
}

function installReviewPayloadCapture() {
  // Beberapa situs modern (terutama Traveloka) merender tanggal relatif di UI
  // seperti "Diulas 59 minggu lalu", sementara payload halaman memuat timestamp
  // asli. Capture ini hanya menyimpan response review yang memang diminta oleh
  // halaman yang sedang dibuka; tidak mengubah header, token, atau bypass akses.
  const script = REVIEW_CAPTURE_SCRIPT;
  // Prefer Electron's page-world execution. Injecting an inline <script> is blocked
  // by the CSP used by sites such as Tiket.com, which previously meant the DOM
  // workflow never saw submitId even though the same response was present in HAR.
  // executeJavaScript runs in the document's page world and is not dependent on an
  // inline-script CSP allowance. The DOM injection remains as a compatibility fallback.
  const executeInPageWorld = () => {
    try {
      const pending = webFrame?.executeJavaScript?.(script, true);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return Boolean(pending);
    } catch {
      return false;
    }
  };
  const injectDomFallback = () => {
    try {
      const host = document.documentElement || document.head || document.body;
      if (!host || host.querySelector?.('script[data-petikdata-review-capture]')) return false;
      const node = document.createElement('script');
      node.dataset.petikdataReviewCapture = 'true';
      node.textContent = script;
      host.prepend(node);
      node.remove();
      return true;
    } catch {
      return false;
    }
  };
  const install = () => executeInPageWorld() || injectDomFallback();
  install();
  // Retry at lifecycle boundaries. The in-page guard makes these calls idempotent,
  // while the early call normally hooks fetch/XHR before a review modal is opened.
  window.addEventListener('DOMContentLoaded', install, { once: true });
  window.addEventListener('load', install, { once: true });
  setTimeout(install, 0);
  setTimeout(install, 250);
  setTimeout(install, 1200);
}
