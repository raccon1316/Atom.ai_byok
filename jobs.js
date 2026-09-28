// jobs.js — runs in background.js (service worker)
// Job shape: {id, type:'battlecard'|'multitab'|'dealroom', payload, status:'running'|'done'|'failed'|'canceled',
//              progress:{step,percent}, createdAt, updatedAt, resultRef, error, tokensUsed,
//              cancelRequested, partialResult, successSummary, failedUrls}

export const JOBS_KEY = 'jobs';
export const MAX_JOBS = 50;
export const HEARTBEAT_ALARM = 'atom:heartbeat';

export const JobStatus = {
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled'
};

export const JobType = {
  BATTLECARD: 'battlecard',
  MULTITAB: 'multitab',
  DEALROOM: 'dealroom'
};

export function createJob({ type, payload }) {
  return {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    payload: payload || {},
    status: JobStatus.RUNNING,
    progress: { step: 'Starting…', percent: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resultRef: null,
    error: null,
    tokensUsed: 0,
    cancelRequested: false,
    // failure UX extensions
    partialResult: null,
    successSummary: null,
    failedUrls: []
  };
}

export async function getJobs() {
  const data = await chrome.storage.local.get([JOBS_KEY]);
  const list = data[JOBS_KEY];
  return Array.isArray(list) ? list : [];
}

export async function saveJobs(jobs) {
  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  const capped = sorted.slice(0, MAX_JOBS); // FIFO cap 50 (newest first, drop oldest)
  await chrome.storage.local.set({ [JOBS_KEY]: capped });
  return capped;
}

export async function addJob(job) {
  const jobs = await getJobs();
  jobs.unshift(job);
  return saveJobs(jobs);
}

export async function updateJob(jobId, updates) {
  const jobs = await getJobs();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...updates, updatedAt: Date.now() };
  await saveJobs(jobs);
  return jobs[idx];
}

export async function getJob(jobId) {
  const jobs = await getJobs();
  return jobs.find(j => j.id === jobId) || null;
}

export async function requestCancel(jobId) {
  // cancellation = cancelRequested flag in storage
  return updateJob(jobId, { cancelRequested: true });
}

export async function isCancelRequested(jobId) {
  const job = await getJob(jobId);
  return !!job?.cancelRequested;
}

export function estimateTokens(text) {
  // rough: 1 token ≈ 4 chars
  const s = String(text || '');
  return Math.ceil(s.length / 4);
}

// helpers for progress
export async function setProgress(jobId, step, percent, extra = {}) {
  const patch = { progress: { step: String(step || ''), percent: Math.max(0, Math.min(100, Number(percent) || 0)) } };
  if (extra.tokensUsed != null) patch.tokensUsed = extra.tokensUsed;
  return updateJob(jobId, patch);
}
