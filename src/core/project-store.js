const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./run-store');
const { internalPath, ensureInternalWorkspace } = require('./workspace-layout');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workspacePaths(workspaceDir) {
  ensureDir(workspaceDir);
  ensureInternalWorkspace(workspaceDir);
  return {
    workspaceDir,
    autosaveDir: ensureDir(internalPath(workspaceDir, 'Autosave')),
    backupsDir: ensureDir(internalPath(workspaceDir, 'Backups')),
    runsDir: ensureDir(internalPath(workspaceDir, 'Runs')),
    resultsDir: ensureDir(path.join(workspaceDir, 'Dataset')),
    recentPath: internalPath(workspaceDir, 'recent-projects.json'),
    autosavePath: internalPath(workspaceDir, 'Autosave', 'current-project.json')
  };
}

function autosaveProject(workspaceDir, project, projectPath = null) {
  const paths = workspacePaths(workspaceDir);
  const payload = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    projectPath,
    project
  };
  atomicWriteJson(paths.autosavePath, payload);
  return payload;
}

function loadAutosave(workspaceDir) {
  const filePath = workspacePaths(workspaceDir).autosavePath;
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function clearAutosave(workspaceDir) {
  const filePath = workspacePaths(workspaceDir).autosavePath;
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function recordRecent(workspaceDir, projectPath, project) {
  if (!projectPath) return;
  const paths = workspacePaths(workspaceDir);
  let recent = [];
  if (fs.existsSync(paths.recentPath)) {
    try { recent = JSON.parse(fs.readFileSync(paths.recentPath, 'utf8')); } catch {}
  }
  recent = recent.filter(item => item.filePath !== projectPath);
  recent.unshift({
    filePath: projectPath,
    name: project?.name || path.basename(projectPath),
    updatedAt: new Date().toISOString()
  });
  recent = recent.slice(0, 20);
  atomicWriteJson(paths.recentPath, recent);
}

function listRecent(workspaceDir) {
  const filePath = workspacePaths(workspaceDir).recentPath;
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')).filter(item => fs.existsSync(item.filePath));
  } catch {
    return [];
  }
}

function writeProject(filePath, project) {
  atomicWriteJson(filePath, project);
  return filePath;
}

module.exports = {
  workspacePaths,
  autosaveProject,
  loadAutosave,
  clearAutosave,
  recordRecent,
  listRecent,
  writeProject
};
