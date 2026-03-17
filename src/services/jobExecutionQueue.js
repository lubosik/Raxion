import os from 'node:os';
import crypto from 'node:crypto';
import supabase from '../db/supabase.js';
import { getRuntimeConfigValue } from './configService.js';

let activeCyclePromise = null;
let rerunRequested = false;
let distributedPumpPromise = null;
let distributedQueueSupported;
const activeJobs = new Map();
const queueState = {
  active: [],
  pending: [],
  last_started_at: null,
  last_finished_at: null,
  last_reason: null,
};
const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

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

function getRetryDelaySeconds(attempts = 1) {
  return Math.min(1800, Math.max(30, attempts * 60));
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

async function rpc(name, params = {}) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw error;
  return data;
}

export async function supportsDistributedExecutionQueue() {
  if (typeof distributedQueueSupported === 'boolean') return distributedQueueSupported;
  const { error } = await supabase.from('job_execution_queue').select('id').limit(1);
  distributedQueueSupported = !error;
  return distributedQueueSupported;
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

export async function enqueueJobsForExecution(jobs, reason = 'scheduled', priority = 100) {
  if (!await supportsDistributedExecutionQueue()) return { enqueued: 0, skipped: true };

  let enqueued = 0;
  for (const job of jobs || []) {
    // eslint-disable-next-line no-await-in-loop
    const result = await rpc('enqueue_job_execution', {
      p_job_id: job.id,
      p_queue_type: 'job_cycle',
      p_reason: reason,
      p_priority: priority,
      p_payload: { job_title: job.job_title || job.name || 'Untitled Job', reason },
    }).catch(() => null);
    if (result) enqueued += 1;
  }

  return { enqueued };
}

async function claimDistributedJobs(limit) {
  const staleSeconds = Math.ceil((getJobTimeoutMs() + 120_000) / 1000);
  return rpc('claim_job_execution_batch', {
    p_worker_id: workerId,
    p_queue_type: 'job_cycle',
    p_limit: limit,
    p_stale_seconds: staleSeconds,
  }).then((rows) => rows || []);
}

async function completeDistributedJob(queueId) {
  return rpc('complete_job_execution', {
    p_queue_id: queueId,
    p_worker_id: workerId,
  }).catch(() => false);
}

async function failDistributedJob(queueId, attempts, errorMessage) {
  return rpc('fail_job_execution', {
    p_queue_id: queueId,
    p_worker_id: workerId,
    p_error_message: errorMessage,
    p_retry_delay_seconds: getRetryDelaySeconds(attempts),
  }).catch(() => false);
}

export async function processDistributedJobQueue(worker) {
  if (!await supportsDistributedExecutionQueue()) {
    return { processed: 0, skipped: true };
  }

  if (distributedPumpPromise) {
    return distributedPumpPromise;
  }

  distributedPumpPromise = (async () => {
    const claimedJobs = await claimDistributedJobs(getConcurrency());
    if (!claimedJobs.length) {
      return { processed: 0, claimed: 0 };
    }

    let processed = 0;
    await Promise.all(claimedJobs.map(async (queueItem) => {
      startActive({
        id: queueItem.job_id,
        job_title: queueItem.payload?.job_title || `Job ${queueItem.job_id}`,
      });
      try {
        await withTimeout(worker(queueItem), getJobTimeoutMs(), `Queue item ${queueItem.id}`);
        await completeDistributedJob(queueItem.id);
        processed += 1;
      } catch (error) {
        await failDistributedJob(queueItem.id, queueItem.attempts || 1, error.message);
      } finally {
        finishActive(queueItem.job_id);
      }
    }));

    return { processed, claimed: claimedJobs.length };
  })();

  try {
    return await distributedPumpPromise;
  } finally {
    distributedPumpPromise = null;
  }
}

export async function getExecutionQueueSnapshot() {
  if (!await supportsDistributedExecutionQueue()) {
    return {
      source: 'local',
      running: Boolean(activeCyclePromise),
      rerun_requested: rerunRequested,
      concurrency: getConcurrency(),
      timeout_ms: getJobTimeoutMs(),
      ...queueState,
    };
  }

  const [{ data: active }, { data: pending }] = await Promise.all([
    supabase
      .from('job_execution_queue')
      .select('id,job_id,claimed_at,payload')
      .eq('queue_type', 'job_cycle')
      .eq('status', 'claimed')
      .order('claimed_at', { ascending: true })
      .limit(20),
    supabase
      .from('job_execution_queue')
      .select('id,job_id,created_at,payload')
      .eq('queue_type', 'job_cycle')
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(20),
  ]);

  return {
    source: 'distributed',
    running: Boolean(distributedPumpPromise),
    rerun_requested: false,
    concurrency: getConcurrency(),
    timeout_ms: getJobTimeoutMs(),
    active: (active || []).map((item) => ({
      queue_id: item.id,
      job_id: item.job_id,
      job_title: item.payload?.job_title || `Job ${item.job_id}`,
      started_at: item.claimed_at,
    })),
    pending: (pending || []).map((item) => ({
      queue_id: item.id,
      job_id: item.job_id,
      job_title: item.payload?.job_title || `Job ${item.job_id}`,
      queued_at: item.created_at,
    })),
    last_started_at: null,
    last_finished_at: null,
    last_reason: null,
    worker_id: workerId,
  };
}
