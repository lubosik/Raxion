import { getRuntimeConfigValue } from './configService.js';

let activeCyclePromise = null;
let rerunRequested = false;
const activeJobs = new Map();
const queueState = {
  active: [],
  pending: [],
  last_started_at: null,
  last_finished_at: null,
  last_reason: null,
};

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getConcurrency() {
  return Math.max(1, Math.min(8, toNumber(getRuntimeConfigValue('RAXION_JOB_CONCURRENCY', 2), 2)));
}

function getJobTimeoutMs() {
  return Math.max(60_000, toNumber(getRuntimeConfigValue('RAXION_JOB_TIMEOUT_MS', 15 * 60 * 1000), 15 * 60 * 1000));
}

function trackPending(jobs) {
  queueState.pending = jobs.map((job) => ({
    job_id: job.id,
    job_title: job.job_title || job.name || 'Untitled Job',
    queued_at: nowIso(),
  }));
}

function removePending(jobId) {
  queueState.pending = queueState.pending.filter((job) => job.job_id !== jobId);
}

function startActive(job) {
  const item = {
    job_id: job.id,
    job_title: job.job_title || job.name || 'Untitled Job',
    started_at: nowIso(),
  };
  activeJobs.set(job.id, item);
  queueState.active = Array.from(activeJobs.values());
}

function finishActive(jobId) {
  activeJobs.delete(jobId);
  queueState.active = Array.from(activeJobs.values());
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function runQueuedJobs(jobs, worker) {
  const concurrency = getConcurrency();
  const timeoutMs = getJobTimeoutMs();
  const orderedJobs = [...jobs].sort((left, right) => new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime());
  trackPending(orderedJobs);

  let index = 0;
  let processed = 0;
  let skippedLocked = 0;

  async function runner() {
    while (index < orderedJobs.length) {
      const job = orderedJobs[index];
      index += 1;

      if (activeJobs.has(job.id)) {
        skippedLocked += 1;
        removePending(job.id);
        continue;
      }

      removePending(job.id);
      startActive(job);
      try {
        // eslint-disable-next-line no-await-in-loop
        await withTimeout(worker(job), timeoutMs, `Job ${job.id}`);
        processed += 1;
      } finally {
        finishActive(job.id);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, orderedJobs.length) }, () => runner()));
  return { processed, skippedLocked };
}

export async function runSerializedOrchestratorCycle(reason, cycleFn) {
  if (activeCyclePromise) {
    rerunRequested = true;
    return activeCyclePromise;
  }

  activeCyclePromise = (async () => {
    let finalResult = { processed: 0, skipped: false, rerunRequested: false };
    try {
      do {
        rerunRequested = false;
        queueState.last_started_at = nowIso();
        queueState.last_reason = reason;
        // eslint-disable-next-line no-await-in-loop
        finalResult = await cycleFn();
        finalResult.rerunRequested = rerunRequested;
      } while (rerunRequested);
      return finalResult;
    } finally {
      queueState.last_finished_at = nowIso();
      queueState.pending = [];
      queueState.active = Array.from(activeJobs.values());
      activeCyclePromise = null;
    }
  })();

  return activeCyclePromise;
}

export async function processJobsWithQueue(jobs, worker) {
  return runQueuedJobs(jobs, worker);
}

export function getExecutionQueueSnapshot() {
  return {
    running: Boolean(activeCyclePromise),
    rerun_requested: rerunRequested,
    concurrency: getConcurrency(),
    timeout_ms: getJobTimeoutMs(),
    ...queueState,
  };
}
