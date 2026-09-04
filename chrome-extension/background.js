'use strict';

// A small router between the action popup and the DevTools page that owns
// chrome.devtools.network. This is more reliable than broadcasting a one-shot
// runtime.sendMessage directly to DevTools contexts.
const devtoolsPorts = new Map();
const pendingScans = new Map();
let requestCounter = 0;

function safeTabId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function unregisterPort(port) {
  for (const [tabId, current] of devtoolsPorts.entries()) {
    if (current === port) devtoolsPorts.delete(tabId);
  }
}

function settlePending(requestId, payload) {
  const pending = pendingScans.get(requestId);
  if (!pending) return;
  pendingScans.delete(requestId);
  clearTimeout(pending.timer);
  try { pending.sendResponse(payload); } catch {}
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'mydataset-devtools') return;
  let registeredTabId = null;

  port.onMessage.addListener(message => {
    if (message?.type === 'mydataset:devtools-register') {
      const tabId = safeTabId(message.tabId);
      if (tabId == null) return;
      registeredTabId = tabId;
      devtoolsPorts.set(tabId, port);
      try { port.postMessage({ type:'mydataset:devtools-registered', tabId }); } catch {}
      return;
    }

    if (message?.type === 'mydataset:scan-result') {
      settlePending(String(message.requestId || ''), message.payload || { ok:false, error:'DevTools mengembalikan respons kosong.' });
      return;
    }

    if (message?.type === 'mydataset:devtools-heartbeat' && registeredTabId != null) {
      devtoolsPorts.set(registeredTabId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    unregisterPort(port);
    for (const [requestId, pending] of pendingScans.entries()) {
      if (pending.port !== port) continue;
      settlePending(requestId, {
        ok:false,
        errorCode:'DEVTOOLS_DISCONNECTED',
        error:'Koneksi DevTools terputus sebelum pemindaian selesai.'
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mydataset:devtools-status') {
    const tabId = safeTabId(message.tabId);
    const connected = tabId != null && devtoolsPorts.has(tabId);
    sendResponse({ ok:true, connected, tabId });
    return false;
  }

  if (message?.type !== 'mydataset:scan-current-network') return undefined;

  const tabId = safeTabId(message.tabId);
  const port = tabId == null ? null : devtoolsPorts.get(tabId);
  if (!port) {
    sendResponse({
      ok:false,
      errorCode:'DEVTOOLS_NOT_CONNECTED',
      error:'DevTools untuk tab ini belum terhubung ke MyDataset Capture.'
    });
    return false;
  }

  const requestId = `scan-${Date.now()}-${++requestCounter}`;
  const timer = setTimeout(() => {
    settlePending(requestId, {
      ok:false,
      errorCode:'DEVTOOLS_TIMEOUT',
      error:'DevTools tidak merespons dalam 45 detik.'
    });
  }, 45000);

  pendingScans.set(requestId, { sendResponse, timer, port });
  try {
    port.postMessage({
      type:'mydataset:scan-network',
      requestId,
      filter:String(message.filter || 'getReviews'),
      successOnly:message.successOnly !== false
    });
  } catch (error) {
    settlePending(requestId, {
      ok:false,
      errorCode:'DEVTOOLS_SEND_FAILED',
      error:String(error?.message || error)
    });
  }
  return true;
});
