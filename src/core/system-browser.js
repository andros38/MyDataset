'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function existingFile(value) {
  try { return Boolean(value && fs.existsSync(value) && fs.statSync(value).isFile()); }
  catch { return false; }
}

function chromeCandidates({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME || env.USERPROFILE || '';
  const candidates = [];
  const add = value => { if (value && !candidates.includes(value)) candidates.push(value); };

  if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]) {
      if (!root) continue;
      add(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    if (home) add(path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
  } else {
    add('/usr/bin/google-chrome-stable');
    add('/usr/bin/google-chrome');
    add('/opt/google/chrome/google-chrome');
  }
  return candidates;
}

function findChromeExecutable(options = {}) {
  return chromeCandidates(options).find(existingFile) || '';
}

function buildChromeLaunchArgs({ url, profileDir } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('URL Google Chrome harus menggunakan http:// atau https://.');
  if (!profileDir || !path.isAbsolute(profileDir)) throw new Error('Direktori profil Chrome harus berupa path absolut.');
  return [
    `--user-data-dir=${profileDir}`,
    '--no-default-browser-check',
    '--no-first-run',
    '--new-window',
    String(url)
  ];
}

function launchGoogleChrome({ url, workspaceDir, executablePath = '' } = {}) {
  const chromePath = executablePath || findChromeExecutable();
  if (!chromePath) throw new Error('Google Chrome tidak ditemukan. Instal Google Chrome atau gunakan tombol Browser Sistem.');
  if (!workspaceDir) throw new Error('Workspace MyDataset belum siap.');
  const profileDir = path.join(workspaceDir, 'ChromeProfile');
  fs.mkdirSync(profileDir, { recursive: true });
  const args = buildChromeLaunchArgs({ url, profileDir });
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, chromePath, profileDir, url: String(url) };
}

function chromeProfileInfo({ workspaceDir } = {}) {
  const chromePath = findChromeExecutable();
  return {
    installed: Boolean(chromePath),
    chromePath,
    profileDir: workspaceDir ? path.join(workspaceDir, 'ChromeProfile') : ''
  };
}

module.exports = {
  chromeCandidates,
  findChromeExecutable,
  buildChromeLaunchArgs,
  launchGoogleChrome,
  chromeProfileInfo
};
