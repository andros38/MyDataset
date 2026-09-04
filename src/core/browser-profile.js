'use strict';

// The partition name is intentionally retained so users upgrading from
// CrawlLoom keep their existing cookies, cache, and sign-in state.
const BROWSER_PARTITION = 'persist:crawlstudio-session';
const BROWSER_ACCEPT_LANGUAGES = 'id-ID,id,en-US,en';

function toChromiumUserAgent(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  // Electron app tokens sometimes trigger an unsupported-browser path even
  // though the embedded engine is Chromium. This only reports the underlying
  // engine; it does not patch browser APIs or bypass a site challenge.
  return raw
    .replace(/\sElectron\/[\w.-]+/gi, '')
    .replace(/\s(?:PetikData|MyDataset)\/[\w.-]+/gi, '')
    .replace(/\sCrawlLoom(?:%20|\s)Studio\/[\w.-]+/gi, '')
    .replace(/\scrawlloom-studio\/[\w.-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function configurePersistentBrowserSession(electronSession) {
  if (!electronSession?.fromPartition) throw new TypeError('Electron session tidak tersedia.');
  const persistentSession = electronSession.fromPartition(BROWSER_PARTITION, { cache: true });
  const userAgent = toChromiumUserAgent(persistentSession?.getUserAgent?.() || '');
  if (userAgent && persistentSession?.setUserAgent) persistentSession.setUserAgent(userAgent, BROWSER_ACCEPT_LANGUAGES);
  return { session: persistentSession, userAgent, partition: BROWSER_PARTITION, acceptLanguages: BROWSER_ACCEPT_LANGUAGES };
}

module.exports = {
  BROWSER_PARTITION,
  BROWSER_ACCEPT_LANGUAGES,
  toChromiumUserAgent,
  configurePersistentBrowserSession
};
