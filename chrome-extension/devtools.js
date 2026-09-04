'use strict';

chrome.devtools.panels.create('MyDataset', 'icon.png', 'panel.html', () => {});

function inspectedPageInfo() {
  return new Promise(resolve => {
    try {
      chrome.devtools.inspectedWindow.eval(
        '({url: location.href, title: document.title || ""})',
        (result, exceptionInfo) => {
          if (exceptionInfo?.isException || !result) return resolve({ url:'', title:'' });
          resolve({ url:String(result.url || ''), title:String(result.title || '') });
        }
      );
    } catch { resolve({ url:'', title:'' }); }
  });
}

async function performScan({ filter = 'getReviews', successOnly = true } = {}) {
  const inspectedTabId = Number(chrome.devtools.inspectedWindow.tabId);
  try {
    const [scan, familyScan, aggregateScan, page] = await Promise.all([
      MyDatasetCaptureCore.scanCurrentHar({ filter:String(filter || 'getReviews').trim(), successOnly:successOnly !== false }),
      // Also collect the small Traveloka review metadata endpoints. They are kept
      // separate from the importable getReviews list and are used only to diagnose
      // count/filter mismatches (for example getReviewCount vs getReviews).
      MyDatasetCaptureCore.scanCurrentHar({ filter:'getReview', successOnly:successOnly !== false }),
      // Traveloka exposes the source split (Traveloka vs other provider) through
      // getAvailableReviewWithAggregate, whose name is outside the getReview* family.
      MyDatasetCaptureCore.scanCurrentHar({ filter:'getAvailableReviewWithAggregate', successOnly:successOnly !== false }),
      inspectedPageInfo()
    ]);
    const diagnostics = [];
    const seenDiagnostics = new Set();
    for (const record of [...(familyScan.records || []), ...(aggregateScan.records || [])]) {
      if (!MyDatasetCaptureCore.isReviewDiagnosticRecord(record)) continue;
      const key = String(record?.fingerprint || `${record?.method || ''}|${record?.url || ''}|${record?.startedDateTime || ''}`);
      if (seenDiagnostics.has(key)) continue;
      seenDiagnostics.add(key);
      diagnostics.push(record);
    }
    return {
      ok:true,
      inspectedTabId,
      filter:String(filter || 'getReviews').trim(),
      sourceUrl:page.url,
      pageTitle:page.title,
      totalEntries:scan.totalEntries,
      skipped:scan.skipped,
      records:scan.records,
      diagnosticRecords:diagnostics
    };
  } catch (error) {
    return { ok:false, error:String(error?.message || error) };
  }
}

// Standard DevTools -> service worker long-lived bridge. The service worker
// routes requests from the popup to the DevTools instance for the same tab.
let bridgePort = null;
let heartbeatTimer = null;
let reconnectTimer = null;

function connectBridge() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    bridgePort = chrome.runtime.connect({ name:'mydataset-devtools' });
    const inspectedTabId = Number(chrome.devtools.inspectedWindow.tabId);
    bridgePort.postMessage({ type:'mydataset:devtools-register', tabId:inspectedTabId });

    bridgePort.onMessage.addListener(message => {
      if (message?.type !== 'mydataset:scan-network') return;
      (async () => {
        const payload = await performScan({ filter:message.filter, successOnly:message.successOnly });
        try {
          bridgePort?.postMessage({
            type:'mydataset:scan-result',
            requestId:String(message.requestId || ''),
            payload
          });
        } catch {}
      })();
    });

    bridgePort.onDisconnect.addListener(() => {
      bridgePort = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      reconnectTimer = setTimeout(connectBridge, 750);
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      try {
        bridgePort?.postMessage({
          type:'mydataset:devtools-heartbeat',
          tabId:inspectedTabId,
          at:Date.now()
        });
      } catch {}
    }, 20000);
  } catch {
    reconnectTimer = setTimeout(connectBridge, 1000);
  }
}

connectBridge();

// Compatibility path for an older popup while the extension is being updated.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'mydataset:scan-current-network-direct') return undefined;
  const inspectedTabId = Number(chrome.devtools.inspectedWindow.tabId);
  if (Number(message.tabId) !== inspectedTabId) return undefined;
  performScan({ filter:message.filter, successOnly:message.successOnly }).then(sendResponse);
  return true;
});
