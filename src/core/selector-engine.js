(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrawlSelectorEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const semanticWords = [
    'review','comment','feedback','rating','score','guest','user','author','name','date','time',
    'product','hotel','item','card','row','result','listing','content','body','title','price','room',
    'traveler','traveller','country','location','pagination','next','more'
  ];

  function cssEscape(value, doc) {
    const css = doc?.defaultView?.CSS || globalThis.CSS;
    if (css?.escape) return css.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function quoteAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function normalizeToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function classQuality(value) {
    const cls = String(value || '');
    if (!cls || cls.length > 90) return -20;
    const low = cls.toLowerCase();
    if (/^(active|selected|hover|focus|open|show|hidden|disabled)$/.test(low)) return -20;
    if (/^(css|jsx)-[a-z0-9_-]+$/i.test(cls)) return -12;
    if (/^sc-[a-z0-9_-]+$/i.test(cls)) return -10;
    let score = 2;
    if (semanticWords.some(word => low.includes(word))) score += 14;
    if (/styled|typography|wrapper|container/i.test(cls)) score += 2;
    if (/[a-z]{3,}/i.test(cls)) score += 2;
    if ((cls.match(/\d/g) || []).length > 8) score -= 5;
    return score;
  }

  function stableClasses(el) {
    return [...(el.classList || [])]
      .map(cls => ({ cls, score: classQuality(cls) }))
      .filter(item => item.score > -10)
      .sort((a, b) => b.score - a.score || a.cls.length - b.cls.length)
      .map(item => item.cls);
  }

  function safeCount(doc, selector) {
    try { return doc.querySelectorAll(selector).length; }
    catch { return 0; }
  }

  function selectorCandidates(el, doc) {
    const tag = el.tagName.toLowerCase();
    const candidates = [];
    const preferredAttrs = [
      'data-testid','data-test','data-qa','data-element-name','data-selenium','data-cy',
      'itemprop','name','aria-label','role'
    ];

    if (el.id) candidates.push({ selector: `#${cssEscape(el.id, doc)}`, kind: 'id', strength: 40 });

    for (const attr of preferredAttrs) {
      const value = el.getAttribute(attr);
      if (!value || String(value).length > 140) continue;
      const selector = `${tag}[${attr}="${quoteAttr(value)}"]`;
      candidates.push({ selector, kind: attr, strength: attr.startsWith('data-') ? 36 : 28 });
      if (attr !== 'role') candidates.push({ selector: `[${attr}="${quoteAttr(value)}"]`, kind: attr, strength: 32 });
    }

    const classes = stableClasses(el).slice(0, 5);
    for (const cls of classes) {
      const quality = classQuality(cls);
      candidates.push({ selector: `.${cssEscape(cls, doc)}`, kind: 'class', strength: 12 + quality });
      candidates.push({ selector: `${tag}.${cssEscape(cls, doc)}`, kind: 'class', strength: 14 + quality });
    }
    if (classes.length >= 2) {
      const pair = classes.slice(0, 2).map(cls => cssEscape(cls, doc)).join('.');
      candidates.push({ selector: `${tag}.${pair}`, kind: 'classes', strength: 24 + classQuality(classes[0]) + classQuality(classes[1]) });
    }
    if (classes.length >= 3) {
      const triple = classes.slice(0, 3).map(cls => cssEscape(cls, doc)).join('.');
      candidates.push({ selector: `${tag}.${triple}`, kind: 'classes', strength: 28 });
    }

    candidates.push({ selector: tag, kind: 'tag', strength: 0 });

    const seen = new Set();
    return candidates.filter(item => {
      if (!item.selector || seen.has(item.selector)) return false;
      seen.add(item.selector);
      return safeCount(doc, item.selector) > 0;
    });
  }

  function reusableSelector(el, doc, options = {}) {
    const preferRepeated = Boolean(options.preferRepeated);
    const candidates = selectorCandidates(el, doc);
    let best = null;
    for (const item of candidates) {
      const count = safeCount(doc, item.selector);
      let score = item.strength - item.selector.length * 0.06;
      if (preferRepeated) {
        // IDs identify one concrete DOM instance. Some SPAs accidentally duplicate IDs
        // between visible/hidden trees; never treat that as evidence of a repeated row.
        if (item.kind === 'id') score -= 240;
        if (count >= 2 && count <= 100) score += 90;
        else if (count > 100 && count <= 500) score += 35;
        else if (count === 1) score -= 25;
        else score -= 60;
      } else {
        if (count === 1) score += 55;
        else if (count <= 20) score += 25;
        else if (count <= 200) score += 5;
        else score -= 30;
      }
      if (!best || score > best.score) best = { ...item, count, score };
    }
    return best || { selector: buildUniqueSelector(el, doc), count: 1, score: 0, kind: 'path' };
  }

  function buildUniqueSelector(el, doc) {
    if (el.id) return `#${cssEscape(el.id, doc)}`;
    const direct = reusableSelectorNoRecursion(el, doc);
    if (direct && direct.count === 1) return direct.selector;

    const path = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== doc.documentElement) {
      let part = current.tagName.toLowerCase();
      const attrs = ['data-testid','data-test','data-qa','data-element-name','itemprop','aria-label'];
      let strong = false;
      for (const attr of attrs) {
        const value = current.getAttribute(attr);
        if (value && String(value).length < 120) {
          part += `[${attr}="${quoteAttr(value)}"]`;
          strong = true;
          break;
        }
      }
      if (!strong) {
        const cls = stableClasses(current)[0];
        if (cls) part += `.${cssEscape(cls, doc)}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(child => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      path.unshift(part);
      const selector = path.join(' > ');
      if (safeCount(doc, selector) === 1) return selector;
      current = parent;
    }
    return path.join(' > ');
  }

  function reusableSelectorNoRecursion(el, doc) {
    const candidates = selectorCandidates(el, doc);
    let best = null;
    for (const item of candidates) {
      const count = safeCount(doc, item.selector);
      const score = item.strength + (count === 1 ? 60 : 0) - item.selector.length * 0.05;
      if (!best || score > best.score) best = { ...item, count, score };
    }
    return best;
  }

  function buildXPath(el) {
    if (el.id) return `//*[@id="${String(el.id).replace(/"/g, '\\"')}"]`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentNode
        ? [...current.parentNode.children].filter(sibling => sibling.tagName === current.tagName)
        : [];
      const index = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : '';
      parts.unshift(`${tag}${index}`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  function getPath(obj, path) {
    return !path ? obj : String(path).split('.').filter(Boolean).reduce((cur, key) => cur == null ? null : cur[key], obj);
  }

  function findContainerIdentity(root) {
    if (!root) return null;
    const direct = [
      ['data-review-id','review_id'], ['data-comment-id','review_id'], ['data-writing-id','review_id'], ['data-submit-id','review_id'],
      ['data-item-id','item_id'], ['data-record-id','record_id'], ['data-product-id','product_id']
    ];
    for (const [attribute, suggestedName] of direct) {
      const value = root.getAttribute(attribute);
      if (value != null && String(value) !== '') return { mode:'containerAttribute', attribute, jsonPath:'', value, suggestedName };
    }
    const wanted = new Map([
      ['writingid','review_id'],['reviewid','review_id'],['review_id','review_id'],['submitid','review_id'],['submit_id','review_id'],['commentid','review_id'],['comment_id','review_id'],
      ['itemid','item_id'],['item_id','item_id'],['recordid','record_id'],['record_id','record_id'],['productid','product_id'],['product_id','product_id']
    ]);
    const walk = (obj, path = [], depth = 0) => {
      if (obj == null || depth > 6) return null;
      if (Array.isArray(obj)) {
        for (let i = 0; i < Math.min(obj.length, 20); i++) { const hit = walk(obj[i], [...path, String(i)], depth + 1); if (hit) return hit; }
        return null;
      }
      if (typeof obj !== 'object') return null;
      for (const [key, value] of Object.entries(obj)) {
        const normalized = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (wanted.has(normalized) && (typeof value === 'string' || typeof value === 'number')) {
          return { path: [...path, key].join('.'), value, suggestedName: wanted.get(normalized) };
        }
      }
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') { const hit = walk(value, [...path, key], depth + 1); if (hit) return hit; }
      }
      return null;
    };
    for (const attr of [...root.attributes]) {
      const raw = String(attr.value || '').trim();
      if (raw.length < 2 || raw.length > 25000 || (!raw.startsWith('{') && !raw.startsWith('['))) continue;
      try {
        const hit = walk(JSON.parse(raw));
        if (hit) return { mode:'containerJsonAttribute', attribute:attr.name, jsonPath:hit.path, value:hit.value, suggestedName:hit.suggestedName };
      } catch {}
    }
    return null;
  }

  function identityValue(root, identity) {
    if (!root || !identity) return null;
    if (identity.mode === 'containerAttribute') return root.getAttribute(identity.attribute || '');
    if (identity.mode === 'containerJsonAttribute') {
      try { return getPath(JSON.parse(root.getAttribute(identity.attribute || '') || 'null'), identity.jsonPath || ''); }
      catch { return null; }
    }
    return null;
  }

  function logicalRootInfo(selector, doc) {
    let rawRoots = [];
    try { rawRoots = [...doc.querySelectorAll(selector)]; } catch { return { rawCount:0, logicalCount:0, keyAttribute:null, identity:null }; }
    const identities = rawRoots.map(findContainerIdentity).filter(Boolean);
    let identity = null;
    if (identities.length) {
      const groups = new Map();
      for (const item of identities) {
        const key = [item.mode,item.attribute,item.jsonPath || '',item.suggestedName || ''].join('|');
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      const best = [...groups.entries()].sort((a,b) => b[1] - a[1])[0];
      if (best && best[1] / Math.max(1, rawRoots.length) >= 0.6) {
        const [mode, attribute, jsonPath, suggestedName] = best[0].split('|');
        identity = { mode, attribute, jsonPath, suggestedName: suggestedName || 'review_id' };
      }
    }
    if (!identity) {
      const preferred = ['data-review-id','data-comment-id','data-writing-id','data-submit-id','data-item-id','data-product-id','data-result-id','data-record-id','data-id','data-key','id'];
      for (const attr of preferred) {
        const values = rawRoots.map(root => root.getAttribute(attr)).filter(value => value != null && String(value) !== '');
        const unique = new Set(values.map(String));
        if (values.length / Math.max(1, rawRoots.length) >= 0.8 && unique.size >= 2) {
          identity = { mode:'containerAttribute', attribute:attr, jsonPath:'', suggestedName:/review|comment|writing/i.test(attr) ? 'review_id' : 'item_id' };
          break;
        }
      }
    }
    if (!identity) return { rawCount:rawRoots.length, logicalCount:rawRoots.length, keyAttribute:null, identity:null };
    const seen = new Set(); let logicalCount = 0;
    for (const root of rawRoots) {
      const key = identityValue(root, identity);
      if (key != null && String(key) !== '') {
        if (seen.has(String(key))) continue;
        seen.add(String(key));
      }
      logicalCount += 1;
    }
    return { rawCount:rawRoots.length, logicalCount, keyAttribute:identity.mode === 'containerAttribute' ? identity.attribute : null, identity };
  }

  function semanticRepeatedContainerSelector(el, doc) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    for (const attr of ['data-testid','data-test','data-qa','data-element-name','data-selenium','role','aria-label']) {
      const value = String(el.getAttribute(attr) || '').trim();
      if (!value || value.length > 140) continue;
      if (!/(?:^|[-_\s])(review|comment|feedback|result|listing|item|card|row|entry)(?:[-_\s]|$)/i.test(value)) continue;
      const selector = `${tag}[${attr}="${quoteAttr(value)}"]`;
      const count = safeCount(doc, selector);
      if (count >= 2 && count <= 250) return selector;
    }
    for (const cls of [...(el.classList || [])]) {
      const m = String(cls).match(/^(.{3,80}?(?:review[_-]?card|comment[_-]?card|review[_-]?item|reviewcard|result[_-]?item|listing[_-]?item))__[^\s]+$/i);
      if (!m) continue;
      const selector = `${tag}[class*="${quoteAttr(m[1] + '__')}"]`;
      const count = safeCount(doc, selector);
      if (count >= 2 && count <= 250) return selector;
    }
    return '';
  }

  function structuralRepeatedSelector(el, doc) {
    if (!el?.parentElement) return '';
    const tag = el.tagName.toLowerCase();
    const siblings = [...el.parentElement.children].filter(node => node.tagName === el.tagName);
    if (siblings.length < 2 || siblings.length > 250) return '';
    for (const cls of [...(el.classList || [])]) {
      if (!cls || cls.length > 100 || /^(active|selected|hover|focus|open|show|hidden|disabled)$/i.test(cls)) continue;
      if (siblings.filter(node => node.classList?.contains(cls)).length < 2) continue;
      const selector = `${tag}.${cssEscape(cls, doc)}`;
      const count = safeCount(doc, selector);
      if (count >= 2 && count <= 250) return selector;
    }
    return '';
  }

  function identityRepeatedSelector(el, doc) {
    const identity = findContainerIdentity(el);
    if (!identity) return '';
    const tag = el.tagName.toLowerCase();
    if (identity.mode === 'containerAttribute') {
      const selector = `${tag}[${identity.attribute}]`;
      const count = safeCount(doc, selector);
      if (count >= 2 && count <= 250) return selector;
    }
    if (identity.mode === 'containerJsonAttribute') {
      const raw = String(el.getAttribute(identity.attribute) || '');
      const token = /htl_t_online_cmt_list_card_exposure/i.test(raw) ? 'htl_t_online_cmt_list_card_exposure' : (String(identity.jsonPath || '').split('.').pop() || 'writingid');
      const selector = `${tag}[${identity.attribute}*="${quoteAttr(token)}"]`;
      const count = safeCount(doc, selector);
      if (count >= 2 && count <= 250) return selector;
    }
    return '';
  }

  function candidateLabel(el, selector) {
    const tag = el.tagName.toLowerCase();
    const semanticClass = stableClasses(el).find(cls => classQuality(cls) >= 12);
    const attr = ['data-testid','data-element-name','data-qa','data-test','itemprop','role']
      .map(name => [name, el.getAttribute(name)])
      .find(([, value]) => value);
    if (attr) return `${tag} · ${attr[0]}=${String(attr[1]).slice(0, 45)}`;
    if (semanticClass) return `${tag} · ${semanticClass.slice(0, 55)}`;
    return `${tag} · ${selector.slice(0, 60)}`;
  }

  function containerCandidates(clicked, doc, maxDepth = 10) {
    const list = [];
    const seen = new Set();
    let el = clicked;
    let depth = 0;
    const viewportWidth = doc.defaultView?.innerWidth || 1200;
    const viewportHeight = doc.defaultView?.innerHeight || 800;

    while (el && el.nodeType === 1 && el !== doc.body && depth <= maxDepth) {
      const reusable = reusableSelector(el, doc, { preferRepeated: true });
      const identitySelector = identityRepeatedSelector(el, doc);
      const semanticContainer = semanticRepeatedContainerSelector(el, doc);
      const structuralSelector = structuralRepeatedSelector(el, doc);
      const selector = identitySelector || semanticContainer || structuralSelector || reusable.selector;
      const logical = logicalRootInfo(selector, doc);
      const count = logical.rawCount;
      const logicalCount = logical.logicalCount;
      if (!seen.has(selector)) {
        seen.add(selector);
        const descendants = el.querySelectorAll('*').length;
        const directChildren = el.children.length;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { width: 0, height: 0 };
        const areaRatio = Math.min(1, Math.max(0, (rect.width * rect.height) / Math.max(1, viewportWidth * viewportHeight)));
        const selectorText = selector.toLowerCase();
        let score = reusable.score || 0;
        if (identitySelector) score += 300;
        else if (semanticContainer) score += 380;
        else if (structuralSelector) score += 105;
        if (logical.identity) score += 180;
        if (logicalCount >= 2 && logicalCount <= 60) score += 250;
        else if (logicalCount > 60 && logicalCount <= 250) score += 70;
        else if (logicalCount === 1) score -= 220;
        else if (logicalCount > 250) score -= 160;
        if (descendants >= 3 && descendants <= 120) score += 30;
        if (descendants >= 8 && descendants <= 120) score += 18;
        if (directChildren >= 2 && directChildren <= 20) score += 12;
        if (text.length >= 30) score += 15;
        if (areaRatio > 0.003 && areaRatio < 0.45) score += 18;
        if (semanticWords.some(word => selectorText.includes(word))) score += 30;
        if (/^h[1-6]$/.test(el.tagName.toLowerCase()) || ['span','strong','em','small','p'].includes(el.tagName.toLowerCase())) score -= descendants === 0 ? 90 : 40;
        if (descendants === 0) score -= 55;
        if (logicalCount === 1 && descendants > 120) score -= 180;
        if (logicalCount === 1 && areaRatio > 0.55) score -= 220;
        score -= depth * 1.5;

        list.push({
          selector, count, logicalCount, keyAttribute: logical.keyAttribute, identity: logical.identity,
          score: Math.round(score * 10) / 10, depth, tag: el.tagName.toLowerCase(),
          label: candidateLabel(el, selector), textSample: text.slice(0, 150), descendants, directChildren,
          width: Math.round(rect.width || 0), height: Math.round(rect.height || 0),
          semantic: semanticWords.some(word => selectorText.includes(word)),
          panelLike: logicalCount === 1 && (descendants > 120 || areaRatio > 0.55)
        });
      }
      el = el.parentElement;
      depth += 1;
    }

    list.sort((a, b) => b.score - a.score);
    const viable = list.find(item => (item.logicalCount || item.count) >= 2 && (item.logicalCount || item.count) <= 250 && item.descendants >= 2);
    return list.slice(0, 10).map(item => ({ ...item, recommended: Boolean(viable && item.selector === viable.selector) }));
  }

  function sanitizeFieldName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 45) || 'field';
  }

  function suggestFieldName(el) {
    const attrPairs = ['data-testid','data-test','data-qa','data-element-name','data-selenium','itemprop','name','aria-label','title']
      .map(name => [name, el.getAttribute(name)])
      .filter(([, value]) => value);
    const classText = stableClasses(el).slice(0, 4).join(' ');
    const ancestorHints = [];
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 2; depth += 1, parent = parent.parentElement) {
      ancestorHints.push(stableClasses(parent).slice(0, 3).join(' '));
      for (const name of ['data-testid','data-test','data-qa','data-element-name','itemprop','aria-label']) {
        const value = parent.getAttribute(name);
        if (value) ancestorHints.push(value);
      }
    }
    const hint = `${attrPairs.map(([, v]) => v).join(' ')} ${classText} ${ancestorHints.join(' ')}`.toLowerCase();
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(text)) return 'rating_max';
    const agodaLeft = el.closest?.('.Review-comment-left');
    const agodaGroup = agodaLeft && el.closest?.('.Review-comment-score, p');
    if (agodaGroup && agodaLeft.contains(agodaGroup)) {
      const parts = [...agodaGroup.children].filter(node => String(node.tagName || '').toLowerCase() === 'span');
      const carrier = parts.find(node => node === el || node.contains(el));
      if (parts[0] === carrier) return 'rating_score';
      if (parts[1] === carrier) return 'rating_label';
    }
    if (/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text)) return 'review_date';
    if (/^(?:\d{1,2}\s+)?(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text)) return 'review_date';
    const numericScore = text.match(/^\s*(10(?:[.,]0)?|[0-9](?:[.,]\d+)?)\s*$/);
    const ratingHint = /rating|score|star/.test(hint);
    let ratingContext = el.parentElement;
    let parentText = (ratingContext?.innerText || ratingContext?.textContent || '').trim().replace(/\s+/g, ' ');
    for (let depth = 0; ratingContext && depth < 2; depth += 1, ratingContext = ratingContext.parentElement) {
      const candidateText = (ratingContext.innerText || ratingContext.textContent || '').trim().replace(/\s+/g, ' ');
      if (/(?:^|\s)(?:10(?:[.,]0)?|[0-9](?:[.,]\d+)?)(?:\s|$)/.test(candidateText) && candidateText.length < 70) { parentText = candidateText; break; }
    }
    const parentLooksLikeRating = /(?:^|\s)(?:10(?:[.,]0)?|[0-9](?:[.,]\d+)?)(?:\s|$)/.test(parentText) && parentText.length < 70;
    const siblingTexts = [el.previousElementSibling, el.nextElementSibling].filter(Boolean).map(node => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' '));
    const hasNumericSibling = siblingTexts.some(value => { const m = value.match(/^\s*(10(?:[.,]0)?|[0-9](?:[.,]\d+)?)\s*$/); return m && Number(m[1].replace(',', '.')) <= 10; });
    if (numericScore && Number(numericScore[1].replace(',', '.')) <= 10 && (ratingHint || parentLooksLikeRating || hasNumericSibling || text.length <= 5)) return 'rating_score';
    if (!numericScore && text.length > 0 && text.length < 45 && (ratingHint || parentLooksLikeRating || hasNumericSibling)) return 'rating_label';
    if (/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(text)) return 'review_date';

    const mappings = [
      [/rating|score|star/, 'rating'],
      [/reviewer|review-user|guest-name|author|username|user-name/, 'reviewer'],
      [/review.*(text|content|comment)|comment|feedback/, 'review_text'],
      [/review.*date|date|posted|time/, 'review_date'],
      [/country|nationality/, 'country'],
      [/room.*type|room-type/, 'room_type'],
      [/travell?er|guest.*type|trip.*type/, 'traveler_type'],
      [/price|amount|cost|rate/, 'price'],
      [/product.*name|product.*title/, 'product_name'],
      [/hotel.*name|property.*name/, 'hotel_name'],
      [/title|heading/, 'title'],
      [/image|photo|thumbnail|avatar/, 'image_url'],
      [/link|url/, 'url']
    ];
    for (const [pattern, name] of mappings) if (pattern.test(hint)) return name;
    const leadingScore = text.match(/^\s*(10(?:[.,]0)?|[0-9](?:[.,]\d+)?)\b/);
    if (leadingScore && Number(leadingScore[1].replace(',', '.')) <= 10 && text.length < 36) return text.trim() === leadingScore[0].trim() ? 'rating_score' : 'rating';
    if (/\b\d{1,2}[\s\/-](?:jan|feb|mar|apr|mei|may|jun|jul|agu|aug|sep|oct|okt|nov|dec|des|\d{1,2})/i.test(text)) return 'date';
    if (/\bfrom\s+[a-z][a-z .'-]{2,}$/i.test(text) && text.length < 80) return 'reviewer';
    if (text.length >= 80 && !/^(https?:|www\.)/i.test(text)) return 'review_text';
    if (el.tagName.toLowerCase() === 'a') return 'url';
    if (el.tagName.toLowerCase() === 'img') return 'image_url';

    const semantic = attrPairs.map(([, v]) => sanitizeFieldName(v)).find(value => value && !/^sc_|^css_|styled|typography/.test(value));
    if (semantic) return semantic;
    const classSemantic = stableClasses(el).map(sanitizeFieldName).find(value => value && !/^sc_|^css_|styled|typography/.test(value));
    return classSemantic || 'field';
  }

  return {
    cssEscape,
    stableClasses,
    selectorCandidates,
    reusableSelector,
    buildUniqueSelector,
    buildXPath,
    containerCandidates,
    semanticRepeatedContainerSelector,
    findContainerIdentity,
    logicalRootInfo,
    suggestFieldName,
    sanitizeFieldName,
    safeCount
  };
});
