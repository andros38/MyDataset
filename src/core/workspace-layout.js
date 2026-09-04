'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const INTERNAL_FOLDER = '.mydataset';

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function internalRoot(workspaceDir) { return path.join(workspaceDir, INTERNAL_FOLDER); }
function internalPath(workspaceDir, ...parts) { return path.join(internalRoot(workspaceDir), ...parts); }
function visibleDatasetRoot(workspaceDir) { return path.join(workspaceDir, 'Dataset'); }
function visibleCombinedRoot(workspaceDir) { return path.join(workspaceDir, 'Dataset Gabungan'); }

function hideDirectoryBestEffort(dir) {
  if (!dir || !fs.existsSync(dir) || process.platform !== 'win32') return;
  try { spawnSync('attrib', ['+H', dir], { windowsHide: true, stdio: 'ignore' }); } catch {}
}

function ensureInternalWorkspace(workspaceDir) {
  const root = ensureDir(internalRoot(workspaceDir));
  for (const name of ['Autosave', 'Backups', 'Runs', 'Projects', 'Imports']) ensureDir(path.join(root, name));
  hideDirectoryBestEffort(root);
  return root;
}

function legacyTechnicalRoots(workspaceDir) {
  return ['Autosave', 'Backups', 'Runs', 'Projects', 'Imports'].map(name => path.join(workspaceDir, name));
}

function hideLegacyTechnicalRoots(workspaceDir) {
  for (const dir of legacyTechnicalRoots(workspaceDir)) hideDirectoryBestEffort(dir);
}

function relativeWorkspaceRef(workspaceDir, target) {
  const rel = path.relative(path.resolve(workspaceDir), path.resolve(target));
  return rel.split(path.sep).join('/');
}

function resolveWorkspaceRef(workspaceDir, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.resolve(raw); // compatibility with old manifests only
  return path.resolve(workspaceDir, raw.replace(/\//g, path.sep));
}

module.exports = {
  INTERNAL_FOLDER,
  internalRoot,
  internalPath,
  visibleDatasetRoot,
  visibleCombinedRoot,
  ensureInternalWorkspace,
  hideDirectoryBestEffort,
  hideLegacyTechnicalRoots,
  relativeWorkspaceRef,
  resolveWorkspaceRef
};
