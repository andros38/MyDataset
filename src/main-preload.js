const { contextBridge, ipcRenderer } = require('electron');
const { classifyLoadFailure } = require('./core/browser-navigation');

const api = {
  getPaths: () => ipcRenderer.invoke('app:get-paths'),
  classifyLoadFailure: (event, activeUrl) => classifyLoadFailure(event || {}, activeUrl || ''),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getBrowserProfile: () => ipcRenderer.invoke('browser:get-profile'),
  openExternalUrl: url => ipcRenderer.invoke('browser:open-external', url),
  openChromeUrl: url => ipcRenderer.invoke('browser:open-chrome', url),
  stageNetworkJson: payload => ipcRenderer.invoke('data:stage-network-json', payload),
  clearNetworkJsonStage: stageId => ipcRenderer.invoke('data:clear-network-json-stage', stageId),
  processNetworkJson: payload => ipcRenderer.invoke('data:process-network-json', payload),
  setBrowserBackgroundThrottling: (webContentsId, allowed = false) => ipcRenderer.invoke('browser:set-background-throttling', webContentsId, allowed),
  refreshBrowserSurface: webContentsId => ipcRenderer.invoke('browser:refresh-surface', webContentsId),
  captureBrowserPreview: (webContentsId, options = {}) => ipcRenderer.invoke('browser:capture-preview', webContentsId, options),
  identifySource: signals => ipcRenderer.invoke('source:identify', signals),
  autosaveProject: (project, projectPath) => ipcRenderer.invoke('project:autosave', project, projectPath),
  resetProjectState: payload => ipcRenderer.invoke('project:reset-state', payload),
  getRecovery: () => ipcRenderer.invoke('project:get-recovery'),
  saveProject: (project, currentPath, saveAs = false) => ipcRenderer.invoke('project:save', project, currentPath, saveAs),
  openProject: () => ipcRenderer.invoke('project:open'),
  openRecentProject: filePath => ipcRenderer.invoke('project:open-recent', filePath),
  runProject: (project, webContentsId) => ipcRenderer.invoke('project:run', project, webContentsId),
  resumeRun: (runDir, webContentsId) => ipcRenderer.invoke('run:resume', runDir, webContentsId),
  pauseRun: () => ipcRenderer.invoke('run:pause'),
  cancelRun: () => ipcRenderer.invoke('run:cancel'),
  markRunStopped: runDir => ipcRenderer.invoke('run:mark-stopped', runDir),
  listRuns: () => ipcRenderer.invoke('run:list'),
  listCombinedDatasets: () => ipcRenderer.invoke('combined:list'),
  createCombinedDataset: payload => ipcRenderer.invoke('combined:create', payload),
  getCombinedDataset: (directory, limit, dataset = 'clean') => ipcRenderer.invoke('combined:read', directory, limit, dataset),
  openCombinedDataset: directory => ipcRenderer.invoke('combined:open', directory),
  deleteCombinedHistory: directory => ipcRenderer.invoke('combined:delete-history', directory),
  clearCombinedHistory: () => ipcRenderer.invoke('combined:clear-history'),
  openRunSource: runDir => ipcRenderer.invoke('run:open-source', runDir),
  deleteRunHistory: runDir => ipcRenderer.invoke('run:delete-history', runDir),
  clearRunHistory: () => ipcRenderer.invoke('run:clear-history'),
  getRunResults: (runDir, limit, tail = false) => ipcRenderer.invoke('run:results', runDir, limit, tail),
  getRunDataset: (runDir, dataset, limit) => ipcRenderer.invoke('run:dataset', runDir, dataset, limit),
  getDuplicateDecisions: runDir => ipcRenderer.invoke('run:duplicate-decisions:get', runDir),
  saveDuplicateDecision: (runDir, payload) => ipcRenderer.invoke('run:duplicate-decisions:set', runDir, payload),
  getRunLog: runDir => ipcRenderer.invoke('run:log', runDir),
  showUrlContextMenu: () => ipcRenderer.invoke('url-context-menu:show'),
  exportData: payload => ipcRenderer.invoke('data:export', payload),
  exportDatasetBundle: payload => ipcRenderer.invoke('data:export-bundle', payload),
  exportLog: payload => ipcRenderer.invoke('log:export', payload),
  openWorkspace: projectName => ipcRenderer.invoke('app:open-workspace', projectName),
  openRunOutput: runDir => ipcRenderer.invoke('app:open-run-output', runDir),
  openResultLocation: runDir => ipcRenderer.invoke('app:open-result-location', runDir),
  onRunProgress: callback => ipcRenderer.on('run:progress', (_event, payload) => callback(payload)),
  onMenuCommand: callback => ipcRenderer.on('menu:command', (_event, command, payload) => callback(command, payload)),
  onBrowserNewTabRequest: callback => ipcRenderer.on('browser:new-tab-request', (_event, payload) => callback(payload))
};

// MyDataset is the active API name. Legacy aliases remain compatible with old projects/plugins.
contextBridge.exposeInMainWorld('mydataset', api);
contextBridge.exposeInMainWorld('crawlloom', api);
contextBridge.exposeInMainWorld('crawlstudio', api);
contextBridge.exposeInMainWorld('petikdata', api);
