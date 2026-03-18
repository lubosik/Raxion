import supabase from '../db/supabase.js';
import { deleteCandidate as deleteZohoCandidate } from '../integrations/zohoRecruit.js';
import { logActivity } from './activityLogger.js';
import { prepareJobPayload } from './dbCompat.js';

const ANY_UUID = '00000000-0000-0000-0000-000000000000';

async function deleteRows(table, column, value, { optional = false } = {}) {
  const { error } = await supabase.from(table).delete().eq(column, value);
  if (error && !optional) throw error;
}

async function deleteAllRows(table, { optional = false } = {}) {
  const { error } = await supabase.from(table).delete().neq('id', ANY_UUID);
  if (error && !optional) throw error;
}

async function updateRows(table, payload, column, value, { optional = false } = {}) {
  const { error } = await supabase.from(table).update(payload).eq(column, value);
  if (error && !optional) throw error;
}

async function updateAllRows(table, payload, { optional = false, filter } = {}) {
  let query = supabase.from(table).update(payload);
  query = filter ? filter(query) : query.neq('id', ANY_UUID);
  const { error } = await query;
  if (error && !optional) throw error;
}

async function insertGdprLog({ candidateName = null, candidateEmail = null, linkedinUrl = null, reason, deletedBy = 'dashboard_user' }) {
  await supabase.from('gdpr_log').insert({
    candidate_name: candidateName,
    candidate_email: candidateEmail,
    linkedin_url: linkedinUrl,
    reason,
    deleted_by: deletedBy,
  });
}

function jobResetPayload() {
  return prepareJobPayload({
    last_research_at: null,
    applicant_fetch_cursor: null,
    status: 'ACTIVE',
    paused: false,
    paused_until: null,
    closed_at: null,
  });
}

export async function deleteCandidate(candidateId, reason = 'user_requested', deletedBy = 'dashboard_user') {
  const { data: candidate, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('id', candidateId)
    .single();

  if (error || !candidate) {
    throw new Error('Candidate not found');
  }

  if (candidate.zoho_candidate_id) {
    await deleteZohoCandidate(candidate.zoho_candidate_id).catch(() => null);
  }

  await deleteRows('conversations', 'candidate_id', candidateId);
  await deleteRows('approval_queue', 'candidate_id', candidateId);
  await updateRows('activity_log', {
    candidate_id: null,
    summary: '[DELETED] Candidate data removed per GDPR request',
    detail: {},
  }, 'candidate_id', candidateId);
  await deleteRows('candidates', 'id', candidateId);

  await insertGdprLog({
    candidateName: candidate.name || null,
    candidateEmail: candidate.email || null,
    linkedinUrl: candidate.linkedin_url || null,
    reason: `candidate_deleted:${reason}:candidate_id=${candidateId}:job_id=${candidate.job_id || 'unknown'}`,
    deletedBy,
  });

  await logActivity(candidate.job_id, null, 'GDPR_DELETE', `Deleted candidate ${candidate.name || candidateId}`, {
    candidate_id: candidateId,
    reason,
    deleted_by: deletedBy,
  });

  return {
    success: true,
    candidate_id: candidateId,
    candidate_name: candidate.name,
    deleted_at: new Date().toISOString(),
  };
}

export async function deleteCandidateData(candidateId, reason = 'GDPR deletion request', deletedBy = 'recruiter') {
  try {
    return await deleteCandidate(candidateId, reason, deletedBy);
  } catch {
    return { success: false };
  }
}

export async function deleteJob(jobId, reason = 'user_requested', deletedBy = 'dashboard_user') {
  const [{ data: job, error: jobError }, { data: candidates }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', jobId).single(),
    supabase.from('candidates').select('*').eq('job_id', jobId),
  ]);

  if (jobError || !job) {
    throw new Error('Job not found');
  }

  for (const candidate of candidates || []) {
    if (candidate.zoho_candidate_id) {
      // eslint-disable-next-line no-await-in-loop
      await deleteZohoCandidate(candidate.zoho_candidate_id).catch(() => null);
    }
    // eslint-disable-next-line no-await-in-loop
    await deleteRows('conversations', 'candidate_id', candidate.id);
    // eslint-disable-next-line no-await-in-loop
    await deleteRows('approval_queue', 'candidate_id', candidate.id);
    // eslint-disable-next-line no-await-in-loop
    await updateRows('activity_log', {
      candidate_id: null,
      summary: '[DELETED] Candidate data removed - job deleted',
      detail: {},
    }, 'candidate_id', candidate.id);
    // eslint-disable-next-line no-await-in-loop
    await insertGdprLog({
      candidateName: candidate.name || null,
      candidateEmail: candidate.email || null,
      linkedinUrl: candidate.linkedin_url || null,
      reason: `job_deleted_candidate_cleanup:${reason}:job_id=${jobId}:candidate_id=${candidate.id}`,
      deletedBy,
    });
  }

  await deleteRows('candidates', 'job_id', jobId);
  await deleteRows('approval_queue', 'job_id', jobId);
  await deleteRows('conversations', 'job_id', jobId);
  await deleteRows('job_assets', 'job_id', jobId, { optional: true });
  await deleteRows('daily_limits', 'job_id', jobId, { optional: true });
  await deleteRows('job_team_members', 'job_id', jobId, { optional: true });
  await deleteRows('jobs', 'id', jobId);

  await insertGdprLog({
    reason: `job_deleted:${reason}:job_id=${jobId}:job_title=${job.job_title || job.name || 'unknown'}`,
    deletedBy,
  });

  return {
    success: true,
    job_id: jobId,
    deleted_candidates: candidates?.length || 0,
    job_title: job.job_title || job.name || null,
  };
}

export async function clearEntirePipeline(reason = 'user_requested_full_pipeline_clear', deletedBy = 'dashboard_user') {
  const { data: candidates } = await supabase.from('candidates').select('id');
  const count = candidates?.length || 0;

  await deleteAllRows('conversations');
  await deleteAllRows('approval_queue');
  await updateAllRows('activity_log', {
    candidate_id: null,
    summary: '[DELETED] Cleared in pipeline reset',
    detail: {},
  }, {
    filter: (query) => query.not('candidate_id', 'is', null),
  });
  await deleteAllRows('candidates');

  const payload = await jobResetPayload();
  if (Object.keys(payload).length) {
    await updateAllRows('jobs', payload, { filter: (query) => query.neq('id', ANY_UUID) });
  }

  await insertGdprLog({
    reason: `pipeline_cleared:${reason}:count=${count}`,
    deletedBy,
  });

  return count;
}

export async function nuclearReset(reason = 'user_requested_full_system_reset', deletedBy = 'dashboard_user') {
  await deleteAllRows('conversations');
  await deleteAllRows('approval_queue');
  await deleteAllRows('job_assets', { optional: true });
  await deleteAllRows('daily_limits', { optional: true });
  await deleteAllRows('job_team_members', { optional: true });
  await deleteAllRows('webhook_logs', { optional: true });
  await deleteAllRows('activity_log');
  await deleteAllRows('candidates');
  await deleteAllRows('jobs');
  await deleteAllRows('gdpr_log');

  await insertGdprLog({
    reason: `nuclear_reset:${reason}`,
    deletedBy,
  });

  return { success: true };
}
