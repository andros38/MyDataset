const AcquisitionPolicy = require('../shared/acquisition-policy');
function projectForRun(project) {
  if (!project || typeof project !== 'object') return project;
  project = AcquisitionPolicy.migrateProject(project).project;
  const policy = AcquisitionPolicy.validateProject(project);
  if (!policy.ok) { const error = new Error(policy.message); error.code = policy.code; throw error; }
  if (policy.method !== 'dom') return { ...project, mode: 'quick', pagination: { ...(project.pagination || {}), type: 'none', maxPages: 1 } };
  const acquisition = project.acquisition || {};
  const scope = acquisition.scope || '';
  let mode = ['quick', 'multipage', 'crawl'].includes(project.mode)
    ? project.mode
    : (project.pagination?.type && project.pagination.type !== 'none' ? 'multipage' : 'quick');

  // v0.41: acquisition scope is the public workflow; legacy mode remains only as
  // a runner compatibility detail. This also keeps older saved projects working.
  if (scope === 'site-crawl') mode = 'crawl';
  else if (scope === 'multiple' || scope === 'all') mode = 'multipage';
  else if (scope === 'current') mode = 'quick';

  const pagination = { ...(project.pagination || {}) };
  if (mode === 'quick' || mode === 'crawl') {
    pagination.type = 'none';
    pagination.maxPages = 1;
  } else if (mode === 'multipage') {
    if (!['next', 'loadMore', 'scroll'].includes(pagination.type)) {
      pagination.type = ['next', 'loadMore', 'scroll'].includes(pagination.lastType) ? pagination.lastType : 'next';
    }
    const requestedLimit = Number(acquisition.limit || pagination.maxPages || 5);
    // v0.91: null berarti open-ended dan hanya dipakai untuk scope 'all'.
    // Scope multiple selalu memakai jumlah langkah yang diminta pengguna tanpa hard cap 500.
    pagination.maxPages = scope === 'all' ? null : Math.max(1, Math.trunc(Number.isFinite(requestedLimit) ? requestedLimit : 5));
  }
  return { ...project, mode, pagination };
}

module.exports = { projectForRun };
